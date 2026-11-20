import { describe, expect, it } from 'vitest';
import { eventBodies, eventProperties, unescapeIcalText, unfoldIcalLines } from '../src/ical';

describe('unfoldIcalLines', () => {
  it('joins a line folded with a leading space or tab', () => {
    expect(unfoldIcalLines('SUMMARY:Hello\r\n World\n\tagain')).toBe('SUMMARY:HelloWorldagain');
  });
});

describe('unescapeIcalText', () => {
  it('turns escaped newlines into real ones and drops the slash before , ; and \\', () => {
    expect(unescapeIcalText('one\\ntwo\\, three\\; four\\\\five')).toBe('one\ntwo, three; four\\five');
  });
});

describe('eventBodies', () => {
  it('returns each VEVENT body and ignores text outside events', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:one',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:two',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(eventBodies(unfoldIcalLines(ics))).toEqual(['\r\nUID:one\r\n', '\r\nUID:two\r\n']);
  });

  it('returns no body for a calendar without events', () => {
    expect(eventBodies('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toEqual([]);
  });
});

describe('eventProperties', () => {
  it('splits name, head and value, and skips malformed lines', () => {
    expect(eventProperties('UID:one\r\nATTENDEE;CN="Ana":mailto:a@example.com\r\nno colon')).toEqual([
      { name: 'UID', head: 'UID', value: 'one' },
      { name: 'ATTENDEE', head: 'ATTENDEE;CN="Ana"', value: 'mailto:a@example.com' },
    ]);
  });
});
