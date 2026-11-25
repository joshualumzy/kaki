import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryTaskCalendarEventStore,
  createTaskCalendarLifecycle,
  taskCalendarUid,
} from '../../src/meeting/taskCalendarEvents';
import { createMemoryCalendarCancellationStore } from '../../src/meeting/calendarCancellations';

const settings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };

function calendarFetch(status = 201) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') return new Response('', { status });
    return new Response('', { status: 405 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('follow-up calendar lifecycle', () => {
  it('keeps one stable UID and a stored SEQUENCE across approved retries', async () => {
    const store = createMemoryTaskCalendarEventStore();
    const fetchImpl = calendarFetch();
    const lifecycle = createTaskCalendarLifecycle({
      store,
      fetchImpl,
      now: () => Date.parse('2026-11-01T00:00:00Z'),
    });

    const first = await lifecycle.run({
      taskId: 'task-1',
      meetingId: 'meeting-1',
      workspaceId: 'workspace-1',
      title: 'Follow up with Zack',
      notes: 'Confirm the re-taste time.',
      start: '2026-11-13 10:00',
      durationMinutes: 30,
      settings,
    });
    expect(first).toMatchObject({ uid: taskCalendarUid('task-1'), fileId: 'task-1', sequence: 0 });
    expect(await store.get('task-1')).toMatchObject({
      workspaceId: 'workspace-1',
      uid: taskCalendarUid('task-1'),
      sequence: 0,
      state: 'synced',
    });

    const second = await lifecycle.run({
      taskId: 'task-1',
      meetingId: 'meeting-1',
      workspaceId: 'workspace-1',
      title: 'Follow up with Zack',
      notes: 'Confirm the re-taste time.',
      start: '2026-11-13 10:00',
      durationMinutes: 30,
      settings,
    });
    expect(second).toMatchObject({ uid: taskCalendarUid('task-1'), fileId: 'task-1', sequence: 1 });
    const puts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(String(puts[0]?.[0])).toBe('http://cal.test/user/calendar/task-1.ics');
    expect(String(puts[1]?.[1]?.body)).toContain(`UID:${taskCalendarUid('task-1')}`);
    expect(String(puts[1]?.[1]?.body)).toContain('SEQUENCE:1');
    expect(String(puts[1]?.[1]?.body)).not.toContain('METHOD:');
  });

  it('cancels a workspace follow-up and removes its binding', async () => {
    const store = createMemoryTaskCalendarEventStore();
    const fetchImpl = calendarFetch();
    const lifecycle = createTaskCalendarLifecycle({ store, fetchImpl });
    await lifecycle.run({
      taskId: 'task-2',
      meetingId: 'meeting-1',
      workspaceId: 'workspace-1',
      title: 'Follow up',
      notes: '',
      start: '2026-11-13 10:00',
      durationMinutes: 30,
      settings,
    });

    expect(await lifecycle.cancelForWorkspace('workspace-1', { requestedBy: 'user-1' })).toEqual([]);
    const put = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1);
    expect(String(put?.[1]?.body)).toContain('STATUS:CANCELLED');
    expect(String(put?.[1]?.body)).toContain('SEQUENCE:1');
    expect(await store.listForWorkspace('workspace-1')).toEqual([]);
  });

  it('keeps a failed workspace follow-up cancellation for an admin retry', async () => {
    const store = createMemoryTaskCalendarEventStore();
    const cancellations = createMemoryCalendarCancellationStore();
    const fetchImpl = calendarFetch();
    const lifecycle = createTaskCalendarLifecycle({ store, fetchImpl, cancellations });
    await lifecycle.run({
      taskId: 'task-3',
      meetingId: 'meeting-1',
      workspaceId: 'workspace-1',
      title: 'Follow up later',
      notes: '',
      start: '2026-11-13 10:00',
      durationMinutes: 30,
      settings,
    });

    const failing = vi.fn<typeof fetch>(async (_url, init) =>
      new Response('', { status: init?.method === 'PUT' ? 500 : 405 }),
    );
    const failingLifecycle = createTaskCalendarLifecycle({
      store,
      fetchImpl: failing,
      cancellations,
    });
    const warnings = await failingLifecycle.cancelForWorkspace('workspace-1', {
      workspaceName: 'Kitchen',
      requestedBy: 'user-1',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Follow up later');
    const pending = await cancellations.listForWorkspace('workspace-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      source: 'followup',
      title: 'Follow up later',
      workspaceName: 'Kitchen',
      requestedBy: 'user-1',
    });
    expect(pending[0]?.error).toContain('HTTP 500');
    // The pending record carries everything a retry needs, so the active row is gone with the workspace.
    expect(await store.listForWorkspace('workspace-1')).toEqual([]);
  });
});
