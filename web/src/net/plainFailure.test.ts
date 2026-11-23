import { describe, expect, it } from 'vitest';
import { plainFailureMessage, plainServerText } from './plainFailure';

describe('plainFailureMessage', () => {
  it('says the sign-in ended only for a missing or expired session', () => {
    expect(plainFailureMessage(401)).toBe('Your sign-in has ended.');
    expect(plainFailureMessage(401, 'anything')).toBe('Your sign-in has ended.');
    expect(plainFailureMessage(403, 'anything', true)).toBe('Your sign-in has ended.');
  });
  it('shows a permission refusal instead of the sign-in sentence', () => {
    expect(plainFailureMessage(403, 'You are not a member of that workspace.')).toBe(
      'You are not a member of that workspace.',
    );
    expect(plainFailureMessage(403, 'whatever', false)).toBe('whatever');
    expect(plainFailureMessage(401, 'Sign in required.', false)).toBe('Sign in required.');
  });
  it('shows a practice refusal instead of the sign-in sentence for a 403', () => {
    expect(plainFailureMessage(403, 'practice-access')).toContain('another visitor');
    expect(plainFailureMessage(403, 'practice-moved')).toContain('own page');
  });
  it('never shows an HTTP code and falls back by status', () => {
    expect(plainFailureMessage(500)).toBe('Kaki is having trouble right now. Try again in a minute.');
    expect(plainFailureMessage(0)).toBe('Kaki is having trouble right now. Try again in a minute.');
    expect(plainFailureMessage(400)).toBe("That didn't work. Try again.");
    expect(plainFailureMessage(400, 'Pick a title first.')).toBe('Pick a title first.');
  });
  it('maps raw server codes to sentences and drops unknown ones', () => {
    expect(plainServerText('meeting-not-found')).toBe('This meeting does not exist.');
    expect(plainServerText('practice-full')).toContain('practice rooms');
    expect(plainServerText('practice-full')).toContain('All practice rooms are in use right now.');
    expect(plainServerText('practice-moved')).toContain('own page');
    expect(plainServerText('practice-access')).toContain('another visitor');
    expect(plainServerText('practice-ended')).toContain('Start a new practice');
    expect(plainServerText('some-new-code')).toBeUndefined();
    expect(plainFailureMessage(409, 'some-new-code')).toBe("That didn't work. Try again.");
  });
});
