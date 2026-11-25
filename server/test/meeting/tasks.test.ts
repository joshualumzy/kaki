import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, TaskStatus } from '@kaki/shared';
import { roleAudience } from '../../src/core/audience';
import { CommandError } from '../../src/core/hub';
import { createTaskStore, TASK_UNDECIDED_ERROR } from '../../src/meeting/tasks';
import { createPracticeTestApp } from '../helpers';
import { testScenario } from '../fixtures/scenario';

describe('task store change handlers', () => {
  let app: Awaited<ReturnType<typeof createPracticeTestApp>>;

  beforeEach(async () => {
    app = await createPracticeTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('fires onChange once per change, after publishing to every audience', () => {
    const changes: Array<{ status: TaskStatus; previous: TaskStatus | undefined }> = [];
    app.tasks.onChange((task, previous) => changes.push({ status: task.status, previous }));

    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    expect(changes).toEqual([{ status: 'SUGGESTED', previous: undefined }]);

    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));

    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    expect(published.filter((event) => event.type === 'TASK_UPDATED')).toHaveLength(2);
    expect(changes).toEqual([
      { status: 'SUGGESTED', previous: undefined },
      { status: 'DISPATCHED', previous: 'SUGGESTED' },
    ]);
  });

  it('fires once per change even when the task is published twice', () => {
    const changes: TaskStatus[] = [];
    app.tasks.onChange((task) => changes.push(task.status));

    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    app.tasks.transition(task.id, 'CLAIMED', { mode: 'MANUAL' });

    expect(changes).toEqual(['SUGGESTED', 'DISPATCHED', 'CLAIMED']);
  });

  it('keeps going when a change handler throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const seen: TaskStatus[] = [];
      app.tasks.onChange(() => {
        throw new Error('handler boom');
      });
      app.tasks.onChange((task) => seen.push(task.status));

      const task = app.tasks.suggest({
        title: 'Fix the oven',
        context: 'The oven trips the fuse.',
        suggestedAssignee: 'chef',
      });
      const next = app.tasks.transition(task.id, 'DISMISSED');

      expect(next.status).toBe('DISMISSED');
      expect(seen).toEqual(['SUGGESTED', 'DISMISSED']);
      expect(app.tasks.get(task.id)?.status).toBe('DISMISSED');
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('clears a previous error when a failed task runs again', () => {
    const task = app.tasks.suggest({
      title: 'Fix the oven',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    app.tasks.transition(task.id, 'CLAIMED', { mode: 'MANUAL' });
    app.tasks.transition(task.id, 'FAILED', { error: 'boom' });
    app.tasks.transition(task.id, 'RUNNING');
    expect(app.tasks.get(task.id)?.error).toBeUndefined();

    const completed = app.tasks.transition(task.id, 'COMPLETED');
    expect(completed.error).toBeUndefined();
  });

  describe('RETRY_ACTION', () => {
    function failedTask() {
      const task = app.tasks.suggest({
        title: 'Fix the oven',
        context: 'The oven trips the fuse.',
        suggestedAssignee: 'chef',
        actionKind: 'gitea_issue',
      });
      app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
      app.tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
      app.tasks.transition(task.id, 'FAILED', { error: 'boom' });
      return task;
    }

    it('claims again to re-draft when there is no draft', () => {
      const task = failedTask();

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id }, roleAudience('chef'));

      const retried = app.tasks.get(task.id);
      expect(retried?.status).toBe('CLAIMED');
      expect(retried?.mode).toBe('ACTION_AGENT');
      expect(retried?.error).toBeUndefined();
    });

    it('runs again when the command carries a draft', () => {
      const task = failedTask();
      const draft = { target: 'kopitiam/kopitiam-pos', subject: 'Fix the oven', body: 'The fuse trips.' };

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id, draft }, roleAudience('chef'));

      const retried = app.tasks.get(task.id);
      expect(retried?.status).toBe('RUNNING');
      expect(retried?.draft).toEqual(draft);
    });

    it('runs again when the task already has a draft', () => {
      const task = failedTask();
      const draft = { target: 'kopitiam/kopitiam-pos', subject: 'Fix the oven', body: 'The fuse trips.' };
      app.tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
      app.tasks.transition(task.id, 'DRAFT_READY', { draft });
      app.tasks.transition(task.id, 'RUNNING');
      app.tasks.transition(task.id, 'FAILED', { error: 'boom' });

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id }, roleAudience('chef'));

      expect(app.tasks.get(task.id)?.status).toBe('RUNNING');
    });
  });

  it('stores trusted assignment evidence with the task and keeps plain suggestions unchanged', () => {
    const assignmentEvidence = {
      speaker: 'Ada',
      quote: 'I will fix the oven this afternoon.',
      scope: { title: 'Fix the oven', context: 'Trips the fuse.', actionKind: 'mattermost_post' as const },
    };
    const task = app.tasks.suggest(
      { title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef', actionKind: 'mattermost_post' },
      assignmentEvidence,
    );
    expect(app.tasks.get(task.id)?.assignmentEvidence).toEqual(assignmentEvidence);

    const plain = app.tasks.suggest({ title: 'Book the engineer', context: 'Next week.', suggestedAssignee: 'chef' });
    expect(app.tasks.get(plain.id)?.assignmentEvidence).toBeUndefined();
  });

  it('copies evidence so later mutation cannot change the stored task, and keeps it through transitions', () => {
    const assignmentEvidence = {
      speaker: 'Ada',
      quote: 'I will fix the oven this afternoon.',
      scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
    };
    const task = app.tasks.suggest(
      { title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' },
      assignmentEvidence,
    );

    assignmentEvidence.quote = 'I never said that.';
    assignmentEvidence.scope.title = 'Something else';
    expect(app.tasks.get(task.id)?.assignmentEvidence).toEqual({
      speaker: 'Ada',
      quote: 'I will fix the oven this afternoon.',
      scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
    });

    const dispatched = app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    expect(dispatched.assignmentEvidence).toEqual({
      speaker: 'Ada',
      quote: 'I will fix the oven this afternoon.',
      scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
    });
    expect(dispatched.assignmentEvidence).not.toBe(assignmentEvidence);
  });

  it('rejects malformed trusted assignment evidence', () => {
    expect(() =>
      app.tasks.suggest(
        { title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' },
        { speaker: 'Ada', quote: '  ', scope: { title: 'Fix the oven', context: 'Trips the fuse.' } },
      ),
    ).toThrow(CommandError);
    expect(() =>
      app.tasks.suggest(
        { title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' },
        { speaker: 'Ada', quote: 'I will fix it.', scope: 'Fix the oven' as never },
      ),
    ).toThrow(CommandError);
  });

  it('rejects an invalid suggestion with a CommandError', () => {
    expect(() =>
      app.tasks.suggest({
        title: '  ',
        context: 'Ask for Friday delivery.',
        suggestedAssignee: 'chef',
      }),
    ).toThrow(CommandError);
  });

  it('keeps the server-owned purpose when a suggested card is revised', () => {
    const task = app.tasks.suggestWithPurpose(
      { title: 'Publish meeting minutes', context: 'The minutes.', suggestedAssignee: 'chef' },
      'meeting_minutes',
    );

    const revised = app.tasks.reviseSuggested(task.id, {
      title: 'Write up what we agreed',
      context: 'Reworded minutes.',
      suggestedAssignee: 'chef',
    });

    expect(revised.title).toBe('Write up what we agreed');
    expect(revised.purpose).toBe('meeting_minutes');
  });
});

describe('declining a dispatched task', () => {
  let app: Awaited<ReturnType<typeof createPracticeTestApp>>;
  beforeEach(async () => {
    app = await createPracticeTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('puts it back on the shared screen with nobody assigned, and tells the person who declined', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));

    app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, roleAudience('chef'));

    const declined = app.tasks.get(task.id)!;
    expect(declined.status).toBe('SUGGESTED');
    expect(declined.assignee).toBeUndefined();
    expect(declined.declinedBy).toEqual(['chef']);
    // The chef's phone hears it is no longer theirs, as does the screen.
    const audiences = published.filter((event) => event.type === 'TASK_UPDATED').map((event) => JSON.stringify(event.audience));
    expect(audiences).toEqual([JSON.stringify({ kind: 'screen' }), JSON.stringify({ kind: 'role', role: 'chef' })]);
    // It can be offered to someone else.
    app.tasks.handleCommand({ type: 'DISPATCH_TASK', taskId: task.id, assignee: 'cashier' }, { kind: 'screen' });
    expect(app.tasks.get(task.id)?.assignee).toBe('cashier');
    expect(app.tasks.get(task.id)?.declinedBy).toEqual(['chef']);
  });

  it('is only for the assigned role, and only while the task is dispatched', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, roleAudience('chef'))).toThrow(CommandError);
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, roleAudience('cashier'))).toThrow(CommandError);
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, { kind: 'screen' })).toThrow(CommandError);
    app.tasks.handleCommand({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' }, roleAudience('chef'));
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, roleAudience('chef'))).toThrow(CommandError);
  });
});


