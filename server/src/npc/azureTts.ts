import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Utterance } from './director';

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
    const voice = voiceFor(utterance.speaker);
    if (voice === undefined) return Promise.reject(new Error(`No voice for ${utterance.speaker}`));
    if (signal.aborted) return Promise.reject(new Error('aborted'));

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

      synthesizer.speakTextAsync(
        utterance.text,
        (result) =>
          finish(() => {
            if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
              reject(new Error(`speech synthesis failed: ${result.errorDetails || sdk.ResultReason[result.reason]}`));
              return;
            }
            const bytes = result.audioData;
            resolve(new Int16Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2))));
          }),
        (error) => finish(() => reject(new Error(`speech synthesis failed: ${error}`))),
      );
    });
  };
}
