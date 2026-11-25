import { describe, expect, it } from 'vitest';
import { formatMeetingTime, localZoneAbbreviation } from './meetingTime';

describe('meeting time labels', () => {
  it('leaves an unreadable instant untouched', () => {
    expect(formatMeetingTime('not-a-date')).toBe('not-a-date');
  });

  it('names the viewer’s own zone beside a meeting time', () => {
    const when = new Date('2999-01-01T02:00:00.000Z');
    const zone = localZoneAbbreviation(when);
    const text = formatMeetingTime(when.toISOString());

    expect(text).toContain(when.toLocaleString());
    if (zone !== '') expect(text.endsWith(zone)).toBe(true);
  });
});