describe('returning a dispatched task undecided', () => {
  let app: Awaited<ReturnType<typeof createPracticeTestApp>>;
  beforeEach(async () => {
    app = await createPracticeTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('puts it back on the shared screen without counting as a decline, with a visible reason', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    app.tasks.handleCommand({ type: 'RETURN_TASK_UNDECIDED', taskId: task.id }, roleAudience('chef'));

    const returned = app.tasks.get(task.id)!;
    expect(returned.status).toBe('SUGGESTED');
    expect(returned.assignee).toBeUndefined();
    expect(returned.declinedBy).toBeUndefined();
    expect(returned.error).toBe(TASK_UNDECIDED_ERROR);
    // A host can redispatch it, and that clears the unresolved reason.
    app.tasks.handleCommand({ type: 'DISPATCH_TASK', taskId: task.id, assignee: 'cashier' }, { kind: 'screen' });
    expect(app.tasks.get(task.id)?.assignee).toBe('cashier');
    expect(app.tasks.get(task.id)?.error).toBeUndefined();
  });

  it('is only for the assigned role, and only while the task is dispatched', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'RETURN_TASK_UNDECIDED', taskId: task.id }, roleAudience('chef'))).toThrow(CommandError);
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'RETURN_TASK_UNDECIDED', taskId: task.id }, roleAudience('cashier'))).toThrow(CommandError);
    expect(() => app.tasks.handleCommand({ type: 'RETURN_TASK_UNDECIDED', taskId: task.id }, { kind: 'screen' })).toThrow(CommandError);
  });
});

