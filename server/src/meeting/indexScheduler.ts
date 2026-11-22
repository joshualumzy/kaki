import { errorMessage } from '@kaki/shared';

/** Runs one workspace's knowledge index on a fixed interval while a meeting is open. */
export interface WorkspaceIndexScheduler {
  /** A meeting of the workspace opened; the first one starts the timer. */
  opened(workspaceId: string): void;
  /** A meeting of the workspace closed; the last one stops the timer. */
  closed(workspaceId: string): void;
  /** Stop every timer, on app shutdown. Safe to call more than once. */
  close(): void;
}

export interface WorkspaceIndexSchedulerOptions {
  /** How often an open workspace is reindexed; tests set it low. */
  intervalMs: number;
  /** Refresh one workspace's knowledge; failures are logged and never stop the timer. */
  index(workspaceId: string): void | Promise<void>;
  log?: (message: string) => void;
}

/**
 * One timer per workspace, started by the first open meeting and stopped by the last close.
 * The timer is unref'd so it never keeps the process alive on its own.
 */
export function createWorkspaceIndexScheduler({
  intervalMs,
  index,
  log = (message) => console.error(message),
}: WorkspaceIndexSchedulerOptions): WorkspaceIndexScheduler {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`kaki indexer: the workspace index interval must be a positive number, got ${intervalMs}`);
  }
  const counts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  let closed = false;

  function run(workspaceId: string): void {
    Promise.resolve()
      .then(() => index(workspaceId))
      .catch((error: unknown) =>
        log(`kaki indexer: scheduled reindex of workspace ${workspaceId} failed: ${errorMessage(error)}`),
      );
  }

  return {
    opened(workspaceId) {
      if (closed) return;
      const next = (counts.get(workspaceId) ?? 0) + 1;
      counts.set(workspaceId, next);
      if (next !== 1) return;
      const timer = setInterval(() => run(workspaceId), intervalMs);
      timer.unref?.();
      timers.set(workspaceId, timer);
    },
    closed(workspaceId) {
      const next = (counts.get(workspaceId) ?? 0) - 1;
      if (next > 0) {
        counts.set(workspaceId, next);
        return;
      }
      counts.delete(workspaceId);
      const timer = timers.get(workspaceId);
      if (timer === undefined) return;
      clearInterval(timer);
      timers.delete(workspaceId);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      counts.clear();
    },
  };
}
