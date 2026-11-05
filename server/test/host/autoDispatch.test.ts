import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('says the same words whoever the recipient is, so nobody can tell who is AI', () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    const chef = testScenario.attendees.find((a) => a.role === 'chef')!;
    const asAi = { ...testScenario, npcs: [{ attendee: chef.name, voice: 'v', personality: 'p', agenda: 'a', concerns: [] }] };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: asAi });
    app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
    const cue = published.find((event) => event.type === 'HOST_SPEECH_TRIGGERED') as { payload: { text: string } };
    expect(cue.payload.text).toBe(`${chef.name}, I've sent you a task: Fix the oven. Accept or decline it on your phone.`);
  });

  it('leaves a human recipient to accept it themselves', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario });
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
  });
});
