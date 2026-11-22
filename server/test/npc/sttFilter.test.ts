import { describe, expect, it } from 'vitest';
import { confidenceFrom, keepRecognised } from '../../src/npc/sttFilter';

describe('keepRecognised', () => {
  it('drops a short, low-confidence result or standalone hesitation filler as noise', () => {
    expect(keepRecognised('Dislocation.', 0.31)).toBe(false);
    expect(keepRecognised('You know.', 0.42)).toBe(false);
    expect(keepRecognised('Uh.', 0.85)).toBe(false);
    expect(keepRecognised('Um.', 0.92)).toBe(false);
  });
  it('keeps a short result that scored well, a 3-4 word phrase or confirmation above 0.4, a long one, and one with no score', () => {
    expect(keepRecognised('OK.', 0.9)).toBe(true);
    expect(keepRecognised('You hear me?', 0.45)).toBe(true);
    expect(keepRecognised('Can you hear me?', 0.42)).toBe(true);
    expect(keepRecognised('Sounds good.', 0.45)).toBe(true);
    expect(keepRecognised('can you fix the crash before friday please', 0.3)).toBe(true);
    expect(keepRecognised('Dislocation.', undefined)).toBe(true);
  });
  it('keeps a short commitment that scored moderately instead of dropping it', () => {
    expect(keepRecognised("I'll do it.", 0.4)).toBe(true);
    expect(keepRecognised('Will do.', 0.45)).toBe(true);
    expect(keepRecognised('Got it.', 0.42)).toBe(true);
    expect(keepRecognised('On it.', 0.45)).toBe(true);
    expect(keepRecognised('Count me in.', 0.4)).toBe(true);
    expect(keepRecognised('Leave it with me.', 0.42)).toBe(true);
  });
  it('still drops short noise that is not a commitment', () => {
    expect(keepRecognised('Dislocation.', 0.31)).toBe(false);
    expect(keepRecognised('You know.', 0.42)).toBe(false);
    expect(keepRecognised('Will do.', 0.2)).toBe(false);
  });
});

describe('confidenceFrom', () => {
  it('reads the best guess', () => {
    expect(confidenceFrom('{"NBest":[{"Confidence":0.82},{"Confidence":0.4}]}')).toBe(0.82);
  });
  it('is undefined for missing or broken JSON', () => {
    expect(confidenceFrom(undefined)).toBeUndefined();
    expect(confidenceFrom('nope')).toBeUndefined();
    expect(confidenceFrom('{}')).toBeUndefined();
  });
});
