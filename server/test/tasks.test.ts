import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, TaskStatus } from '@kaki/shared';
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
});
