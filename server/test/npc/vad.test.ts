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

  it('ends speech when a steady hum under the bar follows it, instead of holding the floor with no words', () => {
    // The live case: the bar was 0.020, so quiet meant under 0.010, and a room hum of about 0.011 never counted as quiet.
    vad.close();
    vad = new EnergyVad((speaking) => changes.push(speaking), { hangoverMs: 1500 });
    const HUM = 510; // RMS about 0.011: between half the bar and the bar
    feed(ROOM, 500);
    feed(SPEECH, 1000);
    expect(changes).toEqual([true]);
    feed(HUM, 2900);
    expect(changes).toEqual([true]);
    feed(HUM, 200);
    expect(changes).toEqual([true, false]);
  });

  it('keeps a 1.5 s pause over the same hum inside one stretch of speech', () => {
    vad.close();
    vad = new EnergyVad((speaking) => changes.push(speaking), { hangoverMs: 1500 });
    const HUM = 510;
    feed(ROOM, 500);
    feed(SPEECH, 600);
    feed(HUM, 1500);
    feed(SPEECH, 600);
    expect(changes).toEqual([true]);
  });

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

    feed(SPEECH, 100);
    expect(changes).toEqual([]);
    feed(SPEECH, 50);
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

  it('measures how loud the AI is in the microphone, and ignores it', () => {
    // 2000 is about 0.043 RMS: fairly loud speakers, well above the fixed guarded level.
    feed(2000, 3000);
    expect(changes).toEqual([]);
    expect(vad.leakLevel).toBeGreaterThan(0.03);
    expect(vad.leakLevel).toBeLessThan(0.06);
  });

  it('hears a person who is clearly louder than the echo, and stops them being cut off by their own echo', () => {
    feed(2000, 2000); // echo only
    feed(9000, 100);
    expect(changes).toEqual([]);
    feed(9000, 200);
    expect(changes).toEqual([true]);
  });

  it('does not count a person talking over the AI as echo, so the bar does not rise with their voice', () => {
    feed(2000, 2000);
    const before = vad.leakLevel;
    feed(9000, 100); // the start of a person's speech, before it is declared
    expect(vad.leakLevel).toBe(before);
  });

  it('sets the bar from the speakers: a voice that gets through quiet speakers is lost over loud ones', () => {
    const hears = (echoAmplitude: number, voiceAmplitude: number): boolean => {
      const result: boolean[] = [];
      const own = new EnergyVad((speaking) => result.push(speaking), {}, { reference: { levelAt: () => aiLevel }, now: () => time });
      own.guarded = true;
      for (let elapsed = 0; elapsed < 2000; elapsed += 10) {
        own.push(tone(echoAmplitude, elapsed * 16), RATE);
        time += 10;
      }
      for (let elapsed = 0; elapsed < 400; elapsed += 10) {
        own.push(tone(voiceAmplitude, elapsed * 16), RATE);
        time += 10;
      }
      own.close();
      return result.includes(true);
    };
    // A voice of about 0.05 RMS (amplitude 2900).
    expect(hears(150, 2900)).toBe(true); // quiet speakers: the echo is tiny, so the bar is low
    expect(hears(2000, 2900)).toBe(false); // loud speakers: the echo is about 0.043, so the bar is about 0.09
  });

  it('is cautious about the echo until it has measured it, but never deaf to a normal voice', () => {
    const fresh = new EnergyVad((speaking) => changes.push(speaking), {}, { reference: { levelAt: () => aiLevel }, now: () => time });
    fresh.guarded = true;
    expect(fresh.leakLevel).toBe(0.04);
    for (let elapsed = 0; elapsed < 100; elapsed += 10) {
      fresh.push(tone(2000, elapsed * 16), RATE); // echo from the first moments
      time += 10;
    }
    expect(changes).toEqual([]);
    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      fresh.push(tone(9000, elapsed * 16), RATE);
      time += 10;
    }
    expect(changes).toEqual([true]);
    fresh.close();
  });

  it('keeps what it measured between stretches of the AI talking', () => {
    feed(2000, 2000);
    const measured = vad.leakLevel;
    vad.guarded = false;
    vad.guarded = true;
    expect(vad.leakLevel).toBe(measured);
  });

  it('never takes the echo to be quieter than a floor, so a first quiet measurement cannot make the AI cut itself off', () => {
    feed(40, 2000); // a silent microphone while the AI plays
    expect(vad.leakLevel).toBe(0.02);
    expect(vad.threshold).toBeGreaterThanOrEqual(0.04);
  });

  it('does not measure the echo in the first moments of a sentence, before it can have come back', () => {
    const reference = { levelAt: () => aiLevel, settledLevelAt: () => 0 }; // the AI only just started
    const early = new EnergyVad((speaking) => changes.push(speaking), {}, { reference, now: () => time });
    early.guarded = true;
    for (let elapsed = 0; elapsed < 600; elapsed += 10) {
      early.push(tone(40, elapsed * 16), RATE);
      time += 10;
    }
    expect(early.leakLevel).toBe(0.04); // still the cautious starting level
    early.close();
  });

  it('is easy to trigger again once the AI has stopped', () => {
    feed(3000, 2000);
    vad.guarded = false;
    aiLevel = 0;
    feed(2500, 300);
    expect(changes).toEqual([true]);
  });
});
