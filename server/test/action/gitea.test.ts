import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import { createGiteaModule, type GiteaModuleOptions, type GiteaSettings } from '../../src/action/gitea';
import type { Hub } from '../../src/hub';
import { createFakeLlm, LlmError, type LlmClient } from '../../src/llm';
import { createTaskStore, type TaskStore } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';
import { settle, waitFor } from '../helpers';

const settings: GiteaSettings = {
  url: 'http://gitea.test',
  token: 'secret-token',
  owner: 'pixel-kampung',
  repo: 'hawker-heroes',
};

const issueUrl = 'http://gitea.test/pixel-kampung/hawker-heroes/issues/7';

const issueReply = JSON.stringify({
  title: 'Fix the oven',
  body: 'The oven trips the fuse after ten minutes.',
});

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

function setup(options: GiteaModuleOptions): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = createGiteaModule(options).start({ hub, tasks, scenario: testScenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'gitea_issue'): Task {
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

async function claim(tasks: TaskStore, task: Task): Promise<Task> {
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  return waitForStatus(tasks, task.id, 'DRAFT_READY');
}

function okFetch(htmlUrl = issueUrl) {
  return vi.fn<typeof fetch>(async () => {
    return new Response(JSON.stringify({ html_url: htmlUrl }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
}

describe('gitea action module', () => {
  it('drafts an issue on claim without posting anything', async () => {
    const llm = createFakeLlm(() => issueReply);
    const fetchImpl = okFetch();
    const tasks = setup({ llm, gitea: settings, fetchImpl });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.draft).toEqual({
      target: 'pixel-kampung/hawker-heroes',
      subject: 'Fix the oven',
      body: 'The oven trips the fuse after ten minutes.',
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.map((message) => message.content).join('\n')).toContain(
      'The oven trips the fuse after ten minutes.',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a JSON reply wrapped in a code fence', async () => {
    const llm = createFakeLlm(() => '```json\n' + issueReply + '\n```');
    const tasks = setup({ llm, gitea: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.draft?.subject).toBe('Fix the oven');
  });

  it('drafts again after a failed draft when the task is retried', async () => {
    const llm = createFakeLlm((_messages, call) => {
      if (call === 0) throw new LlmError('gateway down');
      return issueReply;
    });
    const tasks = setup({ llm, gitea: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.draft).toBeUndefined();

    tasks.handleCommand({ type: 'RETRY_ACTION', taskId: failed.id }, 'chef');
    const ready = await waitForStatus(tasks, failed.id, 'DRAFT_READY');
    expect(ready.draft?.subject).toBe('Fix the oven');

    tasks.transition(ready.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(completed.artifactUrl).toBe(issueUrl);
    expect(llm.calls).toHaveLength(2);
  });

  it('posts the approved draft on run and records the issue URL', async () => {
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(completed.artifactUrl).toBe(issueUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the configured repo, auth header and approved title and body', async () => {
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error('Expected a Gitea request');
    const [url, init] = call;
    expect(String(url)).toBe('http://gitea.test/api/v1/repos/pixel-kampung/hawker-heroes/issues');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'token secret-token' });
    expect(JSON.parse(String(init?.body))).toEqual({
      title: 'Fix the oven',
      body: 'The oven trips the fuse after ten minutes.',
    });
  });

  it('posts an edited draft and ignores draft.target', async () => {
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING', {
      draft: { target: 'someone/elsewhere', subject: 'Edited title', body: 'Edited body' },
    });
    await waitForStatus(tasks, ready.id, 'COMPLETED');

    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error('Expected a Gitea request');
    const [url, init] = call;
    expect(String(url)).toBe('http://gitea.test/api/v1/repos/pixel-kampung/hawker-heroes/issues');
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Edited title', body: 'Edited body' });
  });

  it('fails on bad credentials, then completes a retry with the same draft', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ html_url: issueUrl }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/bad credentials/i);

    tasks.transition(failed.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(completed.artifactUrl).toBe(issueUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('explains a permission failure on 403', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toBe(
      'Gitea token lacks permission to create issues in pixel-kampung/hawker-heroes (HTTP 403)',
    );
  });

  it('includes the status and a short body for other Gitea errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('repository is locked', { status: 423 }));
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toContain('423');
    expect(failed.error).toContain('repository is locked');
  });

  it('fails when Gitea times out', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl, timeoutMs: 25 });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/timed out/i);
    expect(failed.error).toContain('the issue may already exist');
  });

  it('fails when Gitea cannot be reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/could not reach Gitea/i);
  });

  it('fails when Gitea replies without an issue URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toMatch(/without an issue URL/i);
  });

  it('fails when the LLM errors', async () => {
    const fetchImpl = okFetch();
    const llm = createFakeLlm(() => {
      throw new LlmError('gateway down');
    });
    const tasks = setup({ llm, gitea: settings, fetchImpl });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/gateway down/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['no body', JSON.stringify({ title: 'Only a title' })],
  ])('fails when the LLM reply has %s', async (_label, reply) => {
    const tasks = setup({ llm: createFakeLlm(() => reply), gitea: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/usable JSON/i);
  });

  it('fails loudly when Gitea is not configured on claim or retry', async () => {
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: undefined });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/Gitea is not configured/);

    tasks.transition(failed.id, 'RUNNING');
    const retried = await waitForStatus(tasks, task.id, 'FAILED');
    expect(retried.error).toMatch(/Gitea is not configured/);
  });

  it('fails loudly when the LLM is not configured', async () => {
    const tasks = setup({ gitea: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/LLM is not configured/);
  });

  it('drops a draft result when the task changed while the LLM was working', async () => {
    const pending = deferred<string>();
    const llm: LlmClient = { complete: () => pending.promise };
    const tasks = setup({ llm, gitea: settings, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    tasks.transition(task.id, 'FAILED', { error: 'changed elsewhere' });
    pending.resolve(issueReply);
    await settle(20);

    const current = tasks.get(task.id);
    expect(current?.status).toBe('FAILED');
    expect(current?.error).toBe('changed elsewhere');
    expect(current?.draft).toBeUndefined();
  });

  it('drops a POST result when the task changed while Gitea was working', async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => pending.promise);
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    tasks.transition(ready.id, 'FAILED', { error: 'cancelled' });
    pending.resolve(new Response(JSON.stringify({ html_url: issueUrl }), { status: 201 }));
    await settle(20);

    const current = tasks.get(ready.id);
    expect(current?.status).toBe('FAILED');
    expect(current?.error).toBe('cancelled');
    expect(current?.artifactUrl).toBeUndefined();
  });

  it('aborts in-flight work on shutdown without failing the task', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });
    const tasks = setup({ llm: createFakeLlm(() => issueReply), gitea: settings, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    stopAll();
    await settle(20);

    expect(tasks.get(ready.id)?.status).toBe('RUNNING');
  });

  it('ignores other action kinds and manual tasks', async () => {
    const llm = createFakeLlm(() => issueReply);
    const fetchImpl = okFetch();
    const tasks = setup({ llm, gitea: settings, fetchImpl });

    const email = startTask(tasks, 'email');
    tasks.transition(email.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const manual = startTask(tasks, 'gitea_issue');
    tasks.transition(manual.id, 'CLAIMED', { mode: 'MANUAL' });
    await settle(20);

    expect(tasks.get(email.id)?.status).toBe('CLAIMED');
    expect(tasks.get(manual.id)?.status).toBe('CLAIMED');
    expect(llm.calls).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
