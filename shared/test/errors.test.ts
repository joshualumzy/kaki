import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/errors';

describe('errorMessage', () => {
  it('reads an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(42)).toBe('42');
  });
});
