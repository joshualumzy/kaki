import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KakiCommand, KakiEvent, Task } from '@kaki/shared';
import { fakeActionsModule } from '../src/dev/fakeActions';
import {
  connectClient,
  createTestApp,
  portOf,
  settle,
  taskStatuses,
  waitFor,
  waitForEvent,
  type TestClient,
} from './helpers';

function send(client: TestClient, command: KakiCommand): void {
  client.ws.send(JSON.stringify(command));
}

function taskOf(event: KakiEvent): Task {
  if (event.type !== 'TASK_UPDATED') throw new Error(`Expected TASK_UPDATED, got ${event.type}`);
  return event.payload.task;
}

function isStatus(taskId: string, status: string) {
  return (event: KakiEvent): boolean =>
    event.type === 'TASK_UPDATED' &&
    event.payload.task.id === taskId &&
    event.payload.task.status === status;
}

describe('task flows', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let port: number;
  let clients: TestClient[];

  beforeEach(async () => {
    app = await createTestApp({ modules: [fakeActionsModule] });
    port = portOf(app);
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await app.close();
  });

  async function connect(role: string): Promise<TestClient> {
    const client = await connectClient(port, role);
    clients.push(client);
    return client;
  }

  it('runs the full agent flow from suggestion to meeting sync', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');
    const cashier = await connect('cashier');

    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse after ten minutes.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    await waitForEvent(screen, isStatus(task.id, 'SUGGESTED'), 'suggestion');

    send(screen, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    await waitForEvent(chef, isStatus(task.id, 'DISPATCHED'), 'dispatch');

    send(chef, { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' });
    const ready = await waitForEvent(chef, isStatus(task.id, 'DRAFT_READY'), 'draft ready', 5_000);
    const draft = taskOf(ready).draft;
    if (draft === undefined) throw new Error('Expected a draft');

    send(chef, {
      type: 'APPROVE_ACTION',
      taskId: task.id,
      draft: { ...draft, body: 'Ship it.' },
    });
    const completed = await waitForEvent(
      chef,
      isStatus(task.id, 'COMPLETED'),
      'completion',
      5_000,
    );
    expect(taskOf(completed).artifactUrl).toBe(`http://localhost/fake/gitea_issue/${task.id}`);

    send(chef, { type: 'SYNC_TASK', taskId: task.id });
    await waitForEvent(chef, isStatus(task.id, 'SYNCED'), 'sync');
    await settle();

    expect(taskStatuses(screen, task.id)).toEqual([
      'SUGGESTED',
      'DISPATCHED',
      'CLAIMED',
      'DRAFT_READY',
      'RUNNING',
      'COMPLETED',
      'SYNCED',
    ]);
    expect(taskStatuses(chef, task.id)).toEqual([
      'DISPATCHED',
      'CLAIMED',
      'DRAFT_READY',
      'RUNNING',
      'COMPLETED',
      'SYNCED',
    ]);
    expect(taskStatuses(cashier, task.id)).toEqual([]);
  });

  it('runs the manual flow: claim, mark done, completed', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');

    const task = app.tasks.suggest({
      title: 'Wipe the counter',
      context: 'The counter is sticky.',
      suggestedAssignee: 'chef',
    });
    await waitForEvent(screen, isStatus(task.id, 'SUGGESTED'), 'suggestion');

    send(screen, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    await waitForEvent(chef, isStatus(task.id, 'DISPATCHED'), 'dispatch');
    send(chef, { type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' });
    await waitForEvent(chef, isStatus(task.id, 'CLAIMED'), 'claim');
    send(chef, { type: 'MARK_DONE', taskId: task.id });
    await waitForEvent(chef, isStatus(task.id, 'COMPLETED'), 'completion');

    expect(taskStatuses(chef, task.id)).toEqual(['DISPATCHED', 'CLAIMED', 'COMPLETED']);
    expect(app.tasks.get(task.id)?.status).toBe('COMPLETED');
  });

  it('rejects commands from the wrong audience without changing the task', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');
    const cashier = await connect('cashier');

    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    await waitForEvent(screen, isStatus(task.id, 'SUGGESTED'), 'suggestion');
    send(screen, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    await waitForEvent(chef, isStatus(task.id, 'DISPATCHED'), 'dispatch');

    send(cashier, { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' });
    const cashierRejection = await waitForEvent(
      cashier,
      (event) => event.type === 'COMMAND_REJECTED',
      'cashier rejection',
    );
    if (cashierRejection.type !== 'COMMAND_REJECTED') throw new Error('Expected a rejection');
    expect(cashierRejection.payload.reason).toMatch(/assigned role/);

    send(chef, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    const chefRejection = await waitForEvent(
      chef,
      (event) => event.type === 'COMMAND_REJECTED',
      'chef rejection',
    );
    if (chefRejection.type !== 'COMMAND_REJECTED') throw new Error('Expected a rejection');

    expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
    expect(taskStatuses(screen, task.id)).toEqual(['SUGGESTED', 'DISPATCHED']);
    expect(screen.messages.filter((event) => event.type === 'COMMAND_REJECTED')).toEqual([]);
    expect(cashier.messages.filter((event) => event.type === 'COMMAND_REJECTED')).toHaveLength(1);
  });

  it('rejects an illegal transition', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');

    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    await waitForEvent(screen, isStatus(task.id, 'SUGGESTED'), 'suggestion');
    send(screen, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    await waitForEvent(chef, isStatus(task.id, 'DISPATCHED'), 'dispatch');

    send(chef, { type: 'SYNC_TASK', taskId: task.id });
    const rejection = await waitForEvent(
      chef,
      (event) => event.type === 'COMMAND_REJECTED',
      'illegal transition rejection',
    );
    if (rejection.type !== 'COMMAND_REJECTED') throw new Error('Expected a rejection');
    expect(rejection.payload.reason).toMatch(/Cannot move/);
    expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
  });

  it('fails an approved action whose draft contains FAIL, then retries it', async () => {
    const screen = await connect('screen');
    const chef = await connect('chef');

    const task = app.tasks.suggest({
      title: 'Email the supplier',
      context: 'Ask for Friday delivery.',
      suggestedAssignee: 'chef',
      actionKind: 'email',
    });
    await waitForEvent(screen, isStatus(task.id, 'SUGGESTED'), 'suggestion');
    send(screen, { type: 'DISPATCH_TASK', taskId: task.id, assignee: 'chef' });
    await waitForEvent(chef, isStatus(task.id, 'DISPATCHED'), 'dispatch');
    send(chef, { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' });

    const ready = await waitForEvent(chef, isStatus(task.id, 'DRAFT_READY'), 'draft ready', 5_000);
    const draft = taskOf(ready).draft;
    if (draft === undefined) throw new Error('Expected a draft');

    send(chef, {
      type: 'APPROVE_ACTION',
      taskId: task.id,
      draft: { ...draft, body: 'Please FAIL on purpose.' },
    });
    const failed = await waitForEvent(chef, isStatus(task.id, 'FAILED'), 'failure', 5_000);
    expect(taskOf(failed).error).toBe('fake failure');

    send(chef, { type: 'RETRY_ACTION', taskId: task.id });
    await waitFor(
      () => (app.tasks.get(task.id)?.status === 'RUNNING' ? true : undefined),
      'retry running',
    );
    expect(app.tasks.get(task.id)?.status).toBe('RUNNING');
  });
});
