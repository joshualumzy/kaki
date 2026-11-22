import { describe, expect, it } from 'vitest';
import { isNonEmptyString, isObject, isString } from '../src/guards';

describe('isObject', () => {
  it('accepts plain objects only', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(Object.create(null))).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject('text')).toBe(false);
    expect(isObject(1)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe('isString', () => {
  it('accepts every string, including empty text', () => {
    expect(isString('')).toBe(true);
    expect(isString('hello')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isString(1)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString(['a'])).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  it('accepts text with a non-whitespace character', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString(' a ')).toBe(true);
  });

  it('rejects empty and whitespace-only text, and non-strings', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString('\n\t')).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
  });
});
