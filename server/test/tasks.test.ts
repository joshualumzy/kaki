import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, TaskStatus } from '@kaki/shared';
import { CommandError } from '../src/hub';
import { createTestApp } from './helpers';

describe('task store change handlers', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    app = await createTestApp();
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

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id }, 'chef');

      const retried = app.tasks.get(task.id);
      expect(retried?.status).toBe('CLAIMED');
      expect(retried?.mode).toBe('ACTION_AGENT');
      expect(retried?.error).toBeUndefined();
    });

    it('runs again when the command carries a draft', () => {
      const task = failedTask();
      const draft = { target: 'kopitiam/kopitiam-pos', subject: 'Fix the oven', body: 'The fuse trips.' };

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id, draft }, 'chef');

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

      app.tasks.handleCommand({ type: 'RETRY_ACTION', taskId: task.id }, 'chef');

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
  let app: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('puts it back on the shared screen with nobody assigned, and tells the person who declined', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));

    app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'chef');

    const declined = app.tasks.get(task.id)!;
    expect(declined.status).toBe('SUGGESTED');
    expect(declined.assignee).toBeUndefined();
    expect(declined.declinedBy).toEqual(['chef']);
    // The chef's phone hears it is no longer theirs, as does the screen.
    const audiences = published.filter((event) => event.type === 'TASK_UPDATED').map((event) => JSON.stringify(event.audience));
    expect(audiences).toEqual([JSON.stringify({ kind: 'screen' }), JSON.stringify({ kind: 'role', role: 'chef' })]);
    // It can be offered to someone else.
    app.tasks.handleCommand({ type: 'DISPATCH_TASK', taskId: task.id, assignee: 'cashier' }, 'screen');
    expect(app.tasks.get(task.id)?.assignee).toBe('cashier');
    expect(app.tasks.get(task.id)?.declinedBy).toEqual(['chef']);
  });

  it('is only for the assigned role, and only while the task is dispatched', () => {
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'chef')).toThrow(CommandError);
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'cashier')).toThrow(CommandError);
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'screen')).toThrow(CommandError);
    app.tasks.handleCommand({ type: 'CLAIM_TASK', taskId: task.id, mode: 'MANUAL' }, 'chef');
    expect(() => app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'chef')).toThrow(CommandError);
  });
});
