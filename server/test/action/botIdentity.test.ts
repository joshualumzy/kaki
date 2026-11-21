import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import { createGiteaModule } from '../../src/action/gitea';
import { createMattermostModule } from '../../src/action/mattermost';
import type { Hub } from '../../src/core/hub';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import { createFakeLlm } from '../../src/services/llm';
import type { WorkspaceTools } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { waitFor } from '../helpers';

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

function setup(module: ReturnType<typeof createMattermostModule>, tools: WorkspaceTools): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = module.start({
    meetingId: () => 'meeting',
    workspaceId: () => 'workspace-real',
    tools: async () => tools,
    hub,
    tasks,
    activeScenario: () => testScenario,
  });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind): Task {
  const task = tasks.suggest({
    title: 'Fix the oven',
    context: 'The oven trips the fuse after ten minutes.',
    suggestedAssignee: 'chef',
    actionKind,
  });
  tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
  return task;
}

async function run(tasks: TaskStore, task: Task): Promise<Task> {
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  const ready = await waitFor(
    () => (tasks.get(task.id)?.status === 'DRAFT_READY' ? tasks.get(task.id) : undefined),
    'the draft',
  );
  tasks.transition(ready.id, 'RUNNING');
  return waitFor(
    () => (tasks.get(task.id)?.status === 'COMPLETED' ? tasks.get(task.id) : undefined),
    'the completed action',
  );
}

describe('action identity', () => {
  it('posts to Mattermost as the one workspace bot, never by guessing a person login', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith('/channels/name/launch')) {
        return Response.json({ id: 'channel-1' });
      }
      if (init?.method === 'POST' && url.endsWith('/api/v4/posts')) {
        return Response.json({ id: 'post-1' }, { status: 201 });
      }
      return new Response(`unexpected ${init?.method ?? 'GET'} ${url}`, { status: 500 });
    });
    const tools: WorkspaceTools = {
      readOnly: false,
      mattermost: {
        url: 'http://mattermost.test',
        token: 'bot-token',
        team: 'kopitiam',
        channel: 'launch',
      },
    };
    const tasks = setup(
      createMattermostModule({
        llm: createFakeLlm(() => JSON.stringify({ message: 'The oven is fixed.' })),
        fetchImpl,
      }),
      tools,
    );
    const task = startTask(tasks, 'mattermost_post');
    await run(tasks, task);

    const urls = fetchImpl.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('/users/login'))).toBe(false);
    expect(urls.some((url) => url.includes('/config/patch'))).toBe(false);
    expect(urls.some((url) => url.includes('/users/me'))).toBe(false);
    const post = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST' && String(init.body).includes('channel_id'));
    expect(post?.[1]?.headers).toMatchObject({ authorization: 'Bearer bot-token' });
  });

  it('creates a Gitea issue as the workspace bot, with no Sudo header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ html_url: 'http://gitea.test/kopitiam/pos/issues/7' }, { status: 201 }),
    );
    const tools: WorkspaceTools = {
      readOnly: false,
      gitea: { url: 'http://gitea.test', token: 'bot-token', owner: 'kopitiam', repo: 'pos' },
    };
    const tasks = setup(
      createGiteaModule({
        llm: createFakeLlm(() => JSON.stringify({ title: 'Fix the oven', body: 'Trip after ten minutes.' })),
        fetchImpl,
      }),
      tools,
    );
    const task = startTask(tasks, 'gitea_issue');
    await run(tasks, task);

    const [request] = fetchImpl.mock.calls;
    expect(request?.[1]?.headers).toMatchObject({ authorization: 'token bot-token' });
    expect(request?.[1]?.headers).not.toHaveProperty('Sudo');
  });
});
