import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import {
  createMattermostModule,
  type MattermostModuleOptions,
  type MattermostSettings,
} from '../../src/action/mattermost';
import type { Hub } from '../../src/core/hub';
import { createFakeLlm, LlmError, type LlmClient } from '../../src/services/llm';
import { createTaskStore, type TaskStore } from '../../src/meeting/tasks';
import { testScenario } from '../fixtures/scenario';
import { settle, waitFor } from '../helpers';

const settings: MattermostSettings = {
  url: 'http://mattermost.test',
  token: 'secret-token',
  team: 'kopitiam',
  channel: 'launch',
};

const channelId = 'channel-123';
const postId = 'post-456';

const messageReply = JSON.stringify({ message: 'The oven is fixed.' });

const stops: Array<() => void> = [];

afterEach(() => {
  stopAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function setup(options: MattermostModuleOptions, scenario = testScenario): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario });
  const stop = createMattermostModule(options).start({ hub, tasks, activeScenario: () => scenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'mattermost_post', sourceSeconds?: number): Task {
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

async function claim(tasks: TaskStore, task: Task): Promise<Task> {
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  return waitForStatus(tasks, task.id, 'DRAFT_READY');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okFetch(channel = 'launch') {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (
      method === 'GET' &&
      url === `http://mattermost.test/api/v4/teams/name/kopitiam/channels/name/${channel}`
    ) {
      return jsonResponse({ id: channelId });
    }
    if (method === 'POST' && url === 'http://mattermost.test/api/v4/posts') {
      return jsonResponse({ id: postId }, 201);
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
}

describe('mattermost action module', () => {
  it('drafts a message on claim without posting anything', async () => {
    const llm = createFakeLlm(() => messageReply);
    const fetchImpl = okFetch();
    const tasks = setup({ llm, mattermost: settings, fetchImpl });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.draft).toEqual({
      target: '#launch',
      subject: 'Fix the oven',
      body: 'The oven is fixed.',
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.map((message) => message.content).join('\n')).toContain(
      'The oven trips the fuse after ten minutes.',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a draft that invents a time the task does not support', async () => {
    const tasks = setup({
      llm: createFakeLlm(() => JSON.stringify({ message: 'The booth rule runs from 8 PM to 10:30 PM.' })),
      mattermost: settings,
      fetchImpl: okFetch(),
    });
    const task = tasks.suggest({
      title: 'Post the booth rule',
      context: 'The booth rule runs from 8 to 10:30 every morning.',
      suggestedAssignee: 'chef',
      actionKind: 'mattermost_post',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    expect(failed.error).toMatch(/8 PM/);
    expect(failed.error).toMatch(/does not support/);
    expect(failed.draft).toBeUndefined();
  });

  it('posts the approved draft on run and records the post URL', async () => {
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks, 'mattermost_post', 930);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(completed.artifactUrl).toBe('http://mattermost.test/kopitiam/pl/post-456');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [lookupCall, postCall] = fetchImpl.mock.calls;
    if (lookupCall === undefined || postCall === undefined) throw new Error('Expected two Mattermost requests');

    const [lookupUrl, lookupInit] = lookupCall;
    expect(String(lookupUrl)).toBe(
      'http://mattermost.test/api/v4/teams/name/kopitiam/channels/name/launch',
    );
    expect(lookupInit?.method).toBe('GET');
    expect(lookupInit?.headers).toMatchObject({ authorization: 'Bearer secret-token' });

    const [postUrl, postInit] = postCall;
    expect(String(postUrl)).toBe('http://mattermost.test/api/v4/posts');
    expect(postInit?.method).toBe('POST');
    expect(postInit?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(postInit?.body))).toEqual({
      channel_id: channelId,
      message: 'The oven is fixed.\n\nGenerated by Kaki at [15:30] in Lunch service readiness.',
    });
  });

  function visitorTask(tasks: TaskStore, speaker: string): Task {
    const input = {
      title: 'Fix the oven', context: 'The oven trips the fuse after ten minutes.',
      suggestedAssignee: 'chef' as const, actionKind: 'mattermost_post' as const,
    };
    const task = tasks.suggest(input, {
      speaker,
      quote: 'I will take the oven fix.',
      scope: { title: input.title, context: input.context, actionKind: input.actionKind },
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    return task;
  }

  function identityFetch(account: string): {
    fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
    logins: string[];
  } {
    const logins: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/teams/name/kopitiam/channels/name/launch')) return jsonResponse({ id: channelId });
      if (method === 'POST' && url.endsWith('/users/login')) {
        const loginId = (JSON.parse(String(init?.body)) as { login_id: string }).login_id;
        logins.push(loginId);
        return loginId === account
          ? new Response(JSON.stringify({ id: 'visitor-user' }), {
              status: 200, headers: { 'content-type': 'application/json', Token: 'visitor-token' },
            })
          : new Response('unauthorized', { status: 401 });
      }
      if (method === 'PUT' && url.includes('/users/visitor-user/patch')) return jsonResponse({ id: 'visitor-user' });
      if (method === 'PUT' && url.endsWith('/config/patch')) return jsonResponse({ status: 'OK' });
      if (method === 'GET' && url.endsWith('/users/me')) return jsonResponse({ id: 'visitor-user' });
      if (method === 'POST' && url.includes('/channels/') && url.endsWith('/members')) return jsonResponse({ user_id: 'visitor-user' });
      if (method === 'POST' && url.endsWith('/posts')) return jsonResponse({ id: postId }, 201);
      return new Response(`unexpected ${method} ${url}`, { status: 500 });
    });
    return { fetchImpl, logins };
  }

  it('tries the visitor\'s own account before the demo visitor', async () => {
    vi.stubEnv('MATTERMOST_PASSWORD', 'seed-password');
    const { fetchImpl, logins } = identityFetch('mei');
    const ownerScenario = {
      ...testScenario,
      roles: testScenario.roles.map((role) => role.id === 'chef'
        ? { ...role, label: 'Kitchen Lead', card: { youAre: 'The kitchen lead.', facts: [], responsibility: 'Run prep.' } }
        : role),
      attendees: [{ name: 'Ada', role: 'chef' as const, displayName: 'Ada' }],
    };
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl }, ownerScenario);
    const task = visitorTask(tasks, 'Mei');
    const ready = await claim(tasks, task);
    tasks.transition(ready.id, 'RUNNING');
    await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(logins).toContain('mei');
    expect(logins).not.toContain('demo');
    expect(logins).not.toContain('demo@nanyangkopitiam.example');
    const postCall = fetchImpl.mock.calls.find(([input, init]) =>
      String(input).endsWith('/posts') && init?.method === 'POST');
    expect(postCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer visitor-token' });
  });

  it('never falls back to the demo visitor when an owner meeting has no pack role card', async () => {
    vi.stubEnv('MATTERMOST_PASSWORD', 'seed-password');
    const { fetchImpl, logins } = identityFetch('mei');
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = visitorTask(tasks, 'Mei');
    const ready = await claim(tasks, task);
    tasks.transition(ready.id, 'RUNNING');
    await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(logins).toContain('mei');
    expect(logins).not.toContain('demo');
    expect(logins).not.toContain('demo@nanyangkopitiam.example');
  });

  it.each([
    ['with a leading #', '#ops'],
    ['without a leading #', 'ops'],
  ])('uses an edited target channel %s', async (_label, target) => {
    const fetchImpl = okFetch('ops');
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);
    if (ready.draft === undefined) throw new Error('Expected a draft');

    tasks.transition(ready.id, 'RUNNING', { draft: { ...ready.draft, target } });
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(completed.artifactUrl).toBe('http://mattermost.test/kopitiam/pl/post-456');
    const [lookupCall, postCall] = fetchImpl.mock.calls;
    if (lookupCall === undefined || postCall === undefined) throw new Error('Expected two Mattermost requests');
    expect(String(lookupCall[0])).toBe(
      'http://mattermost.test/api/v4/teams/name/kopitiam/channels/name/ops',
    );
    expect(JSON.parse(String(postCall[1]?.body))).toEqual({
      channel_id: channelId,
      message: 'The oven is fixed.\n\nGenerated by Kaki in Lunch service readiness.',
    });
  });

  it('fails when the edited target channel is empty', async () => {
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);
    if (ready.draft === undefined) throw new Error('Expected a draft');

    tasks.transition(ready.id, 'RUNNING', { draft: { ...ready.draft, target: '#' } });
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');

    expect(failed.error).toMatch(/channel is empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when the channel does not exist', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('team not found', { status: 404 }));
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');

    expect(failed.error).toMatch(/channel not found/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails on bad credentials, then completes a retry with the same draft', async () => {
    const fetchImpl = okFetch();
    fetchImpl.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/bad credentials/i);

    tasks.transition(failed.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(completed.artifactUrl).toBe('http://mattermost.test/kopitiam/pl/post-456');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('includes the status and a short body for other Mattermost errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('channel is archived', { status: 400 }));
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toContain('400');
    expect(failed.error).toContain('channel is archived');
  });

  it('explains a 403 as a missing permission, not bad credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/lacks permission/i);
    expect(failed.error).not.toMatch(/bad credentials/i);
  });

  it('accepts an LLM reply wrapped in a code fence', async () => {
    const tasks = setup({
      llm: createFakeLlm(() => `\`\`\`json\n${messageReply}\n\`\`\``),
      mattermost: settings,
      fetchImpl: okFetch(),
    });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);
    expect(ready.draft?.body).toBeTruthy();
  });

  it('drafts again when a retry follows a failed draft', async () => {
    let calls = 0;
    const llm = createFakeLlm(() => {
      calls += 1;
      if (calls === 1) throw new LlmError('gateway down');
      return messageReply;
    });
    const tasks = setup({ llm, mattermost: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    // A retry with no draft claims the task again (see the RETRY_ACTION command).
    tasks.transition(failed.id, 'CLAIMED');
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft).toBeDefined();
  });

  it('fails when Mattermost times out', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });
    const tasks = setup({
      llm: createFakeLlm(() => messageReply),
      mattermost: settings,
      fetchImpl,
      timeoutMs: 25,
    });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/timed out/i);
  });

  it('fails when Mattermost cannot be reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/could not reach Mattermost/i);
  });

  it('fails when Mattermost replies without a post id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET') return jsonResponse({ id: channelId });
      if (url === 'http://mattermost.test/api/v4/posts') return jsonResponse({}, 201);
      return new Response('unexpected', { status: 500 });
    });
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/without a post id/i);
  });

  it('fails when the LLM errors', async () => {
    const fetchImpl = okFetch();
    const llm = createFakeLlm(() => {
      throw new LlmError('gateway down');
    });
    const tasks = setup({ llm, mattermost: settings, fetchImpl });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/gateway down/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['no message', JSON.stringify({ title: 'Only a title' })],
  ])('fails when the LLM reply has %s', async (_label, reply) => {
    const tasks = setup({ llm: createFakeLlm(() => reply), mattermost: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/usable JSON/i);
  });

  it('fails loudly when Mattermost is not configured on claim or retry', async () => {
    const tasks = setup({ llm: createFakeLlm(() => messageReply), mattermost: undefined });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/Mattermost is not configured/);

    tasks.transition(failed.id, 'RUNNING');
    const retried = await waitForStatus(tasks, task.id, 'FAILED');
    expect(retried.error).toMatch(/Mattermost is not configured/);
  });

  it('fails loudly when the LLM is not configured', async () => {
    const tasks = setup({ mattermost: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/LLM is not configured/);
  });

  it('drops a draft result when the task changed while the LLM was working', async () => {
    const pending = deferred<string>();
    const llm: LlmClient = { complete: () => pending.promise };
    const tasks = setup({ llm, mattermost: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    tasks.transition(task.id, 'FAILED', { error: 'changed elsewhere' });
    pending.resolve(messageReply);
    await settle(20);

    const current = tasks.get(task.id);
    expect(current?.status).toBe('FAILED');
    expect(current?.error).toBe('changed elsewhere');
    expect(current?.draft).toBeUndefined();
  });

  it('keeps the visitor in the decision source without naming the default scenario seat as the sender', async () => {
    const scenarioWithFacts = {
      ...testScenario,
      roles: testScenario.roles.map((role) =>
        role.id === 'chef'
          ? {
              ...role,
              card: {
                youAre: 'You run the kitchen.',
                facts: ['The booth demo runs on generator power.', 'The pastry oven needs a new fuse.'],
                responsibility: 'Kitchen readiness.',
              },
            }
          : role,
      ),
      agenda: [
        { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef', seatFacts: { chef: 'The booth demo runs on generator power.' } },
        { title: 'Oven', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef', seatFacts: { chef: 'The pastry oven needs a new fuse.' } },
      ],
    };
    const decision = 'Booth Playtest approved the booth demo: it runs from 9 to 11 AM and the Chef owns setup.';
    const llm = createFakeLlm(() => messageReply);
    const fetchImpl = okFetch();
    const tasks = setup({ llm, mattermost: settings, fetchImpl }, scenarioWithFacts);
    const task = tasks.suggest({
      title: 'Announce the booth demo decision',
      context: 'Booth Playtest approved the booth demo plan for the launch.',
      suggestedAssignee: 'chef',
      actionKind: 'mattermost_post',
      decisionSource: decision,
      agendaItemTitle: 'Prep',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    const ready = await claim(tasks, task);
    expect(ready.status).toBe('DRAFT_READY');
    expect(fetchImpl).not.toHaveBeenCalled();

    const prompt = llm.calls[0]?.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain(decision);
    expect(prompt).toContain('The booth demo runs on generator power.');
    expect(prompt).not.toContain('The pastry oven needs a new fuse.');
    expect(prompt).toContain('Chef');
    expect(prompt).not.toContain('Sender: Ada');
    expect(prompt).not.toContain('Known facts from Ada');
  });

  it('ignores other action kinds and manual tasks', async () => {
    const llm = createFakeLlm(() => messageReply);
    const fetchImpl = okFetch();
    const tasks = setup({ llm, mattermost: settings, fetchImpl });

    const email = startTask(tasks, 'email');
    tasks.transition(email.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const gitea = startTask(tasks, 'gitea_issue');
    tasks.transition(gitea.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const manual = startTask(tasks, 'mattermost_post');
    tasks.transition(manual.id, 'CLAIMED', { mode: 'MANUAL' });
    await settle(20);

    expect(tasks.get(email.id)?.status).toBe('CLAIMED');
    expect(tasks.get(gitea.id)?.status).toBe('CLAIMED');
    expect(tasks.get(manual.id)?.status).toBe('CLAIMED');
    expect(llm.calls).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
