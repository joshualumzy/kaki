import { describe, expect, it } from 'vitest';
import { parseFakeSpeechMessage } from '@kaki/shared';
import { fakeSttFromEnv } from '../../src/npc/fakeStt';

describe('fakeSttFromEnv', () => {
  it('is off unless KAKI_FAKE_STT=1', () => {
    expect(fakeSttFromEnv({})).toBe(false);
    expect(fakeSttFromEnv({ KAKI_FAKE_STT: '0' })).toBe(false);
    expect(fakeSttFromEnv({ KAKI_FAKE_STT: '1', NODE_ENV: 'development' })).toBe(true);
  });

  it('refuses to start in production', () => {
    expect(() => fakeSttFromEnv({ KAKI_FAKE_STT: '1', NODE_ENV: 'production' })).toThrow(/development and tests only/);
  });
});

describe('parseFakeSpeechMessage', () => {
  it('accepts an identity and trimmed words', () => {
    expect(parseFakeSpeechMessage({ identity: ' visitor-1 ', text: '  Yes, go ahead. ' })).toEqual({
      identity: 'visitor-1',
      text: 'Yes, go ahead.',
    });
  });

  it('refuses a message without words or without a speaker', () => {
    expect(parseFakeSpeechMessage({ identity: 'visitor-1', text: '   ' })).toBeUndefined();
    expect(parseFakeSpeechMessage({ text: 'Hello' })).toBeUndefined();
    expect(parseFakeSpeechMessage('Hello')).toBeUndefined();
  });
});
