import { describe, expect, it } from 'vitest';
import { speakerName } from '../src/speaker';

describe('speakerName', () => {
  it('drops a trailing parenthesised role', () => {
    expect(speakerName('Arjun (Lead)')).toBe('Arjun');
    expect(speakerName('Sam (Studio Manager)')).toBe('Sam');
  });

  it('trims surrounding whitespace', () => {
    expect(speakerName('  Arjun (Lead)  ')).toBe('Arjun');
    expect(speakerName('  Arjun  ')).toBe('Arjun');
  });

  it('leaves a name without a trailing role alone', () => {
    expect(speakerName('Arjun')).toBe('Arjun');
    expect(speakerName('(Lead) Arjun')).toBe('(Lead) Arjun');
  });
});