describe('guest task actions', () => {
  let app: Awaited<ReturnType<typeof createPracticeTestApp>>;
  beforeEach(async () => {
    app = await createPracticeTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  function guestTasks() {
    return createTaskStore({
      hub: app.hub,
      scenario: testScenario,
      seatIsGuest: (role) => role === 'chef',
    });
  }

  it('blocks running, approving and retrying a tool action, but allows manual work', () => {
    const tasks = guestTasks();
    const task = tasks.suggest({
      title: 'Fix the oven',
      context: 'Trips the fuse.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });

    expect(() =>
      tasks.handleCommand(
        { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' },
        roleAudience('chef'),
      ),
    ).toThrow(/Guests can't run or approve tool actions/);

    tasks.handleCommand({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' }, roleAudience('chef'));
    expect(tasks.get(task.id)?.status).toBe('CLAIMED');
    expect(tasks.get(task.id)?.mode).toBe('MANUAL');

    tasks.transition(task.id, 'FAILED', { error: 'boom' });
    expect(() =>
      tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id }, roleAudience('chef')),
    ).toThrow(/Guests can't run or approve tool actions/);

    const draft = { target: 'kopitiam/kopitiam-pos', subject: 'Fix the oven', body: 'The fuse trips.' };
    const approval = tasks.suggest({
      title: 'Post the rota',
      context: 'The rota changed.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    tasks.transition(approval.id, 'DISPATCHED', { assignee: 'chef' });
    tasks.transition(approval.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    tasks.transition(approval.id, 'DRAFT_READY', { draft });
    expect(() =>
      tasks.handleCommand(
        { type: 'APPROVE_ACTION', taskId: approval.id, draft },
        roleAudience('chef'),
      ),
    ).toThrow(/Guests can't run or approve tool actions/);
  });

  it('still lets a signed-in member run the tool action', () => {
    const tasks = createTaskStore({
      hub: app.hub,
      scenario: testScenario,
      seatIsGuest: () => false,
    });
    const task = tasks.suggest({
      title: 'Fix the oven',
      context: 'Trips the fuse.',
      suggestedAssignee: 'chef',
      actionKind: 'gitea_issue',
    });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    expect(() =>
      tasks.handleCommand(
        { type: 'CLAIM_TASK', taskId: task.id, mode: 'ACTION_AGENT' },
        roleAudience('chef'),
      ),
    ).not.toThrow();
  });
});
