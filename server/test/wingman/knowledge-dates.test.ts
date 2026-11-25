import { describe, expect, it } from 'vitest';
import { meetingDay } from '../../src/wingman/knowledge/dates';

describe('meeting date', () => {
  it('uses the meeting time zone, not UTC, so a late UTC instant is already the next day', () => {
    expect(meetingDay(new Date('2026-11-25T16:42:00.000Z'))).toBe('2026-11-26');
    expect(meetingDay(new Date('2026-11-25T15:59:59.000Z'))).toBe('2026-11-25');
  });
});
