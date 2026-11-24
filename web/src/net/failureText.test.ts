import { describe, expect, it } from 'vitest';
import { FAILURE_CODES, type FailureCode } from '@kaki/shared';
import { failureText } from './failureText';

const TYPE_CODES: FailureCode[] = ['speech-failed', 'speech-outage'];

describe('failureText', () => {
  it('words every code in both a practice and a real meeting', () => {
    for (const code of FAILURE_CODES) {
      expect(failureText(code, { real: false }).trim()).not.toBe('');
      expect(failureText(code, { real: true }).trim()).not.toBe('');
    }
  });

  it('never tells a practice meeting to type', () => {
    for (const code of FAILURE_CODES) {
      expect(failureText(code, { real: false })).not.toMatch(/\btype\b/i);
    }
  });

  it('offers typing only where a real meeting has it', () => {
    for (const code of TYPE_CODES) {
      expect(failureText(code, { real: true })).toMatch(/\btype\b/i);
    }
  });

  it('names the device and what to do about it', () => {
    expect(failureText('mic-blocked', { real: false })).toContain('microphone');
    expect(failureText('mic-blocked', { real: false })).toContain('rejoin');
    expect(failureText('mic-missing', { real: false })).toContain('No microphone');
    expect(failureText('camera-blocked', { real: true })).toContain('camera');
    expect(failureText('camera-missing', { real: true })).toContain('No camera');
  });
});
