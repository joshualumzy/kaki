import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Utterance } from './director';

function parseVoiceSpec(spec: string): { voice: string; pitch?: string; rate?: string } {
  const [voice, query] = spec.split('?', 2);
  if (query === undefined) return { voice: spec };
  const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
  const pitch = params.get('pitch') ?? undefined;
  const rate = params.get('rate') ?? undefined;
  return {
    voice: voice || spec,
    ...(pitch === undefined ? {} : { pitch }),
    ...(rate === undefined ? {} : { rate }),
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(voice: string, text: string, pitch?: string, rate?: string): string {
  const locale = voice.split('-').slice(0, 2).join('-') || 'en-SG';
  const attrs = [
    ...(pitch === undefined ? [] : [`pitch='${escapeXml(pitch)}'`]),
    ...(rate === undefined ? [] : [`rate='${escapeXml(rate)}'`]),
  ].join(' ');
  const escapedWithPauses = escapeXml(text).replace(/\s+[-–—]+\s+/g, " <break time='280ms'/> ");
  const body = attrs.length > 0 ? `<prosody ${attrs}>${escapedWithPauses}</prosody>` : escapedWithPauses;
  return `<speak version='1.0' xml:lang='${escapeXml(locale)}'><voice name='${escapeXml(voice)}'>${body}</voice></speak>`;
}

/** Azure text-to-speech returning raw 16 kHz mono samples, one voice per speaker. */
export function createAzureTts(key: string, region: string, voiceFor: (speaker: string) => string | undefined) {
  const configs = new Map<string, sdk.SpeechConfig>();

  function configFor(voice: string): sdk.SpeechConfig {
    let config = configs.get(voice);
    if (config === undefined) {
      config = sdk.SpeechConfig.fromSubscription(key, region);
      config.speechSynthesisVoiceName = voice;
      config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
      configs.set(voice, config);
    }
    return config;
  }

  return function synthesize(utterance: Utterance, signal: AbortSignal): Promise<Int16Array> {
    const rawVoice = voiceFor(utterance.speaker);
    if (rawVoice === undefined) return Promise.reject(new Error(`No voice for ${utterance.speaker}`));
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const { voice, pitch, rate } = parseVoiceSpec(rawVoice);
    const useSsml = pitch !== undefined || rate !== undefined || /\s+[-–—]+\s+/.test(utterance.text);

    return new Promise<Int16Array>((resolve, reject) => {
      // No audio config: the audio comes back in the result instead of going to a speaker.
      const synthesizer = new sdk.SpeechSynthesizer(configFor(voice), null as unknown as sdk.AudioConfig);
      let finished = false;

      const finish = (outcome: () => void): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        try {
          synthesizer.close();
        } catch {
          // closing a synthesizer that is mid-request can throw; the request is abandoned either way
        }
        outcome();
      };
      const onAbort = (): void => finish(() => reject(new Error('aborted')));
      signal.addEventListener('abort', onAbort, { once: true });

      const onResult = (result: sdk.SpeechSynthesisResult): void =>
        finish(() => {
          if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
            reject(new Error(`speech synthesis failed: ${result.errorDetails || sdk.ResultReason[result.reason]}`));
            return;
          }
          const bytes = result.audioData;
          resolve(new Int16Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2))));
        });
      const onError = (error: string): void => finish(() => reject(new Error(`speech synthesis failed: ${error}`)));

      if (useSsml) {
        synthesizer.speakSsmlAsync(buildSsml(voice, utterance.text, pitch, rate), onResult, onError);
      } else {
        synthesizer.speakTextAsync(utterance.text, onResult, onError);
      }
    });
  };
}
