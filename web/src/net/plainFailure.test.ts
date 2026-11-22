import { describe, expect, it } from 'vitest';
import { plainFailureMessage, plainServerText } from './plainFailure';

describe('plainFailureMessage', () => {
  it('says the sign-in ended for 401 and 403', () => {
    expect(plainFailureMessage(401)).toBe('Your sign-in has ended.');
    expect(plainFailureMessage(403, 'whatever')).toBe('Your sign-in has ended.');
  });
  it('never shows an HTTP code and falls back by status', () => {
    expect(plainFailureMessage(500)).toBe('Kaki is having trouble right now. Try again in a minute.');
    expect(plainFailureMessage(0)).toBe('Kaki is having trouble right now. Try again in a minute.');
    expect(plainFailureMessage(400)).toBe("That didn't work. Try again.");
    expect(plainFailureMessage(400, 'Pick a title first.')).toBe('Pick a title first.');
  });
  it('maps raw server codes to sentences and drops unknown ones', () => {
    expect(plainServerText('meeting-not-found')).toBe('This meeting does not exist.');
    expect(plainServerText('practice-busy')).toContain('practice meeting');
    expect(plainServerText('some-new-code')).toBeUndefined();
    expect(plainFailureMessage(409, 'some-new-code')).toBe("That didn't work. Try again.");
  });
});
