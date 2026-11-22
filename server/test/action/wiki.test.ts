import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Scenario, Task } from '@kaki/shared';
import { buildMeetingMinutes, createWikiModule, pagePath, type WikiModuleOptions, type WikiSettings } from '../../src/action/wiki';
import { roleAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { SavedMeetingDetails } from '../../src/persist/state';
import { createFakeLlm } from '../../src/services/llm';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';

const settings: WikiSettings = { url: 'http://wiki.test', email: 'a@b.test', password: 'pw' };
const reply = JSON.stringify({ title: 'Launch notes', body: '- Build is due 20 Nov' });
const stops: Array<() => void> = [];

afterEach(() => {
  stopAll();
  vi.restoreAllMocks();
});

function stopAll(): void {
  for (const stop of stops.splice(0)) stop();
}

function quietHub(): Hub {
  const listeners = new Set<(event: KakiEvent) => void>();
  return {
    publish: (event: KakiEvent) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

function setup(
  options: WikiModuleOptions,
  draftOnly = false,
  context: {
    scenario?: Scenario;
    activeScenario?: Scenario;
    seats?: Array<{ name: string; seat: string }>;
    offTheRecordSpans?: Array<{ from: string; to: string }>;
  } = {},
): TaskStore & { hub: Hub } {
  const scenario = context.scenario ?? testScenario;
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario });
  const stop = createWikiModule(options).start({ meetingId: () => 'meeting', workspaceId: () => 'sample-nanyang-kopi',
    hub,
    tasks,
    activeScenario: () => context.activeScenario ?? scenario,
    draftOnly,
    ...(context.seats === undefined
      ? {}
      : {
          meetingDetails: () =>
            ({
              holders: context.seats!,
              ...(context.offTheRecordSpans === undefined
                ? {}
                : { offTheRecordSpans: context.offTheRecordSpans }),
            }) as unknown as SavedMeetingDetails,
        }),
  });
  if (stop !== undefined) stops.push(stop);
  return Object.assign(tasks, { hub });
}

function publishClosing(hub: Hub): void {
  hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: { speaker: 'Mei (Chef)', text: 'We decided to cap the oven at 200C.', timestamp: '2026-11-03T10:00:00Z' },
  });
  hub.publish({
    type: 'HOST_SPEECH_TRIGGERED',
    audience: { kind: 'screen' },
    payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
  });
}

