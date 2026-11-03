import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import { buildIcs, createCalendarModule, formatBody, parseBody, parseIcs, renderEventPage, viewEvent, type CalendarModuleOptions, type CalendarSettings } from '../../src/action/calendar';
import type { Hub } from '../../src/hub';
import { createFakeLlm } from '../../src/llm';
import { createTaskStore, type TaskStore } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';

const settings: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };
const reply = JSON.stringify({ title: 'Follow-up with Starfruit', start: '2026-11-13 10:00', durationMinutes: 30, description: 'Confirm the build date.' });
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
    close: () => {},
  };
}

function setup(options: CalendarModuleOptions): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = createCalendarModule(options).start({ hub, tasks, scenario: testScenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'calendar_event'): Task {
  const task = tasks.suggest({
    title: 'Fix the oven',
    context: 'The oven trips the fuse after ten minutes.',
    suggestedAssignee: 'chef',
    actionKind,
  });
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
      subject: 'Follow-up with Starfruit',
      body: 'Start: 2026-11-13 10:00\nDuration: 30 minutes\n\nConfirm the build date.',
    });
  });

  it('saves the event under the task id and links the viewer page', async () => {
    const fetchImpl = calFetch();
    const tasks = setup({ llm: createFakeLlm(() => reply), calendar: settings, fetchImpl });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe(`http://kaki.test/api/calendar/${task.id}`);
    const put = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(put?.[0])).toBe(`http://cal.test/user/calendar/${task.id}.ics`);
    expect(String(put?.[1]?.body)).toContain('SUMMARY:Follow-up with Starfruit');
    expect(String(put?.[1]?.body)).toContain('DTSTART:20261113T100000');
    expect(String(put?.[1]?.body)).toContain('DTEND:20261113T103000');
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
    expect(parseIcs(ics)).toMatchObject({
      title: 'Title, here',
      start: '2026-11-13 10:00',
      end: '2026-11-13 10:45',
      description: 'Line one, with; punctuation',
    });
  });

  it('renders a readable page, escapes markup and handles missing events', async () => {
    const ics = buildIcs('u', '<b>x</b>', { start: '2026-11-13 10:00', durationMinutes: 30 }, 'Notes', new Date());
    const html = renderEventPage(ics, '/api/calendar/abc?download=1');
    expect(html).toContain('2026-11-13 10:00 to 10:30');
    expect(html).not.toContain('<b>x</b>');
    const found = vi.fn<typeof fetch>(async () => new Response(ics, { status: 200 }));
    expect((await viewEvent(settings, 'abc', false, found)).contentType).toContain('text/html');
    expect((await viewEvent(settings, 'abc', true, found)).filename).toBe('abc.ics');
    expect((await viewEvent(settings, '../etc', false, found)).status).toBe(404);
    const missing = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    expect((await viewEvent(settings, 'abc', false, missing)).status).toBe(404);
  });
});
