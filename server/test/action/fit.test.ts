import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Scenario, Task } from '@kaki/shared';
import { createFitModule, connectedKinds } from '../../src/action/fit';
import { createActionModule } from '../../src/action/runner';
import { roleAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { KakiContext } from '../../src/core/modules';
import { createFakeLlm, LlmError } from '../../src/services/llm';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import type { WorkspaceTools } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { settle, waitFor } from '../helpers';

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

const allTools: WorkspaceTools = {
  mattermost: { url: 'http://mm.test', token: 't', team: 'team', channel: 'general' },
  gitea: { url: 'http://gitea.test', token: 't', owner: 'owner', repo: 'repo' },
  wiki: { url: 'http://wiki.test', email: 'a@b.test', password: 'pw' },
  email: { smtpHost: 'smtp.test', smtpPort: 1025, from: 'kaki@test', mailpitUrl: 'http://mail.test' },
  calendar: { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://cal.test' },
  readOnly: false,
};

function setup(options: {
  tools?: WorkspaceTools;
  reply?: () => string | Promise<string>;
  fail?: boolean;
  workspaceId?: string;
  meetingKind?: 'real' | 'practice';
  scenario?: Scenario;
} = {}): TaskStore & { llm: ReturnType<typeof createFakeLlm> | undefined } {
  const hub = quietHub();
  const scenario = options.scenario ?? testScenario;
  const tasks = createTaskStore({ hub, scenario });
  const llm =
    options.fail === true
      ? createFakeLlm(() => {
          throw new LlmError('model is down');
        })
      : options.reply === undefined
        ? undefined
        : createFakeLlm(options.reply);
  const context = {
    hub,
    tasks,
    activeScenario: () => scenario,
    meetingId: () => 'meeting',
    workspaceId: () => options.workspaceId ?? 'workspace-1',
    ...(options.tools === undefined ? {} : { tools: async () => options.tools! }),
    meetingKind: () => options.meetingKind ?? 'real',
  } as KakiContext;
  const stop = createFitModule({ llm, timeoutMs: 500 }).start(context);
  if (stop !== undefined) stops.push(stop);
  return Object.assign(tasks, { llm });
}

function suggest(tasks: TaskStore, title: string, context: string, assignee = 'chef'): Task {
  return tasks.suggest({ title, context, suggestedAssignee: assignee });
}

function ready(tasks: TaskStore, id: string): Promise<Task> {
  return waitFor(
    () => {
      const task = tasks.get(id);
      return task?.fit !== undefined ? task : undefined;
    },
    `fit on ${id}`,
  );
}

describe('action fit', () => {
  it.each<[ActionKind, string, string]>([
    ['mattermost_post', 'Post the new rota in the team channel', 'Announce the rota change.'],
    ['gitea_issue', 'Open an issue for the broken signup form', 'The form fails at submit.'],
    ['wiki_page', 'Update the opening-hours page', 'The page says 9am, it is now 8am.'],
  ])('keeps a ready %s when the model says the tool fits', async (kind, title, context) => {
    const tools = allTools;
    const tasks = setup({ tools, reply: () => JSON.stringify({ kind, reason: 'The deliverable is made by this tool.' }) });
    const task = suggest(tasks, title, context);

    const judged = await ready(tasks, task.id);

    expect(judged.fit).toEqual({ status: 'ready', kind, reason: 'The deliverable is made by this tool.' });
    expect(judged.actionKind).toBe(kind);
    expect(tasks.llm?.calls).toHaveLength(1);
    expect(tasks.llm?.calls[0]?.map((message) => message.content).join('\n')).toContain(title);
  });

  it.each<[string, string]>([
    ['Think about pricing', 'No deliverable yet.'],
    ['Call the supplier', 'A phone call, not a message.'],
    ['Decide the budget', 'A judgement for the team.'],
  ])('answers none for a to-do no tool makes: %s', async (title, context) => {
    const tasks = setup({ tools: allTools, reply: () => JSON.stringify({ kind: 'none', reason: 'No tool makes this.' }) });
    const task = suggest(tasks, title, context);

    const judged = await ready(tasks, task.id);

    expect(judged.fit).toEqual({ status: 'none', reason: 'No tool makes this.' });
    expect(judged.actionKind).toBeUndefined();
    expect(tasks.llm?.calls).toHaveLength(1);
  });

  it('answers none without calling the model when no tool is connected', async () => {
    const tasks = setup({
      tools: { readOnly: false },
      reply: () => JSON.stringify({ kind: 'mattermost_post', reason: 'A chat message.' }),
    });
    const task = suggest(tasks, 'Post the new rota', 'Announce it.');

    const judged = await ready(tasks, task.id);

    expect(judged.fit?.status).toBe('none');
    expect(tasks.llm?.calls).toHaveLength(0);
  });

  it('surfaces a model failure as a visible error, never a silent none', async () => {
    const tasks = setup({ tools: allTools, fail: true });
    const task = suggest(tasks, 'Post the new rota', 'Announce it.');

    const judged = await ready(tasks, task.id);

    expect(judged.fit?.status).toBe('error');
    expect(judged.fit?.reason).toContain('model is down');
    expect(judged.actionKind).toBeUndefined();
  });

  it('blocks a to-do that carries credentials without calling the model', async () => {
    const tasks = setup({ tools: allTools, reply: () => JSON.stringify({ kind: 'mattermost_post', reason: 'Chat.' }) });
    const task = suggest(tasks, 'Post the wifi password', 'The wifi password is hunter2.');

    const judged = await ready(tasks, task.id);

    expect(judged.fit?.status).toBe('none');
    expect(judged.fit?.reason).toMatch(/passwords or tokens/i);
    expect(tasks.llm?.calls).toHaveLength(0);
  });

  it('never overwrites a task that moved on while the model was thinking', async () => {
    let release!: (reply: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const tasks = setup({ tools: allTools, reply: () => pending });
    const task = suggest(tasks, 'Post the new rota', 'Announce it.');
    await waitFor(() => (tasks.llm?.calls.length === 1 ? true : undefined), 'the model call');

    // The task is accepted and assigned before the slow judgement returns.
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    release(JSON.stringify({ kind: 'mattermost_post', reason: 'Chat.' }));
    await settle(30);

    expect(tasks.get(task.id)?.fit).toBeUndefined();
    expect(tasks.get(task.id)?.status).toBe('DISPATCHED');
  });

  it('judges the sample workspace’s built-in tools in a real meeting too', async () => {
    const tasks = setup({
      tools: allTools,
      workspaceId: SAMPLE_WORKSPACE_ID,
      meetingKind: 'real',
      reply: () => JSON.stringify({ kind: 'mattermost_post', reason: 'Chat.' }),
    });
    const task = suggest(tasks, 'Post the new rota', 'Announce it.');

    const judged = await ready(tasks, task.id);

    expect(judged.fit?.status).toBe('ready');
    expect(tasks.llm?.calls).toHaveLength(1);
  });

  it('refuses “Do it for me” when the cached fit is not ready, with a plain error', () => {
    const tasks = setup({ tools: { readOnly: false }, reply: () => JSON.stringify({ kind: 'none', reason: 'No tool.' }) });
    const task = suggest(tasks, 'Think about pricing', 'No deliverable.');
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    tasks.setActionFit(task.id, { status: 'none', reason: 'No tool fits.' });

    expect(() =>
      tasks.handleCommand({ type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' }, roleAudience('chef')),
    ).toThrow(/found no connected tool/i);
    expect(tasks.get(task.id)?.status).toBe('DISPATCHED');
  });

  it('runs only the action module whose kind the fit chose', async () => {
    const hub = quietHub();
    const tasks = createTaskStore({ hub, scenario: testScenario });
    const runSpy = vi.fn(async () => 'http://artifact.test/item');
    const stop = createActionModule({
      name: 'action-wiki-only',
      kind: 'wiki_page',
      draft: async () => ({ target: 'Wiki', subject: 'Page', body: 'Body' }),
      run: runSpy,
    }).start({
      hub,
      tasks,
      activeScenario: () => testScenario,
      meetingId: () => 'meeting',
      workspaceId: () => 'workspace-1',
    });
    if (stop !== undefined) stops.push(stop);

    const task = tasks.suggest({
      title: 'Open an issue for the broken signup form',
      context: 'The form fails at submit.',
      suggestedAssignee: 'chef',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    tasks.setActionFit(task.id, { status: 'ready', kind: 'gitea_issue', reason: 'An issue tracker item.' });
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    await settle(30);

    expect(tasks.get(task.id)?.status).toBe('CLAIMED');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('lists only the connected tool kinds', () => {
    expect(connectedKinds(undefined)).toEqual([]);
    expect(connectedKinds({ readOnly: false })).toEqual([]);
    expect(connectedKinds(allTools)).toEqual([
      'mattermost_post',
      'gitea_issue',
      'wiki_page',
      'email',
      'calendar_event',
    ]);
  });
});
