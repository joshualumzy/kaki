import { AudioFrame, type AudioSource } from '@livekit/rtc-node';
import { rmsLevel } from './vad';

const FRAME_MS = 20;

/** The slice of a LiveKit audio source playback needs; lets tests use a fake. */
export type PcmSink = Pick<AudioSource, 'captureFrame' | 'waitForPlayout' | 'clearQueue'> &
  Partial<Pick<AudioSource, 'queuedDuration'>>;

/** Told how loud each frame of AI audio is, and when it will be audible. */
export interface PlaybackRecorder {
  record(level: number, playoutInMs: number): void;
}

/**
 * Play 16-bit mono samples into a LiveKit audio source. `captureFrame` waits when the source's
 * own buffer is full, so the audio is never far ahead of what people hear. When `signal` aborts
 * the buffer is emptied at once and the promise resolves: this is what makes interruption instant.
 */
export async function playPcm(
  sink: PcmSink,
  pcm: Int16Array,
  sampleRate: number,
  signal: AbortSignal,
  recorder?: PlaybackRecorder,
): Promise<void> {
  if (signal.aborted) return;
  const samplesPerFrame = Math.round((sampleRate * FRAME_MS) / 1000);

  let onAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => {
      sink.clearQueue();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    for (let offset = 0; offset < pcm.length; offset += samplesPerFrame) {
      if (signal.aborted) return;
      const data = new Int16Array(samplesPerFrame); // zero-padded, so the last frame is full length
      data.set(pcm.subarray(offset, offset + samplesPerFrame));
      recorder?.record(rmsLevel(data), sink.queuedDuration ?? 0);
      await Promise.race([sink.captureFrame(new AudioFrame(data, sampleRate, 1, samplesPerFrame)), aborted]);
    }
    if (!signal.aborted) await Promise.race([sink.waitForPlayout(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) sink.clearQueue();
  }
}
