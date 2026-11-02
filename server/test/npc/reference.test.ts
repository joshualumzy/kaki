import { describe, expect, it } from 'vitest';
import { PlaybackReference } from '../../src/npc/reference';

describe('PlaybackReference', () => {
  function setup() {
    let time = 10_000;
    return { reference: new PlaybackReference(() => time, 60, 800), advance: (ms: number) => void (time += ms), now: () => time };
  }

  it('only counts AI audio as settled once its echo has had time to come back', () => {
    const { reference, advance, now } = setup();
    reference.record(0.2, 0);
    advance(200);
    expect(reference.levelAt(now())).toBe(0.2); // it could be in the microphone
    expect(reference.settledLevelAt(now())).toBe(0); // but its echo is not all there yet
    advance(250);
    expect(reference.settledLevelAt(now())).toBe(0.2);
  });

  it('reports the loudest AI audio from a moment ago, not what is playing this instant or long ago', () => {
    const { reference, advance, now } = setup();
    reference.record(0.1, 0); // audible now
    expect(reference.levelAt(now())).toBe(0); // too recent to be in the microphone yet
    advance(200);
    expect(reference.levelAt(now())).toBe(0.1);
    reference.record(0.3, 0);
    advance(100);
    expect(reference.levelAt(now())).toBe(0.3);
    advance(1000);
    expect(reference.levelAt(now())).toBe(0); // long gone
  });

  it('dates a frame by when it becomes audible, since audio is queued ahead of playout', () => {
    const { reference, advance, now } = setup();
    reference.record(0.2, 400); // audible in 400 ms
    advance(300);
    expect(reference.levelAt(now())).toBe(0);
    advance(200); // 100 ms after it became audible
    expect(reference.levelAt(now())).toBe(0.2);
  });

  it('forgets old frames so it does not grow without bound', () => {
    const { reference, advance, now } = setup();
    for (let index = 0; index < 500; index += 1) {
      reference.record(0.1, 0);
      advance(20);
    }
    expect(reference.levelAt(now())).toBe(0.1);
    expect((reference as unknown as { frames: unknown[] }).frames.length).toBeLessThan(200);
  });

  describe('steadyLevelAt', () => {
    /** Record 20 ms frames of the given level for `ms`, each audible at once, advancing the clock. */
    function play(reference: PlaybackReference, advance: (ms: number) => void, level: number, ms: number): void {
      for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        reference.record(level, 0);
        advance(20);
      }
    }

    it('says nothing until the AI has been audible for the whole window, since the microphone has not caught up', () => {
      const { reference, advance, now } = setup();
      play(reference, advance, 0.2, 400);
      expect(reference.levelAt(now())).toBe(0.2);
      expect(reference.steadyLevelAt(now())).toBe(0);
      play(reference, advance, 0.2, 600);
      expect(reference.steadyLevelAt(now())).toBe(0.2);
    });

    it('reports the quietest level in the window, and nothing across a pause', () => {
      const { reference, advance, now } = setup();
      play(reference, advance, 0.3, 500);
      play(reference, advance, 0.1, 500);
      expect(reference.steadyLevelAt(now())).toBe(0.1);
      advance(400); // the AI paused
      expect(reference.steadyLevelAt(now())).toBe(0);
    });
  });
});
