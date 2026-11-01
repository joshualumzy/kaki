import { describe, expect, it } from 'vitest';
import { playPcm, type PcmSink } from '../../src/npc/playback';

function fakeSink(options: { captureDelayMs?: number } = {}) {
  const frames: number[] = [];
  let cleared = 0;
  let playoutWaits = 0;
  const sink: PcmSink = {
    captureFrame: async (frame) => {
      frames.push(frame.samplesPerChannel);
      if (options.captureDelayMs) await new Promise((resolve) => setTimeout(resolve, options.captureDelayMs));
    },
    waitForPlayout: async () => void (playoutWaits += 1),
    clearQueue: () => void (cleared += 1),
  };
  return { sink, frames, cleared: () => cleared, playoutWaits: () => playoutWaits };
}

describe('playPcm', () => {
  it('pushes the whole clip in equal 20 ms frames, padding the last, then waits for playout', async () => {
    const { sink, frames, cleared, playoutWaits } = fakeSink();
    // 700 samples at 16 kHz = 43.75 ms: two full 320-sample frames and a padded third.
    await playPcm(sink, new Int16Array(700).fill(5), 16000, new AbortController().signal);
    expect(frames).toEqual([320, 320, 320]);
    expect(playoutWaits()).toBe(1);
    expect(cleared()).toBe(0);
  });

  it('does nothing for a signal that is already aborted', async () => {
    const { sink, frames } = fakeSink();
    const controller = new AbortController();
    controller.abort();
    await playPcm(sink, new Int16Array(1000), 16000, controller.signal);
    expect(frames).toEqual([]);
  });

  it('empties the buffer and returns promptly when aborted part-way, even mid-frame', async () => {
    const { sink, frames, cleared, playoutWaits } = fakeSink({ captureDelayMs: 50 });
    const controller = new AbortController();
    const playing = playPcm(sink, new Int16Array(16000 * 5), 16000, controller.signal); // a 5 s clip
    await new Promise((resolve) => setTimeout(resolve, 120));
    const abortedAt = Date.now();
    controller.abort();
    await playing;
    expect(Date.now() - abortedAt).toBeLessThan(40);
    expect(cleared()).toBeGreaterThan(0);
    expect(playoutWaits()).toBe(0);
    expect(frames.length).toBeLessThan(10);
  });

  it('empties the buffer when aborted while waiting for the audio to finish', async () => {
    const { cleared } = fakeSink();
    const controller = new AbortController();
    let release: () => void = () => undefined;
    let clears = 0;
    const sink: PcmSink = {
      captureFrame: async () => undefined,
      waitForPlayout: () => new Promise<void>((resolve) => (release = resolve)),
      clearQueue: () => void (clears += 1),
    };
    const playing = playPcm(sink, new Int16Array(320), 16000, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await playing;
    release();
    expect(clears).toBeGreaterThan(0);
    expect(cleared()).toBe(0);
  });
});
