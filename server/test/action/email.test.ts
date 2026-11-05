import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, KakiEvent, Task } from '@kaki/shared';
import {
  createEmailModule,
  type EmailModuleOptions,
  type EmailSettings,
  type SendMail,
} from '../../src/action/email';
import type { Hub } from '../../src/hub';
import { createFakeLlm, LlmError, type LlmClient } from '../../src/llm';
import { createTaskStore, type TaskStore } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';
import { settle, waitFor } from '../helpers';

const settings: EmailSettings = {
  smtpHost: '127.0.0.1',
  smtpPort: 1025,
  from: 'kaki@pixelkampung.example',
  mailpitUrl: 'http://mailpit.test',
};

const messageId = 'message-123';

const draftReply = JSON.stringify({
  to: 'supplier@example.com',
  subject: 'Fix the oven',
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
    clearRetained: () => {},
    close: () => {},
  };
}

function setup(options: EmailModuleOptions): TaskStore {
  const hub = quietHub();
  const tasks = createTaskStore({ hub, scenario: testScenario });
  const stop = createEmailModule(options).start({ hub, tasks, scenario: testScenario });
  if (stop !== undefined) stops.push(stop);
  return tasks;
}

function startTask(tasks: TaskStore, actionKind: ActionKind = 'email'): Task {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function okSend(): ReturnType<typeof vi.fn<SendMail>> {
  return vi.fn<SendMail>(async () => ({}));
}

function okFetch(messages: unknown[] = [{ ID: messageId }]) {
  return vi.fn<typeof fetch>(async () => jsonResponse({ messages }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settlePromise) => {
    resolve = settlePromise;
  });
  return { promise, resolve };
}

describe('email action module', () => {
  it('drafts an email on claim without sending anything', async () => {
    const llm = createFakeLlm(() => draftReply);
    const sendMail = okSend();
    const fetchImpl = okFetch();
    const tasks = setup({ llm, email: settings, sendMail, fetchImpl });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.draft).toEqual({
      target: 'supplier@example.com',
      subject: 'Fix the oven',
      body: 'The oven trips the fuse after ten minutes.',
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.map((message) => message.content).join('\n')).toContain(
      'The oven trips the fuse after ten minutes.',
    );
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', JSON.stringify({ subject: 'Fix the oven', body: 'The oven is fixed.' })],
    ['empty', JSON.stringify({ to: '', subject: 'Fix the oven', body: 'The oven is fixed.' })],
    ['not an address', JSON.stringify({ to: 'supplier', subject: 'Fix the oven', body: 'The oven is fixed.' })],
    ['two @ signs', JSON.stringify({ to: 'a@b@example.com', subject: 'Fix the oven', body: 'The oven is fixed.' })],
    ['with spaces', JSON.stringify({ to: 'two words@example.com', subject: 'Fix the oven', body: 'The oven is fixed.' })],
  ])('keeps an empty target when the LLM address is %s', async (_label, reply) => {
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      email: settings,
      sendMail: okSend(),
      fetchImpl: okFetch(),
    });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.draft?.target).toBe('');
    expect(ready.draft?.subject).toBe('Fix the oven');
    expect(ready.draft?.body).toBe('The oven is fixed.');
  });

  it('sends the approved draft on run and links to the Mailpit view', async () => {
    const sendMail = okSend();
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => draftReply), email: settings, sendMail, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(completed.artifactUrl).toBe('http://mailpit.test/view/message-123');
    expect(sendMail).toHaveBeenCalledTimes(1);

    const [sendCall] = sendMail.mock.calls;
    if (sendCall === undefined) throw new Error('Expected the email to be sent');
    const message = sendCall[0];
    expect(message).toEqual({
      from: 'kaki@pixelkampung.example',
      to: ['supplier@example.com'],
      subject: 'Fix the oven',
      text: 'The oven trips the fuse after ten minutes.',
      messageId: expect.stringMatching(/^<kaki-[0-9a-f-]{36}@kaki\.local>$/),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [searchUrl, searchInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(searchUrl)).toBe(
      `http://mailpit.test/api/v1/search?query=message-id:${message.messageId.slice(1, -1)}`,
    );
    expect(searchInit?.method).toBe('GET');
  });

  it('sends nothing before the task is running', async () => {
    const sendMail = okSend();
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => draftReply), email: settings, sendMail, fetchImpl });
    const task = startTask(tasks);

    const ready = await claim(tasks, task);

    expect(ready.status).toBe('DRAFT_READY');
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['one edited address', 'new@example.com', ['new@example.com']],
    ['comma separated', 'a@example.com, b@example.com', ['a@example.com', 'b@example.com']],
    ['semicolon separated', 'a@example.com; b@example.com', ['a@example.com', 'b@example.com']],
    ['mixed with blanks', ' ,a@example.com;; b@example.com, ', ['a@example.com', 'b@example.com']],
  ])('uses %s from the edited draft', async (_label, target, expected) => {
    const sendMail = okSend();
    const tasks = setup({
      llm: createFakeLlm(() => draftReply),
      email: settings,
      sendMail,
      fetchImpl: okFetch(),
    });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);
    if (ready.draft === undefined) throw new Error('Expected a draft');

    tasks.transition(ready.id, 'RUNNING', { draft: { ...ready.draft, target } });
    await waitForStatus(tasks, ready.id, 'COMPLETED');

    const [sendCall] = sendMail.mock.calls;
    if (sendCall === undefined) throw new Error('Expected the email to be sent');
    expect(sendCall[0].to).toEqual(expected);
  });

  it.each([
    ['empty', ''],
    ['blank separators', ' , ; '],
    ['no at sign', 'supplier'],
    ['two at signs', 'a@b@example.com'],
    ['with spaces', 'two words@example.com'],
  ])('fails when the edited recipient is %s', async (_label, target) => {
    const sendMail = okSend();
    const fetchImpl = okFetch();
    const tasks = setup({ llm: createFakeLlm(() => draftReply), email: settings, sendMail, fetchImpl });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);
    if (ready.draft === undefined) throw new Error('Expected a draft');

    tasks.transition(ready.id, 'RUNNING', { draft: { ...ready.draft, target } });
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');

    expect(failed.error).toBe('Add a valid recipient email address before sending');
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when sending fails, then completes a retry with only one successful send', async () => {
    let attempts = 0;
    let successful = 0;
    const sendMail = vi.fn<SendMail>(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:1025');
      successful += 1;
      return {};
    });
    const tasks = setup({
      llm: createFakeLlm(() => draftReply),
      email: settings,
      sendMail,
      fetchImpl: okFetch(),
    });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const failed = await waitForStatus(tasks, ready.id, 'FAILED');
    expect(failed.error).toBe(
      'could not send the email: The mail server is not answering. Check that it is running, then press Retry. (connect ECONNREFUSED 127.0.0.1:1025)',
    );

    tasks.transition(failed.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');
    expect(completed.artifactUrl).toBe('http://mailpit.test/view/message-123');
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(successful).toBe(1);
  });

  it.each([
    ['a network error', () => vi.fn<typeof fetch>().mockRejectedValue(new Error('connect ECONNREFUSED'))],
    ['a non-2xx reply', () => vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 500 }))],
    ['no search hit', () => vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ messages: [] }))],
    ['an unusable reply', () => vi.fn<typeof fetch>().mockResolvedValue(new Response('not json', { status: 200 }))],
  ])('still completes with the inbox link after %s from Mailpit', async (_label, makeFetch) => {
    const fetchImpl = makeFetch();
    const tasks = setup({
      llm: createFakeLlm(() => draftReply),
      email: settings,
      sendMail: okSend(),
      fetchImpl,
    });
    const task = startTask(tasks);
    const ready = await claim(tasks, task);

    tasks.transition(ready.id, 'RUNNING');
    const completed = await waitForStatus(tasks, ready.id, 'COMPLETED');

    expect(completed.artifactUrl).toBe('http://mailpit.test');
  });

  it('fails when the LLM errors', async () => {
    const llm = createFakeLlm(() => {
      throw new LlmError('gateway down');
    });
    const sendMail = okSend();
    const tasks = setup({ llm, email: settings, sendMail, fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    expect(failed.error).toMatch(/gateway down/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['no subject', JSON.stringify({ to: 'supplier@example.com', body: 'The oven is fixed.' })],
    ['a blank body', JSON.stringify({ to: 'supplier@example.com', subject: 'Fix the oven', body: '   ' })],
  ])('fails when the LLM reply has %s', async (_label, reply) => {
    const tasks = setup({
      llm: createFakeLlm(() => reply),
      email: settings,
      sendMail: okSend(),
      fetchImpl: okFetch(),
    });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    expect(failed.error).toMatch(/usable JSON/i);
  });

  it('fails loudly when email is not configured on claim or retry', async () => {
    const tasks = setup({ llm: createFakeLlm(() => draftReply), email: undefined, sendMail: okSend() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/Email is not configured/);

    tasks.transition(failed.id, 'RUNNING');
    const retried = await waitForStatus(tasks, task.id, 'FAILED');
    expect(retried.error).toMatch(/Email is not configured/);
  });

  it('accepts an LLM reply wrapped in a code fence', async () => {
    const llm = createFakeLlm(() => `\`\`\`json\n${draftReply}\n\`\`\``);
    const tasks = setup({ llm, email: settings, sendMail: okSend(), fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft?.subject).toBeTruthy();
  });

  it('drafts again when a retry follows a failed draft', async () => {
    let calls = 0;
    const llm = createFakeLlm(() => {
      calls += 1;
      if (calls === 1) throw new LlmError('gateway down');
      return draftReply;
    });
    const tasks = setup({ llm, email: settings, sendMail: okSend(), fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');

    // A retry with no draft claims the task again (see the RETRY_ACTION command).
    tasks.transition(failed.id, 'CLAIMED');
    const ready = await waitForStatus(tasks, task.id, 'DRAFT_READY');
    expect(ready.draft).toBeDefined();
  });

  it('fails loudly when the LLM is not configured', async () => {
    const tasks = setup({ email: settings, sendMail: okSend(), fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const failed = await waitForStatus(tasks, task.id, 'FAILED');
    expect(failed.error).toMatch(/LLM is not configured/);
  });

  it('drops a draft result when the task changed while the LLM was working', async () => {
    const pending = deferred<string>();
    const llm: LlmClient = { complete: () => pending.promise };
    const tasks = setup({ llm, email: settings, sendMail: okSend(), fetchImpl: okFetch() });
    const task = startTask(tasks);

    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    tasks.transition(task.id, 'FAILED', { error: 'changed elsewhere' });
    pending.resolve(draftReply);
    await settle(20);

    const current = tasks.get(task.id);
    expect(current?.status).toBe('FAILED');
    expect(current?.error).toBe('changed elsewhere');
    expect(current?.draft).toBeUndefined();
  });

  it('ignores other action kinds and manual tasks', async () => {
    const llm = createFakeLlm(() => draftReply);
    const sendMail = okSend();
    const fetchImpl = okFetch();
    const tasks = setup({ llm, email: settings, sendMail, fetchImpl });

    const gitea = startTask(tasks, 'gitea_issue');
    tasks.transition(gitea.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const mattermost = startTask(tasks, 'mattermost_post');
    tasks.transition(mattermost.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const manual = startTask(tasks, 'email');
    tasks.transition(manual.id, 'CLAIMED', { mode: 'MANUAL' });
    await settle(20);

    expect(tasks.get(gitea.id)?.status).toBe('CLAIMED');
    expect(tasks.get(mattermost.id)?.status).toBe('CLAIMED');
    expect(tasks.get(manual.id)?.status).toBe('CLAIMED');
    expect(llm.calls).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
