import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import { buildIcs, createCalendarModule, formatBody, parseBody, parseEvents, upcomingDays, viewEvent, type CalendarModuleOptions, type CalendarSettings } from '../../src/action/calendar';
import type { Hub } from '../../src/core/hub';
import { createFakeLlm } from '../../src/services/llm';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';
import { createMemoryTaskCalendarEventStore, createTaskCalendarLifecycle } from '../../src/meeting/taskCalendarEvents';

const settings: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };
const reply = JSON.stringify({ title: 'Follow-up with Zack', start: '2026-11-13 10:00', durationMinutes: 30, description: 'Confirm the re-taste time.' });
const stops: Array<() => void> = [];

afterEach(() => {
  stopAll();
  vi.restoreAllMocks();
});

function stopAll(): void {
  for (const stop of stops.splice(0)) stop();
}

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

function setup(options: CalendarModuleOptions): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = createCalendarModule(options).start({ meetingId: () => 'meeting', workspaceId: () => 'sample-nanyang-kopi', hub, tasks, activeScenario: () => testScenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'calendar_event', sourceSeconds?: number): Task {
  const task = tasks.suggest(
    {
      title: 'Fix the oven',
      context: 'The oven trips the fuse after ten minutes.',
      suggestedAssignee: 'chef',
      actionKind,
    },
    undefined,
    sourceSeconds,
  );
  tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
  return task;
}

function waitForStatus(tasks: TaskStore, id: string, status: Task['status'], timeoutMs = 2_000): Promise<Task> {
  return waitFor(
    () => {
      const task = tasks.get(id);
      return task?.status === status ? task : undefined;
    },
    `task ${id} to be ${status}`,
    timeoutMs,
  );
}


function calFetch(putStatus = 201) {
  return vi.fn<typeof fetch>(async (_url, init) => new Response('', { status: init?.method === 'PUT' ? putStatus : 405 }));
}

describe('calendar action module', () => {
  it('drafts an event with editable start and duration lines', async () => {
    const tasks = setup({ llm: createFakeLlm(() => reply), calendar: settings, fetchImpl: calFetch(), today: () => '2026-11-03' });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft).toEqual({
      target: 'Team calendar',
      subject: 'Follow-up with Zack',
      body: 'Start: 2026-11-13 10:00\nDuration: 30 minutes\n\nConfirm the re-taste time.',
    });
  });

  it('saves the event under the task id and links the viewer page', async () => {
    const fetchImpl = calFetch();
    const tasks = setup({ llm: createFakeLlm(() => reply), calendar: settings, fetchImpl });
    const task = startTask(tasks, 'calendar_event', 930);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe(`http://kaki.test/api/meetings/meeting/calendar/${task.id}`);
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(put?.[0])).toBe(`http://cal.test/user/calendar/${task.id}.ics`);
    expect(String(put?.[1]?.body)).toContain('SUMMARY:Follow-up with Zack');
    expect(String(put?.[1]?.body)).toContain('DTSTART:20261113T100000');
    expect(String(put?.[1]?.body)).toContain('DTEND:20261113T103000');
    expect(String(put?.[1]?.body)).toContain('Posted by Kaki for Ada\\, approved in Lunch service readiness.');
  });

  it('sends calendar credentials as Basic auth, never in the URL', async () => {
    const expected = `Basic ${Buffer.from('cal-user:cal-secret').toString('base64')}`;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).not.toContain('cal-secret');
      expect((init?.headers as Record<string, string>).authorization).toBe(expected);
      return new Response('', { status: init?.method === 'PUT' ? 201 : 405 });
    });
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      calendar: { ...settings, user: 'cal-user', password: 'cal-secret' },
      fetchImpl,
    });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
  });

  it('links the saved event on the server-provided public calendar base', async () => {
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      calendar: { ...settings, viewBaseUrl: 'https://kaki.example.com' },
      fetchImpl: calFetch(),
    });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe(`https://kaki.example.com/api/meetings/meeting/calendar/${task.id}`);
  });

  it('fails with the calendar status when the save is refused', async () => {
    const tasks = setup({ llm: createFakeLlm(() => reply), calendar: settings, fetchImpl: calFetch(500) });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toContain('HTTP 500');
  });

  it('rejects a draft whose start line was edited into nonsense', () => {
    expect(() => parseBody('Start: next friday\n\nhi')).toThrow('Start: 2026-11-13 10:00');
    expect(() => buildIcs('u', 't', { start: '2026-02-31 10:00', durationMinutes: 30 }, '', new Date())).toThrow('not a real date');
  });

  it('round-trips the body and the ics', () => {
    const body = formatBody({ start: '2026-11-13 10:00', durationMinutes: 45 }, 'Line one, with; punctuation');
    const { times, notes } = parseBody(body);
    const ics = buildIcs('uid@kaki.local', 'Title, here', times, notes, new Date('2026-11-03T00:00:00Z'));
    expect(parseEvents(ics)[0]).toMatchObject({
      title: 'Title, here',
      date: '2026-11-13',
      time: '10:00',
      endTime: '10:45',
      description: 'Line one, with; punctuation',
    });
  });

  it('lists weekdays from a table so the model looks dates up', () => {
    const days = upcomingDays('2026-11-03');
    expect(days[0]).toBe('Tuesday 2026-11-03');
    expect(days).toContain('Friday 2026-11-06');
    expect(days).toContain('Friday 2026-11-13');
  });

  it('shows the whole team calendar as a month grid with the event highlighted, and no ics link', async () => {
    const mine = buildIcs('kaki-abc@kaki.local', '<b>x</b>', { start: '2026-11-13 11:00', durationMinutes: 30 }, 'Notes', new Date());
    const seeded = buildIcs('seed@kaki.local', 'Launch readiness', { start: '2026-11-01 09:00', durationMinutes: 60 }, '', new Date());
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      new Response(String(url).endsWith('/abc.ics') ? mine : mine + seeded, { status: 200 }),
    );
    const page = await viewEvent(settings, 'abc', {}, fetchImpl);
    expect(page.contentType).toContain('text/html');
    expect(page.body).toContain('November 2026');
    expect(page.body).toContain('Launch readiness');
    expect(page.body).toContain('class="chip focus" data-i="0"');
    expect(page.body).toContain('data-i="1"');
    expect(page.body).toContain('var EVENTS=');
    expect(page.body).toContain('2026-11-13, 11:00 to 11:30');
    expect(page.body).not.toContain('<b>x</b>');
    expect(page.body).not.toContain('.ics');
    const next = await viewEvent(settings, 'abc', { month: '2026-12' }, fetchImpl);
    expect(next.body).toContain('December 2026');
    const inMeeting = await viewEvent(
      settings,
      'abc',
      { baseHref: '/api/meetings/m1/calendar/abc' },
      fetchImpl,
    );
    expect(inMeeting.body).toContain('/api/meetings/m1/calendar/abc?month=2026-10');
    expect((await viewEvent(settings, 'abc', { download: true }, fetchImpl)).filename).toBe('abc.ics');
    expect((await viewEvent(settings, '../etc', {}, fetchImpl)).status).toBe(404);
    const missing = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    expect((await viewEvent(settings, 'abc', {}, missing)).status).toBe(404);
  });

  it('preserves a UTC instant and a TZID instant instead of shifting the clock', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:utc@test',
      'DTSTART:29991113T100000Z',
      'DTEND:29991113T110000Z',
      'SUMMARY:UTC event',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:singapore@test',
      'DTSTART;TZID=Asia/Singapore:29991113T100000',
      'DTEND;TZID=Asia/Singapore:29991113T110000',
      'SUMMARY:Singapore event',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const events = parseEvents(ics);
    expect(events[0]).toMatchObject({
      start: '2999-11-13T10:00:00.000Z',
      timeZone: 'UTC',
      date: '2999-11-13',
      time: '10:00',
    });
    // 10:00 in Singapore is 02:00 UTC, never 10:00 UTC.
    expect(events[1]).toMatchObject({
      start: '2999-11-13T02:00:00.000Z',
      timeZone: 'Asia/Singapore',
      date: '2999-11-13',
      time: '10:00',
    });
  });

  it('reads STATUS so a cancelled event can be excluded from the picker', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cancelled@test',
      'DTSTART:29991113T100000Z',
      'SUMMARY:Cancelled',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    expect(parseEvents(ics)[0]).toMatchObject({ uid: 'cancelled@test', status: 'CANCELLED' });
  });


  it('saves an approved follow-up through the shared durable lifecycle', async () => {
    const followUps = createMemoryTaskCalendarEventStore();
    const fetchImpl = calFetch();
    const events = createTaskCalendarLifecycle({ store: followUps, fetchImpl });
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      calendar: settings,
      fetchImpl,
      events,
      workspaceId: 'workspace-1',
    });
    const task = startTask(tasks, 'calendar_event');
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe(`http://kaki.test/api/meetings/meeting/calendar/${task.id}`);
    expect(await followUps.get(task.id)).toMatchObject({
      workspaceId: 'workspace-1',
      meetingId: 'meeting',
      state: 'synced',
      sequence: 0,
    });
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(put?.[0])).toBe(`http://cal.test/user/calendar/${task.id}.ics`);
    expect(String(put?.[1]?.body)).toContain('SEQUENCE:0');
  });

});
