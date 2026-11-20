import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Utterance } from './director';

/** A voice spec is a voice name with optional `?pitch=..&rate=..&lang=..`; `lang` is the language the text is in. */
export interface VoiceSpec { voice: string; pitch?: string; rate?: string; lang?: string }

const VOICE_SPEC_PARAMS = new Set(['pitch', 'rate', 'lang']);

export function parseVoiceSpec(spec: string): VoiceSpec {
  const [voice, query] = spec.split('?', 2);
  if (query === undefined) return { voice: spec };
  const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
  for (const name of params.keys()) {
    if (!VOICE_SPEC_PARAMS.has(name)) throw new Error(`voice "${spec}": unknown setting "${name}" (allowed: pitch, rate, lang)`);
  }
  const pitch = params.get('pitch') ?? undefined;
  const rate = params.get('rate') ?? undefined;
  const lang = params.get('lang') ?? undefined;
  return {
    voice: voice || spec,
    ...(pitch === undefined ? {} : { pitch }),
    ...(rate === undefined ? {} : { rate }),
    ...(lang === undefined ? {} : { lang }),
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

/**
 * SSML for one line. A multilingual voice reading another language (`lang`, e.g. a Chinese voice reading English)
 * is told so explicitly; otherwise it reads with its home language's rhythm and pauses in odd places.
 */
export function buildSsml(spec: VoiceSpec, text: string): string {
  const { voice, pitch, rate, lang } = spec;
  const locale = lang ?? (voice.split('-').slice(0, 2).join('-') || 'en-SG');
  const attrs = [
    ...(pitch === undefined ? [] : [`pitch='${escapeXml(pitch)}'`]),
    ...(rate === undefined ? [] : [`rate='${escapeXml(rate)}'`]),
  ].join(' ');
  const escapedWithPauses = escapeXml(text).replace(/\s+[-–—]+\s+/g, " <break time='280ms'/> ");
  const prosody = attrs.length > 0 ? `<prosody ${attrs}>${escapedWithPauses}</prosody>` : escapedWithPauses;
  const body = lang === undefined ? prosody : `<lang xml:lang='${escapeXml(lang)}'>${prosody}</lang>`;
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
    const spec = parseVoiceSpec(rawVoice);
    const { voice } = spec;
    const useSsml =
      spec.pitch !== undefined || spec.rate !== undefined || spec.lang !== undefined || /\s+[-–—]+\s+/.test(utterance.text);

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
        synthesizer.speakSsmlAsync(buildSsml(spec, utterance.text), onResult, onError);
      } else {
        synthesizer.speakTextAsync(utterance.text, onResult, onError);
      }
    });
  };
}
