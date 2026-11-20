import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { confidenceFrom, DEFAULT_MIN_CONFIDENCE, keepRecognised } from './sttFilter';
import { MAX_STT_PHRASES, tidySttPhrases } from './sttPhrases';
import type { Recognizer, SttSession } from './utterance';

interface AzureSttOptions {
  /** Recognition language, for example "en-SG". */
  locale: string;
  /** Names and words likely to come up; Azure leans towards them when it is unsure. Read on every start. */
  phrases: () => string[];
  /** How long to wait for the result once the audio has ended. */
  finishTimeoutMs?: number;
  /** Short results scoring below this are treated as noise and dropped (default 0.6). */
  minConfidence?: number;
  log?(message: string): void;
}

/**
 * Azure speech-to-text for one stretch of speech at a time, fed 16 kHz 16-bit mono samples. Each
 * stretch gets its own recognizer, so a silence between stretches is never sent to Azure.
 */
export function createAzureStt(key: string, region: string, options: AzureSttOptions): Recognizer {
  const config = sdk.SpeechConfig.fromSubscription(key, region);
  config.speechRecognitionLanguage = options.locale;
  config.outputFormat = sdk.OutputFormat.Detailed;
  const finishTimeoutMs = options.finishTimeoutMs ?? 6000;
  let warnedCapped = false;

  return {
    start(): SttSession {
      const stream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
      const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(stream));
      const allPhrases = tidySttPhrases(options.phrases());
      if (allPhrases.length > MAX_STT_PHRASES && !warnedCapped) {
        warnedCapped = true;
        options.log?.(`speech recognition phrase list capped at ${MAX_STT_PHRASES} entries`);
      }
      const phrases = allPhrases.slice(0, MAX_STT_PHRASES);
      if (phrases.length > 0) sdk.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(phrases);

      const parts: string[] = [];
      let stopped: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => (stopped = resolve));
      let failure: string | undefined;
      let closed = false;
      let streamClosed = false;

      const closeStream = (): void => {
        if (streamClosed) return;
        streamClosed = true;
        stream.close();
      };

      recognizer.recognized = (_sender, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text.length > 0) {
          const confidence = confidenceFrom(event.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult));
          if (keepRecognised(event.result.text, confidence, options.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) {
            parts.push(event.result.text);
          } else {
            options.log?.(`dropped "${event.result.text}" as noise (confidence ${confidence?.toFixed(2)})`);
          }
        }
      };
      recognizer.sessionStopped = () => stopped();
      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.Error) failure = event.errorDetails;
        stopped();
      };
      const started = new Promise<void>((resolve) => {
        recognizer.startContinuousRecognitionAsync(
          () => resolve(),
          (error) => {
            failure = String(error);
            stopped();
            resolve();
          },
        );
      });

      const dispose = async (timeoutMs: number): Promise<void> => {
        if (closed) return;
        closed = true;
        const stopping = new Promise<void>((resolve) =>
          recognizer.stopContinuousRecognitionAsync(() => resolve(), () => resolve()),
        );
        if (timeoutMs > 0) {
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
          await Promise.race([stopping, timeout]);
        }
        recognizer.close();
      };

      return {
        push(samples) {
          if (closed) return;
          stream.write(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer);
        },
        async finish() {
          // One deadline covers the whole start, recognition and stop lifecycle. A recogniser whose
          // callback never arrives must fail loudly and be closed, not hang the utterance queue.
          const deadline = Date.now() + finishTimeoutMs;
          const remaining = (): number => Math.max(0, deadline - Date.now());
          const withinDeadline = <T>(promise: Promise<T>, message: string): Promise<T> => {
            const timeoutMs = remaining();
            if (timeoutMs === 0) return Promise.reject(new Error(message));
            return new Promise<T>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
              promise.then(
                (value) => {
                  clearTimeout(timer);
                  resolve(value);
                },
                (error: unknown) => {
                  clearTimeout(timer);
                  reject(error instanceof Error ? error : new Error(String(error)));
                },
              );
            });
          };

          try {
            await withinDeadline(started, 'Speech recognition did not start in time.');
            if (failure !== undefined) throw new Error(failure);
            closeStream();
            await withinDeadline(ended, 'Speech recognition did not finish in time.');
            if (failure !== undefined) throw new Error(failure);
            return parts.join(' ');
          } finally {
            closeStream();
            await dispose(remaining());
          }
        },
        cancel() {
          closeStream();
          void dispose(finishTimeoutMs);
        },
      };
    },
  };
}
