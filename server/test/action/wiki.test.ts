import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import { createWikiModule, pagePath, type WikiModuleOptions, type WikiSettings } from '../../src/action/wiki';
import type { Hub } from '../../src/hub';
import { createFakeLlm } from '../../src/llm';
import { createTaskStore, type TaskStore } from '../../src/tasks';
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
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

function setup(options: WikiModuleOptions): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = createWikiModule(options).start({ hub, tasks, scenario: testScenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'wiki_page'): Task {
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

async function draftAndRun(tasks: TaskStore): Promise<Task> {
  const task = startTask(tasks);
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
    const ready = await draftAndRun(tasks);
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(done.artifactUrl).toBe('http://wiki.test/en/meetings/2026-11-03-launch-notes');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(failed.error).toContain('WIKI_URL');
  });

  it('builds a safe dated path', () => {
    expect(pagePath('2026-11-03', 'Launch: notes & "plans"!')).toBe('meetings/2026-11-03-launch-notes-plans');
    expect(pagePath('2026-11-03', '???')).toBe('meetings/2026-11-03-notes');
  });
});