function minutesTaskIn(tasks: TaskStore): Task | undefined {
  return tasks.list().find((task) => task.purpose === 'meeting_minutes');
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'wiki_page', sourceSeconds?: number): Task {
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


function wikiFetch(createMessage?: string) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query as string;
    const data = query.includes('Login')
      ? { authentication: { login: { jwt: 'jwt', responseResult: { succeeded: true } } } }
      : {
          pages: {
            create: { responseResult: createMessage === undefined ? { succeeded: true } : { succeeded: false, message: createMessage } },
          },
        };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

async function draftAndRun(tasks: TaskStore, sourceSeconds?: number): Promise<Task> {
  const task = startTask(tasks, 'wiki_page', sourceSeconds);
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
  tasks.transition(ready.id, 'RUNNING');
  return ready;
}

describe('wiki action module', () => {
  it('drafts a page without writing anything', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, today: () => '2026-11-03' });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft).toEqual({ target: 'Wiki: meeting notes', subject: 'Launch notes', body: '- Build is due 20 Nov' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('publishes the approved page and links to it', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, today: () => '2026-11-03' });
    const ready = await draftAndRun(tasks, 930);
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe('http://wiki.test/en/meetings/2026-11-03-launch-notes');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const createCall = fetchImpl.mock.calls.find(([, init]) => JSON.parse(String(init?.body)).query.includes('Create'));
    if (createCall === undefined) throw new Error('Expected a page create request');
    expect(JSON.parse(String(createCall[1]?.body)).variables.content).toContain(
      'Posted by Kaki for Ada, approved in Lunch service readiness.',
    );
  });

  it('links the existing page when a retry finds it already created', async () => {
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      wiki: settings,
      fetchImpl: wikiFetch('Cannot create this page because an entry already exists at the same path.'),
      today: () => '2026-11-03',
    });
    const ready = await draftAndRun(tasks);
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toContain('/en/meetings/2026-11-03-launch-notes');
  });

  /** A wiki whose create outlasts the timeout; `existingPaths` is what the recent-pages lookup then sees. */
  function slowCreateFetch(existingPaths: string[]) {
    return vi.fn<typeof fetch>(async (_url, init) => {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes('Create')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      const data = query.includes('Login')
        ? { authentication: { login: { jwt: 'jwt', responseResult: { succeeded: true } } } }
        : { pages: { list: existingPaths.map((path) => ({ path })) } };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  it('completes when the create times out but the page was written', async () => {
    const fetchImpl = slowCreateFetch(['meetings/2026-11-03-launch-notes']);
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, timeoutMs: 50, today: () => '2026-11-03' });
    const ready = await draftAndRun(tasks);
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe('http://wiki.test/en/meetings/2026-11-03-launch-notes');
  });

  it('fails and says a retry is safe when the create times out and the page is not there', async () => {
    const fetchImpl = slowCreateFetch(['meetings/something-else']);
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, timeoutMs: 50, today: () => '2026-11-03' });
    const ready = await draftAndRun(tasks);
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toContain('timed out');
    expect(failed.error).toContain('safe to retry');
  });

  it('fails in plain words when the wiki cannot be reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8081') });
    });
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl });
    const ready = await draftAndRun(tasks);
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toContain('The wiki is not answering');
  });

  it('fails with a clear message when not configured', async () => {
    const tasks = setup({ llm: createFakeLlm(() => reply) });
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toContain('The wiki is not connected for this workspace');
  });

  it('builds a safe dated path', () => {
    expect(pagePath('2026-11-03', 'Launch: notes & "plans"!')).toBe('meetings/2026-11-03-launch-notes-plans');
    expect(pagePath('2026-11-03', '???')).toBe('meetings/2026-11-03-notes');
  });

  it('keeps the minutes out of the summary by purpose, not by title', () => {
    const minutesTask: Task = {
      id: 'task-minutes',
      title: 'Housekeeping notes',
      context: 'The minutes themselves.',
      suggestedAssignee: 'chef',
      status: 'DRAFT_READY',
      updatedAt: '2026-11-03T10:00:00.000Z',
      purpose: 'meeting_minutes',
    };
    const ordinaryTask: Task = {
      id: 'task-ordinary',
      title: 'Publish meeting minutes to the noticeboard',
      context: 'A normal follow-up about how we publish notes.',
      suggestedAssignee: 'chef',
      status: 'SUGGESTED',
      updatedAt: '2026-11-03T10:01:00.000Z',
    };

    const minutes = buildMeetingMinutes(
      testScenario,
      '2026-11-03',
      [{ speaker: 'Mei (Chef)', text: 'We decided to cap the oven at 200C.' }],
      [],
      [minutesTask, ordinaryTask],
    );

    expect(minutes).toContain(ordinaryTask.title);
    expect(minutes).not.toContain(minutesTask.title);
  });

  it('creates the minutes in the review state at closing, assigned to the present person, without calling the wiki', async () => {
    const fetchImpl = wikiFetch();
    const llm = createFakeLlm(() => reply);
    const tasks = setup(
      { llm, wiki: settings, fetchImpl, minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.status).toBe('DRAFT_READY');
    expect(minutesTask.assignee).toBe('cashier');
    expect(minutesTask.suggestedAssignee).toBe('cashier');
    expect(minutesTask.actionKind).toBe('wiki_page');
    expect(minutesTask.purpose).toBe('meeting_minutes');
    expect(minutesTask.mode).toBe('ACTION_AGENT');
    expect(minutesTask.draft).toEqual({
      target: 'Wiki: meeting notes',
      subject: 'Lunch service readiness — Meeting Minutes',
      body: buildMeetingMinutes(
        testScenario,
        '2026-11-03',
        [{ speaker: 'Mei (Chef)', text: 'We decided to cap the oven at 200C.' }],
        [],
        [],
      ),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
  });

  it('marks each off-the-record span with its times and no content', () => {
    const minutes = buildMeetingMinutes(
      testScenario,
      '2026-11-03',
      [{ speaker: 'Mei (Chef)', text: 'On the record.' }],
      [],
      [],
      [
        { from: '2026-11-03T10:05:00.000Z', to: '2026-11-03T10:07:00.000Z' },
        { from: '2026-11-03T10:20:00.000Z', to: '2026-11-03T10:21:30.000Z' },
      ],
    );
    expect(minutes).toContain('- Off the record 10:05–10:07');
    expect(minutes).toContain('- Off the record 10:20–10:21');
    expect(minutes).not.toContain('secret');
  });

  it('drafts the minutes from the ended record of a real meeting, with no spoken closing', async () => {
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      {
        seats: [{ name: 'Bao', seat: 'cashier' }],
        offTheRecordSpans: [{ from: '2026-11-03T10:05:00.000Z', to: '2026-11-03T10:06:00.000Z' }],
      },
    );
    tasks.hub.publish({
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'screen' },
      payload: {
        agendaIndex: 0,
        openQuestions: [],
        elapsedSeconds: 60,
        speakerTalkSeconds: {},
        ended: true,
      },
    });

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'the real meeting minutes task');
    expect(minutesTask.status).toBe('DRAFT_READY');
    expect(minutesTask.draft?.body).toContain('- Off the record 10:05–10:06');
  });

  it('drafts the minutes even when the meeting closed with an empty transcript', async () => {
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    // Nobody said a word before the closing: the minutes still exist (agenda, tasks, questions).
    tasks.hub.publish({
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
    });

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.status).toBe('DRAFT_READY');
    expect(minutesTask.draft?.subject).toBe('Lunch service readiness — Meeting Minutes');
    expect(minutesTask.draft?.body).not.toContain('Discussion Transcript');
  });

  it('drafts the minutes for review even when the wiki is not configured', async () => {
    const tasks = setup(
      { llm: createFakeLlm(() => reply), minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.status).toBe('DRAFT_READY');
    expect(minutesTask.assignee).toBe('cashier');
  });

  it('records a cut then resumed line once in the minutes', async () => {
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    const line = 'We decided to cap the oven at 200C.';
    const timestamp = '2026-11-03T10:00:00Z';
    tasks.hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: 'Mei (Chef)', text: line, timestamp, lineId: 'line-1' },
    });
    // A cut and a restore are display-only; the minutes must not read them as new spoken lines.
    tasks.hub.publish({
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: { lineId: 'line-1', speaker: 'Mei (Chef)', text: 'We decided to cap', timestamp, cut: true },
    });
    tasks.hub.publish({
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: { lineId: 'line-1', speaker: 'Mei (Chef)', text: line, timestamp, cut: false },
    });
    tasks.hub.publish({
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
    });

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.draft?.body).toEqual(
      buildMeetingMinutes(testScenario, '2026-11-03', [{ speaker: 'Mei (Chef)', text: line }], [], []),
    );
    expect(minutesTask.draft?.body.match(/We decided to cap the oven/g)).toHaveLength(1);
  });

  it('publishes the approved minutes once and completes the task with the URL', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, minutesDelayMs: 10, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);

    const ready = await waitFor(
      () => {
        const task = minutesTaskIn(tasks);
        return task?.status === 'DRAFT_READY' ? task : undefined;
      },
      'end-of-meeting minutes task to be DRAFT_READY',
    );
    tasks.handleCommand({ type: 'APPROVE_ACTION', taskId: ready.id, draft: ready.draft! }, roleAudience('cashier'));
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(done.artifactUrl).toMatch(/^http:\/\/wiki\.test\/en\/meetings\/2026-11-03-/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const createCalls = fetchImpl.mock.calls.filter(([, init]) =>
      JSON.parse(String(init?.body)).query.includes('Create'),
    );
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0]![1]?.body)).variables.content).toContain(
      'We decided to cap the oven at 200C.',
    );
  });

  it('never assigns minutes to an AI seat and prefers the owner seat when a person holds it', async () => {
    const scenario: Scenario = {
      ...testScenario,
      roles: [
        { id: 'ai_bot', label: 'AI Bot' },
        { id: 'owner', label: 'Owner', facilitator: true },
        { id: 'guest', label: 'Guest' },
      ],
      attendees: [
        { name: 'Bot', role: 'ai_bot', displayName: 'Bot' },
        { name: 'Ola', role: 'owner', displayName: 'Ola (Owner)' },
        { name: 'Gil', role: 'guest', displayName: 'Gil (Guest)' },
      ],
      agenda: [{ ...testScenario.agenda[0]!, ownerRole: 'owner' }],
      npcs: [
        {
          attendee: 'Bot',
          voice: 'en-US-TestNeural',
          personality: 'A stand-in played by the AI.',
          agenda: 'Do as the team does.',
          concerns: [],
          playable: false,
        },
      ],
    };
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10 },
      false,
      {
        scenario,
        seats: [
          { name: 'Bot', seat: 'ai_bot' },
          { name: 'Gil', seat: 'guest' },
          { name: 'Ola', seat: 'owner' },
        ],
      },
    );
    publishClosing(tasks.hub);

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.assignee).toBe('owner');
  });

  it('titles the minutes from the running meeting, not the startup scenario', async () => {
    const running: Scenario = {
      ...testScenario,
      meetingTitle: 'Owner sync',
    };
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10 },
      false,
      { activeScenario: running, seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);

    const minutesTask = await waitFor(() => minutesTaskIn(tasks), 'end-of-meeting minutes task');
    expect(minutesTask.assignee).toBe('cashier');
    expect(minutesTask.draft?.subject).toBe('Owner sync — Meeting Minutes');
  });

  it('creates no minutes when no person holds a seat to approve them', async () => {
    const tasks = setup({ llm: createFakeLlm(() => reply), wiki: settings, fetchImpl: wikiFetch(), minutesDelayMs: 10 });
    publishClosing(tasks.hub);

    await new Promise((resolve) => setTimeout(resolve, 100));
    // Never assign the card to a role nobody holds: that assignee could not approve it.
    expect(minutesTaskIn(tasks)).toBeUndefined();
  });

  it('creates nothing when the meeting resets before the delay', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, minutesDelayMs: 40, today: () => '2026-11-03' },
      false,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);
    tasks.hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId: 'next-meeting' } });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(minutesTaskIn(tasks)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still drafts a wiki task in draftOnly mode without publishing', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, today: () => '2026-11-03' },
      true,
    );
    const task = startTask(tasks);
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft?.subject).toBe('Launch notes');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drafts end-of-meeting minutes for review in draftOnly mode without publishing', async () => {
    const fetchImpl = wikiFetch();
    const tasks = setup(
      { llm: createFakeLlm(() => reply), wiki: settings, fetchImpl, minutesDelayMs: 10, today: () => '2026-11-03' },
      true,
      { seats: [{ name: 'Bao', seat: 'cashier' }] },
    );
    publishClosing(tasks.hub);

    const minutesTask = await waitFor(
      () => {
        const task = minutesTaskIn(tasks);
        return task?.status === 'DRAFT_READY' ? task : undefined;
      },
      'end-of-meeting minutes task to be DRAFT_READY',
    );
    expect(minutesTask.assignee).toBe('cashier');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
