import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMeetingIcs,
  createMeetingCalendarSync,
  escapeIcalText,
  meetingCalendarUid,
  meetingDescription,
  meetingDurationMinutes,
} from '../../src/meeting/calendarEvent';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import type { WorkspaceTools } from '../../src/workspace/tools';

const meeting = {
  id: 'meeting-abc',
  workspaceId: 'workspace-1',
  title: 'Weekly sync, planning; notes',
  scheduledFor: '2026-11-13T02:00:00.000Z',
  agenda: [
    { title: 'Budget', minutes: 20 },
    { title: 'Hiring' },
  ],
};

const calendarTools: WorkspaceTools = {
  readOnly: false,
  calendar: { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' },
};

function toolSource(tools: WorkspaceTools) {
  return { toolsFor: async () => tools };
}

function calendarFetch(status = 201) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') return new Response('', { status });
    return new Response('', { status: 405 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('meeting calendar events', () => {
  it('derives one stable UID from the meeting id and writes UTC times with SEQUENCE', async () => {
    const store = createMemoryMeetingStore();
    const fetchImpl = calendarFetch();
    const calendar = createMeetingCalendarSync({
      store,
      tools: toolSource(calendarTools),
      fetchImpl,
      now: () => Date.parse('2026-11-01T00:00:00Z'),
    });

    const first = await calendar.syncMeeting(meeting);
    expect(first.state).toMatchObject({
      uid: meetingCalendarUid('meeting-abc'),
      sequence: 0,
      state: 'synced',
    });
    expect(first.warning).toBeNull();
    const puts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(String(puts[0]?.[0])).toBe('http://cal.test/user/calendar/kaki-meeting-meeting-abc.ics');
    const body = String(puts[0]?.[1]?.body);
    expect(body).toContain('UID:kaki-meeting-meeting-abc@kaki.local');
    expect(body).toContain('DTSTART:20261113T020000Z');
    expect(body).toContain('DTEND:20261113T022000Z');
    expect(body).toContain('SEQUENCE:0');
    expect(body).toContain('STATUS:CONFIRMED');
    expect(body).toContain('SUMMARY:Weekly sync\\, planning\\; notes');
    expect(body).toContain('DESCRIPTION:Agenda:\\n- Budget (20 min)\\n- Hiring');
    expect(await store.calendarEventFor?.('meeting-abc')).toMatchObject({ sequence: 0 });
  });

  it('updates the same UID and bumps SEQUENCE on an edit', async () => {
    const store = createMemoryMeetingStore();
    const fetchImpl = calendarFetch();
    const calendar = createMeetingCalendarSync({
      store,
      tools: toolSource(calendarTools),
      fetchImpl,
    });
    await calendar.syncMeeting(meeting);
    const updated = await calendar.syncMeeting(
      { ...meeting, title: 'Weekly sync v2' },
      { bumpSequence: true },
    );
    expect(updated.state.sequence).toBe(1);
    const bodies = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('UID:kaki-meeting-meeting-abc@kaki.local');
    expect(bodies[1]).toContain('SEQUENCE:1');
    expect(bodies[1]).toContain('SUMMARY:Weekly sync v2');
    expect((await store.calendarEventFor?.('meeting-abc'))?.sequence).toBe(1);
  });

  it('records a calendar failure on the meeting, then retries the same event', async () => {
    const store = createMemoryMeetingStore();
    let down = true;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (down) throw new Error('connect ECONNREFUSED');
      return new Response('', { status: init?.method === 'PUT' ? 201 : 405 });
    });
    const calendar = createMeetingCalendarSync({
      store,
      tools: toolSource(calendarTools),
      fetchImpl,
    });

    const failed = await calendar.syncMeeting(meeting);
    expect(failed.state.state).toBe('error');
    expect(failed.state.error).toContain('not answering');
    expect(await store.calendarEventFor?.('meeting-abc')).toMatchObject({
      state: 'error',
      sequence: 0,
    });

    down = false;
    const retried = await calendar.syncMeeting(meeting);
    expect(retried.state).toMatchObject({ state: 'synced', sequence: 0 });
    const lastPut = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .at(-1);
    expect(String(lastPut?.[1]?.body)).toContain('SEQUENCE:0');
  });

  it('cancels through the Round 2 hook with STATUS:CANCELLED and a bumped SEQUENCE', async () => {
    const store = createMemoryMeetingStore();
    const fetchImpl = calendarFetch();
    const calendar = createMeetingCalendarSync({
      store,
      tools: toolSource(calendarTools),
      fetchImpl,
    });
    await calendar.syncMeeting(meeting);
    const outcome = await calendar.cancelMeeting(meeting);
    expect(outcome.warning).toBeNull();
    const lastPut = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'PUT')
      .at(-1);
    const body = String(lastPut?.[1]?.body);
    expect(body).toContain('STATUS:CANCELLED');
    expect(body).toContain('SEQUENCE:1');
    expect(body).not.toContain('METHOD:');
  });

  it('never writes when the workspace has no connected calendar', async () => {
    const store = createMemoryMeetingStore();
    const fetchImpl = calendarFetch();
    const calendar = createMeetingCalendarSync({
      store,
      tools: toolSource({ readOnly: false }),
      fetchImpl,
    });
    const outcome = await calendar.syncMeeting(meeting);
    expect(outcome.state.state).toBe('not_connected');
    expect(fetchImpl.mock.calls).toHaveLength(0);
    expect(await calendar.cancelMeeting(meeting)).toEqual({ warning: null });
  });

  it('escapes text and folds long lines at 75 octets', () => {
    expect(escapeIcalText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    const description = 'Long note '.repeat(20);
    const ics = buildMeetingIcs({
      uid: meetingCalendarUid('m'),
      sequence: 3,
      title: 'A fairly long meeting title that runs past the seventy-five octet fold limit',
      description,
      start: '2026-11-13T02:00:00.000Z',
      durationMinutes: 30,
      now: new Date('2026-11-01T00:00:00Z'),
    });
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(ics).toContain('SEQUENCE:3');
  });

  it('builds the agenda description and falls back to half an hour', () => {
    expect(meetingDescription([{ title: 'A', minutes: 5 }, { title: '' }])).toBe('Agenda:\n- A (5 min)');
    expect(meetingDurationMinutes([])).toBe(30);
    expect(meetingDurationMinutes([{ title: 'A', minutes: 15 }, { title: 'B', minutes: 20 }])).toBe(35);
  });
});
