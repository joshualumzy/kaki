import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { installAutoDispatch } from '../../src/host/autoDispatch';
import { createTestApp } from '../helpers';
import { testScenario } from '../fixtures/scenario';

describe('auto-dispatch', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('dispatches a new task to the role named, and Sam says so', () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario });

    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });

    expect(app.tasks.get(task.id)).toMatchObject({ status: 'DISPATCHED', assignee: 'chef' });
    const cue = published.find((event) => event.type === 'HOST_SPEECH_TRIGGERED');
    expect(cue).toMatchObject({ payload: { kind: 'DISPATCH' } });
    expect((cue as { payload: { text: string } }).payload.text).toContain('Ada, I\'ve sent you a task: Fix the oven');
  });

  it('leaves a declined task for a person; it is not sent out again', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario });
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'chef');
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('leaves the task for a person when the role is the facilitator', () => {
    const scenario = {
      ...testScenario,
      roles: testScenario.roles.map((role) => (role.id === 'chef' ? { ...role, facilitator: true } : role)),
    };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario });
    const task = app.tasks.suggest({ title: 'Plan', context: 'x', suggestedAssignee: 'chef' });
    expect(task.status).toBe('SUGGESTED');
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('leaves the task for a person when nobody in the meeting plays the role', () => {
    const scenario = { ...testScenario, attendees: testScenario.attendees.filter((a) => a.role !== 'chef') };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario });
    const task = app.tasks.suggest({ title: 'Plan', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('accepts for an AI attendee after a short pause, and does not tell them to use a phone', () => {
    vi.useFakeTimers();
    try {
      const chef = testScenario.attendees.find((a) => a.role === 'chef')!;
      const scenario = {
        ...testScenario,
        npcs: [{ attendee: chef.name, persona: 'p', voice: 'v', speaking: 's' }] as unknown as typeof testScenario.npcs,
      };
      const published: KakiEvent[] = [];
      app.hub.subscribe((event) => published.push(event));
      installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario, npcAcceptDelayMs: 3000 });
      const task = app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });

      expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
      const cue = published.find((event) => event.type === 'HOST_SPEECH_TRIGGERED') as { payload: { text: string } };
      expect(cue.payload.text).not.toContain('phone');
      vi.advanceTimersByTime(3000);
      expect(app.tasks.get(task.id)).toMatchObject({ status: 'CLAIMED', assignee: 'chef', mode: 'MANUAL' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accept for a person: the human recipient still decides', () => {
    vi.useFakeTimers();
    try {
      installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario, npcAcceptDelayMs: 1000 });
      const task = app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
      vi.advanceTimersByTime(5000);
      expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
    } finally {
      vi.useRealTimers();
    }
  });
});
