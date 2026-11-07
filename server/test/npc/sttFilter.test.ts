import { describe, expect, it } from 'vitest';
import { confidenceFrom, keepRecognised } from '../../src/npc/sttFilter';

describe('keepRecognised', () => {
  it('drops a short, low-confidence result as noise', () => {
    expect(keepRecognised('Dislocation.', 0.31)).toBe(false);
    expect(keepRecognised('You know.', 0.42)).toBe(false);
  });
  it('keeps a short result that scored well, a 3-4 word phrase or confirmation above 0.4, a long one, and one with no score', () => {
    expect(keepRecognised('OK.', 0.9)).toBe(true);
    expect(keepRecognised('You hear me?', 0.45)).toBe(true);
    expect(keepRecognised('Can you hear me?', 0.42)).toBe(true);
    expect(keepRecognised('Sounds good.', 0.45)).toBe(true);
    expect(keepRecognised('can you fix the crash before friday please', 0.3)).toBe(true);
    expect(keepRecognised('Dislocation.', undefined)).toBe(true);
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
