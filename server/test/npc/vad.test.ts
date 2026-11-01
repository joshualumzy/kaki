import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnergyVad } from '../../src/npc/vad';

const RATE = 16000;
const FRAME = 160; // 10 ms

/** A 10 ms frame of a 220 Hz tone with the given peak amplitude (RMS is about 0.7 of it). */
function tone(amplitude: number, offset = 0): Int16Array {
  const frame = new Int16Array(FRAME);
  for (let index = 0; index < FRAME; index += 1) {
    frame[index] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * (offset + index)) / RATE));
  }
  return frame;
}

const SPEECH = 8000; // RMS about 0.17: normal speech into a laptop microphone
const LEAK = 1000; // RMS about 0.02: playback leaking through echo cancellation
const ROOM = 100; // RMS about 0.002: a quiet room

describe('EnergyVad', () => {
  let changes: boolean[];
  let vad: EnergyVad;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    vad = new EnergyVad((speaking) => changes.push(speaking));
  });
  afterEach(() => {
    vad.close();
    vi.useRealTimers();
  });

  /** Push `ms` of audio, one 10 ms frame at a time. */
  function feed(amplitude: number, ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) vad.push(tone(amplitude, elapsed * 16), RATE);
  }

  it('stays quiet in a silent room', () => {
    feed(ROOM, 3000);
    expect(changes).toEqual([]);
  });

  it('reports speech after a short burst of loud audio, and its end after a pause', () => {
    feed(ROOM, 500);
    feed(SPEECH, 130);
    expect(changes).toEqual([true]);
    feed(SPEECH, 500);
    feed(ROOM, 400);
    expect(changes).toEqual([true]);
    feed(ROOM, 200);
    expect(changes).toEqual([true, false]);
  });

  it('ignores a click, and short gaps between words do not end speech', () => {
    feed(SPEECH, 40);
    feed(ROOM, 300);
    expect(changes).toEqual([]);

    feed(SPEECH, 300);
    feed(ROOM, 300);
    feed(SPEECH, 300);
    expect(changes).toEqual([true]);
  });

  it('ends speech when the audio stops arriving altogether, as with Opus silence suppression', () => {
    feed(SPEECH, 300);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(499);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(2);
    expect(changes).toEqual([true, false]);
  });

  it('when guarded, ignores leaked playback but still hears a person talking over it', () => {
    vad.guarded = true;
    feed(LEAK, 2000);
    expect(changes).toEqual([]);

    feed(SPEECH, 200);
    expect(changes).toEqual([]);
    feed(SPEECH, 100);
    expect(changes).toEqual([true]);
  });

  it('is easier to trigger when not guarded: the same leak counts as speech', () => {
    feed(LEAK, 300);
    expect(changes).toEqual([true]);
  });

  it('raises its bar in a noisy room instead of firing on the noise', () => {
    const before = vad.threshold;
    feed(400, 4000);
    expect(vad.threshold).toBeGreaterThan(before);
    expect(changes).toEqual([]);
    feed(SPEECH, 200);
    expect(changes).toEqual([true]);
  });

  it('close() ends speech in progress', () => {
    feed(SPEECH, 300);
    vad.close();
    expect(changes).toEqual([true, false]);
  });
});
