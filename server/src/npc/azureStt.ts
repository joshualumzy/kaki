import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Recognizer, SttSession } from './utterance';

export interface AzureSttOptions {
  /** Recognition language, for example "en-SG". */
  locale: string;
  /** Names and words likely to come up; Azure leans towards them when it is unsure. */
  phrases: string[];
  /** How long to wait for the result once the audio has ended. */
  finishTimeoutMs?: number;
}

/**
 * Azure speech-to-text for one stretch of speech at a time, fed 16 kHz 16-bit mono samples. Each
 * stretch gets its own recognizer, so a silence between stretches is never sent to Azure.
 */
export function createAzureStt(key: string, region: string, options: AzureSttOptions): Recognizer {
  const config = sdk.SpeechConfig.fromSubscription(key, region);
  config.speechRecognitionLanguage = options.locale;
  const finishTimeoutMs = options.finishTimeoutMs ?? 6000;

  return {
    start(): SttSession {
      const stream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
      const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(stream));
      if (options.phrases.length > 0) sdk.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(options.phrases);

      const parts: string[] = [];
      let stopped: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => (stopped = resolve));
      let failure: string | undefined;
      let closed = false;

      recognizer.recognized = (_sender, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text.length > 0) {
          parts.push(event.result.text);
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

      const dispose = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => recognizer.stopContinuousRecognitionAsync(() => resolve(), () => resolve()));
        recognizer.close();
      };

      return {
        push(samples) {
          if (closed) return;
          stream.write(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer);
        },
        async finish() {
          await started;
          stream.close();
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, finishTimeoutMs));
          await Promise.race([ended, timeout]);
          await dispose();
          if (failure !== undefined && parts.length === 0) throw new Error(failure);
          return parts.join(' ');
        },
        cancel() {
          stream.close();
          void dispose();
        },
      };
    },
  };
}
