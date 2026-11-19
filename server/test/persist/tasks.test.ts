import { describe, expect, it } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { createTaskStore, INTERRUPTED_TASK_ERROR } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

function runningTask() {
  const tasks = createTaskStore({ hub: quietHub(), scenario: testScenario });
  const task = tasks.suggest({
    title: 'Email the supplier',
    context: 'The oven part is late.',
    suggestedAssignee: 'chef',
    actionKind: 'email',
  });
  tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  tasks.transition(task.id, 'DRAFT_READY', {
    draft: { target: 'supplier@example.test', subject: 'Part', body: 'When is it coming?' },
  });
  return tasks.transition(task.id, 'RUNNING');
}

describe('task restore', () => {
  it('keeps saved tasks and turns one that was RUNNING into an interrupted FAILED with Retry advice', () => {
    const saved = runningTask();
    const store = createTaskStore({ hub: quietHub(), scenario: testScenario });

    store.restore([saved]);

    const restored = store.get(saved.id);
    expect(restored?.status).toBe('FAILED');
    expect(restored?.interrupted).toBe(true);
    expect(restored?.error).toBe(INTERRUPTED_TASK_ERROR);
    expect(INTERRUPTED_TASK_ERROR).toBe(
      'Kaki restarted while this was running. It may already have gone through: check before tapping Retry.',
    );
  });

  it('turns a task Kaki was still drafting into an interrupted FAILED with Retry advice', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario: testScenario });
    const task = tasks.suggest({
      title: 'Email the supplier',
      context: 'The oven part is late.',
      suggestedAssignee: 'chef',
      actionKind: 'email',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });

    const store = createTaskStore({ hub: quietHub(), scenario: testScenario });
    store.restore(tasks.snapshot());

    expect(store.get(task.id)).toMatchObject({
      status: 'FAILED',
      interrupted: true,
      error: INTERRUPTED_TASK_ERROR,
    });
  });

  it('leaves a manual CLAIMED task alone, because no action is running', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario: testScenario });
    const task = tasks.suggest({
      title: 'Call the plumber',
      context: 'The sink leaks.',
      suggestedAssignee: 'cashier',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'cashier' });
    tasks.transition(task.id, 'CLAIMED', { mode: 'MANUAL' });

    const store = createTaskStore({ hub: quietHub(), scenario: testScenario });
    store.restore(tasks.snapshot());

    expect(store.get(task.id)?.status).toBe('CLAIMED');
    expect(store.get(task.id)?.interrupted).toBeUndefined();
  });

  it('clears the interrupted mark once the owner moves the task again', () => {
    const saved = runningTask();
    const store = createTaskStore({ hub: quietHub(), scenario: testScenario });
    store.restore([saved]);
    expect(store.get(saved.id)?.interrupted).toBe(true);

    store.transition(saved.id, 'RUNNING');

    expect(store.get(saved.id)?.interrupted).toBeUndefined();
  });

  it('round-trips other statuses unchanged', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario: testScenario });
    const suggested = tasks.suggest({
      title: 'Call the plumber',
      context: 'The sink leaks.',
      suggestedAssignee: 'cashier',
    });
    const dispatched = tasks.transition(suggested.id, 'DISPATCHED', { assignee: 'cashier' });
    const snapshot = tasks.snapshot();

    const restored = createTaskStore({ hub: quietHub(), scenario: testScenario });
    restored.restore(snapshot);

    expect(restored.get(suggested.id)).toMatchObject({ status: 'DISPATCHED', assignee: dispatched.assignee });
    expect(restored.list()).toHaveLength(1);
  });

  it('publishes every restored task so a screen that connects later still sees it', () => {
    const saved = runningTask();
    const published: KakiEvent[] = [];
    const hub = quietHub();
    hub.publish = (event) => published.push(event);

    createTaskStore({ hub, scenario: testScenario }).restore([saved]);

    const updates = published.filter((event) => event.type === 'TASK_UPDATED');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((event) => event.type === 'TASK_UPDATED' && event.payload.task.status === 'FAILED')).toBe(true);
  });
});
