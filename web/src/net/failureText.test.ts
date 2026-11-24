import { describe, expect, it } from 'vitest';
import { FAILURE_CODES, type FailureCode } from '@kaki/shared';
import { failureText } from './failureText';

const DEVICE_CODES: FailureCode[] = [
  'mic-blocked',
  'mic-missing',
  'camera-blocked',
  'camera-missing',
  'media-blocked',
  'mic-unsupported',
  'camera-unsupported',
  'mic-failed',
  'camera-failed',
  'speech-unknown',
];

const ALL_CODES: FailureCode[] = [...FAILURE_CODES, ...DEVICE_CODES];

describe('failureText', () => {
  it('words every code in both a practice and a real meeting', () => {
    for (const code of ALL_CODES) {
      expect(failureText(code, { real: false }).trim()).not.toBe('');
      expect(failureText(code, { real: true }).trim()).not.toBe('');
    }
  });

  it('never tells a practice meeting to type', () => {
    for (const code of ALL_CODES) {
      expect(failureText(code, { real: false })).not.toMatch(/\btype\b/i);
    }
  });

  it('offers typing only where a real meeting has it', () => {
    expect(failureText('speech-failed', { real: true })).toMatch(/\btype\b/i);
    expect(failureText('speech-failed', { real: false })).not.toMatch(/\btype\b/i);
  });

  it('names the device and what to do about it', () => {
    expect(failureText('mic-blocked', { real: false })).toContain('microphone');
    expect(failureText('mic-blocked', { real: false })).toContain('rejoin');
    expect(failureText('mic-missing', { real: false })).toContain('No microphone');
    expect(failureText('camera-blocked', { real: true })).toContain('camera');
    expect(failureText('camera-missing', { real: true })).toContain('No camera');
  });

  it('never claims a shared outage lost this viewer\'s own words', () => {
    expect(failureText('speech-outage', { real: false })).toBe('Speech recognition is not working.');
    expect(failureText('speech-outage', { real: true })).toBe('Speech recognition is not working.');
  });

  it('adds the lost-line clause only when this viewer\'s own speech failed', () => {
    expect(failureText('speech-outage', { real: false, ownSpeechFailed: true })).toContain(
      'Your last line was not heard',
    );
    expect(failureText('speech-outage', { real: false, ownSpeechFailed: true })).toMatch(/say it again/i);
    expect(failureText('speech-outage', { real: false, ownSpeechFailed: true })).not.toMatch(/\btype\b/i);
    expect(failureText('speech-outage', { real: true, ownSpeechFailed: true })).toMatch(/type it instead/i);
  });

  it('shows a generic sentence for a wire code this browser does not know', () => {
    expect(failureText('speech-unknown', { real: false })).toBe('Speech recognition hit a problem.');
  });
});
