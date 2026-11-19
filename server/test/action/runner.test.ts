import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionDraft, KakiEvent, Task } from '@kaki/shared';
import { createActionModule } from '../../src/action/runner';
import type { Hub } from '../../src/hub';
import { createTaskStore, type TaskStore } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';

const stops: Array<() => void> = [];
const draft: ActionDraft = { target: 'Team wiki', subject: 'Launch notes', body: '- Build is due 20 Nov' };

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

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

function setup(draftOnly?: boolean, unconfiguredReason?: string) {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const draftSpy = vi.fn(async () => draft);
  const runSpy = vi.fn(async () => 'http://artifact.test/page');
  const stop = createActionModule({
    name: 'action-test',
    kind: 'wiki_page',
    draft: draftSpy,
    run: runSpy,
    ...(unconfiguredReason === undefined ? {} : { unconfiguredReason }),
  }).start({ hub, tasks, scenario: testScenario, draftOnly });
  if (stop !== undefined) stops.push(stop);
  return { tasks, draftSpy, runSpy };
}

function startTask(tasks: TaskStore): Task {
  const task = tasks.suggest({
    title: 'Fix the oven',
    context: 'The oven trips the fuse after ten minutes.',
    suggestedAssignee: 'chef',
    actionKind: 'wiki_page',
  });
  tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  return task;
}

function waitForStatus(tasks: TaskStore, id: string, status: Task['status']): Promise<Task> {
  return waitFor(
    () => {
      const task = tasks.get(id);
      return task?.status === status ? task : undefined;
    },
    `task ${id} to be ${status}`,
  );
}

describe('action runner draft-only guard', () => {
  it('still drafts a task in draftOnly mode', async () => {
    const { tasks, draftSpy, runSpy } = setup(true);
    const task = startTask(tasks);
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft).toEqual(draft);
    expect(draftSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('refuses a direct move to RUNNING before calling run, and records why', async () => {
    const { tasks, runSpy } = setup(true);
    const task = startTask(tasks);
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');

    expect(failed.error).toContain('KAKI_DRAFT_ONLY');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('refuses an approved draft before calling run', async () => {
    const { tasks, runSpy } = setup(true);
    const task = startTask(tasks);
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');

    tasks.handleCommand({ type: 'APPROVE_ACTION', taskId: ready.id, draft: ready.draft! }, 'chef');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');

    expect(failed.error).toContain('KAKI_DRAFT_ONLY');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('refuses a retry that would move back to RUNNING with the existing draft', async () => {
    const { tasks, runSpy } = setup(true);
    const task = startTask(tasks);
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');

    tasks.transition(ready.id, 'RUNNING');
    await waitForStatus(tasks, ready.id, 'FAILED');
    tasks.handleCommand({ type: 'RETRY_ACTION', taskId: ready.id, draft: ready.draft! }, 'chef');
    await waitForStatus(tasks, ready.id, 'FAILED');

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs normally when draftOnly is off', async () => {
    const { tasks, runSpy } = setup();
    const task = startTask(tasks);
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');

    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(done.artifactUrl).toBe('http://artifact.test/page');
  });
});

describe('action runner prefilled draft guard', () => {
  it('never re-drafts a task that was claimed with a draft already filled in', async () => {
    const { tasks, draftSpy, runSpy } = setup();
    const task = tasks.suggest({
      title: 'Publish meeting minutes to the team wiki',
      context: 'The end-of-meeting minutes, already written.',
      suggestedAssignee: 'chef',
      actionKind: 'wiki_page',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    tasks.transition(task.id, 'CLAIMED', {
      mode: 'ACTION_AGENT',
      draft: { target: 'Team wiki', subject: 'Meeting minutes', body: '# Minutes' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(tasks.get(task.id)?.draft?.body).toBe('# Minutes');

    const ready = tasks.transition(task.id, 'DRAFT_READY');
    tasks.transition(ready.id, 'RUNNING');
    const done = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(done.artifactUrl).toBe('http://artifact.test/page');
  });
});

describe('action runner unconfigured tool guard', () => {
  it('fails a claimed task before drafting when its tool is not configured', async () => {
    const reason = 'The wiki is not configured: set WIKI_URL, WIKI_ADMIN_EMAIL and WIKI_ADMIN_PASSWORD';
    const { tasks, draftSpy, runSpy } = setup(undefined, reason);
    const task = startTask(tasks);
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    expect(failed.error).toBe(reason);
    expect(draftSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
});
