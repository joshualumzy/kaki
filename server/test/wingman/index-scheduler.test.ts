import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceIndexScheduler } from '../../src/meeting/indexScheduler';

describe('workspace index scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the first open meeting and stops on the last close', async () => {
    const indexed: string[] = [];
    const scheduler = createWorkspaceIndexScheduler({
      intervalMs: 1_000,
      index: (workspaceId) => {
        indexed.push(workspaceId);
      },
    });

    scheduler.opened('ws-a');
    scheduler.opened('ws-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(indexed).toEqual(['ws-a']);

    scheduler.closed('ws-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(indexed).toEqual(['ws-a', 'ws-a']);

    scheduler.closed('ws-a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(indexed).toEqual(['ws-a', 'ws-a']);
    expect(vi.getTimerCount()).toBe(0);

    scheduler.close();
  });

  it('leaves no timers after shutdown', async () => {
    const indexed: string[] = [];
    const scheduler = createWorkspaceIndexScheduler({
      intervalMs: 1_000,
      index: (workspaceId) => {
        indexed.push(workspaceId);
      },
    });

    scheduler.opened('ws-a');
    scheduler.opened('ws-b');
    expect(vi.getTimerCount()).toBe(2);

    scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(indexed).toEqual([]);
  });

  it('keeps the timer after a failed reindex and says which workspace failed', async () => {
    const errors: string[] = [];
    let calls = 0;
    const scheduler = createWorkspaceIndexScheduler({
      intervalMs: 1_000,
      index: async () => {
        calls += 1;
        throw new Error('gateway down');
      },
      log: (message) => errors.push(message),
    });

    scheduler.opened('ws-a');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('ws-a');
    expect(errors[0]).toContain('gateway down');

    scheduler.close();
  });
});
