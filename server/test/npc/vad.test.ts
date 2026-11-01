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
const LEAK = 800; // RMS about 0.017: playback leaking through echo cancellation
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

    feed(SPEECH, 150);
    expect(changes).toEqual([]);
    feed(SPEECH, 100);
    expect(changes).toEqual([true]);
  });

  it('is easier to trigger when not guarded: the same level counts as speech in a quiet room', () => {
    feed(ROOM, 1500); // learn that the room is quiet
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

  it('reports the loudest recent level and the bar, to explain a phrase that was refused', () => {
    feed(ROOM, 300);
    feed(400, 100);
    expect(vad.peak(5000)).toBeGreaterThan(0.007);
    expect(vad.peak(5000)).toBeLessThan(0.012);
    expect(vad.threshold).toBeGreaterThanOrEqual(0.015);
  });
});

describe('EnergyVad with a playback reference', () => {
  let changes: boolean[];
  let time: number;
  let aiLevel: number;
  let vad: EnergyVad;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    time = 1_000_000;
    aiLevel = 0.15; // the AI is talking loudly
    vad = new EnergyVad((speaking) => changes.push(speaking), {}, { reference: { levelAt: () => aiLevel }, now: () => time });
    vad.guarded = true;
  });
  afterEach(() => {
    vad.close();
    vi.useRealTimers();
  });

  /** Push 10 ms frames of a tone, advancing the clock. */
  function feed(amplitude: number, ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      vad.push(tone(amplitude, elapsed * 16), RATE);
      time += 10;
    }
  }

  it('learns how much of the AI the microphone hears, and ignores it however loud the speakers are', () => {
    // 3000 is about 0.065 RMS: loud speakers, well above the fixed guarded level.
    feed(3000, 3000);
    expect(changes).toEqual([]);
    expect(vad.leakRatio).toBeGreaterThan(0.3);
    expect(vad.leakRatio).toBeLessThan(0.6);
  });

  it('hears a person who is clearly louder than the leak, and stops them being cut off by their own echo', () => {
    feed(3000, 2000); // leak only
    feed(9000, 100);
    expect(changes).toEqual([]);
    feed(9000, 200);
    expect(changes).toEqual([true]);
  });

  it('hears a quiet person when the speakers are quiet: the bar follows the speakers, not a fixed level', () => {
    const fixedBarChanges: boolean[] = [];
    const fixedBar = new EnergyVad((speaking) => fixedBarChanges.push(speaking), {}, { now: () => time });
    const both = (amplitude: number, ms: number): void => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        const frame = tone(amplitude, elapsed * 16);
        vad.push(frame, RATE);
        fixedBar.push(frame, RATE);
        time += 10;
      }
    };

    vad.guarded = fixedBar.guarded = false;
    both(40, 1500); // a quiet room, so both learn a low noise floor
    vad.guarded = fixedBar.guarded = true;
    aiLevel = 0.1;
    both(150, 2000); // the AI talks; only a tiny leak (about 3%) reaches the microphone
    both(780, 400); // a quiet voice: about 0.017 RMS

    expect(changes).toEqual([true]); // with a reference the bar is just above the leak
    expect(fixedBarChanges).toEqual([]); // the fixed bar for "AI talking" (0.02) misses it
    fixedBar.close();
  });

  it('does not learn that there is no leak from the quiet gap before the echo arrives', () => {
    // The AI starts; the microphone only carries room noise until its echo comes back, a moment later.
    const reference = {
      levelAt: () => aiLevel,
      steadyLevelAt: () => 0, // the AI has not been audible for the whole delay window yet
    };
    const delayed = new EnergyVad((speaking) => changes.push(speaking), {}, { reference, now: () => time });
    delayed.guarded = true;
    for (let elapsed = 0; elapsed < 600; elapsed += 10) {
      delayed.push(tone(40, elapsed * 16), RATE);
      time += 10;
    }
    expect(delayed.leakRatio).toBe(0.35); // still the cautious starting guess, not zero
    for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
      delayed.push(tone(3000, elapsed * 16), RATE); // the echo arrives
      time += 10;
    }
    expect(changes).toEqual([]);
    delayed.close();
  });

  it('adapts when the leak grows between turns, instead of staying sure there is none', () => {
    feed(40, 1500); // an earlier turn with a silent microphone: nothing leaks, so the estimate drops to about zero
    expect(vad.leakRatio).toBeLessThan(0.05);

    vad.guarded = false;
    vad.guarded = true; // the next turn; meanwhile the person turned the speakers up
    feed(3000, 3000);
    expect(changes).toEqual([]); // its own echo does not cut it off
    expect(vad.leakRatio).toBeGreaterThan(0.3);
    feed(9000, 300); // and a person talking over it is still heard
    expect(changes).toEqual([true]);
  });

  it('is easy to trigger again once the AI has stopped', () => {
    feed(3000, 2000);
    vad.guarded = false;
    aiLevel = 0;
    feed(2500, 300);
    expect(changes).toEqual([true]);
  });
});
