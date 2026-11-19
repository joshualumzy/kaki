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
  it('keeps saved tasks and turns one that was RUNNING into FAILED with Retry advice', () => {
    const saved = runningTask();
    const store = createTaskStore({ hub: quietHub(), scenario: testScenario });

    store.restore([saved]);

    const restored = store.get(saved.id);
    expect(restored?.status).toBe('FAILED');
    expect(restored?.error).toBe(INTERRUPTED_TASK_ERROR);
    expect(INTERRUPTED_TASK_ERROR).toBe('Kaki restarted while this was running — tap Retry.');
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
