/** A write was refused because its workspace is being deleted. */
export class WorkspaceFencedError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} is being deleted.`);
    this.name = 'WorkspaceFencedError';
  }
}

/**
 * One in-process gate per workspace. A deletion takes the gate exclusively; every operation that
 * could create, load or rewrite workspace data runs through it in shared mode. The deletion waits
 * for work already inside the gate, then blocks new work, so a late writer cannot resurrect rows or
 * write a calendar event that the deletion never sees.
 */
export interface WorkspaceFence {
  /** Run work inside the gate; a deletion already in progress refuses it. */
  run<T>(workspaceId: string, task: () => Promise<T>): Promise<T>;
  /**
   * Run background work inside the gate without waiting for it. The gate stays held until the work
   * settles, so a deletion drains it instead of racing it.
   */
  track<T>(workspaceId: string, task: () => Promise<T>): Promise<T>;
  /**
   * Block new work for this workspace, wait for work already inside the gate to finish, then return
   * the release function the deletion calls when it is done.
   */
  beginDeletion(workspaceId: string): Promise<() => void>;
  isDeleting(workspaceId: string): boolean;
}

export function createWorkspaceFence(): WorkspaceFence {
  const active = new Map<string, number>();
  const deleting = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  function enter(workspaceId: string): void {
    if (deleting.has(workspaceId)) throw new WorkspaceFencedError(workspaceId);
    active.set(workspaceId, (active.get(workspaceId) ?? 0) + 1);
  }

  function leave(workspaceId: string): void {
    const next = (active.get(workspaceId) ?? 1) - 1;
    if (next > 0) {
      active.set(workspaceId, next);
      return;
    }
    active.delete(workspaceId);
    for (const resolve of waiters.get(workspaceId) ?? []) resolve();
    waiters.delete(workspaceId);
  }

  return {
    async run<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
      enter(workspaceId);
      try {
        return await task();
      } finally {
        leave(workspaceId);
      }
    },
    track<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
      try {
        enter(workspaceId);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve()
        .then(task)
        .finally(() => leave(workspaceId));
    },
    async beginDeletion(workspaceId: string): Promise<() => void> {
      deleting.add(workspaceId);
      while ((active.get(workspaceId) ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const queue = waiters.get(workspaceId) ?? [];
          queue.push(resolve);
          waiters.set(workspaceId, queue);
        });
      }
      return () => {
        deleting.delete(workspaceId);
      };
    },
    isDeleting(workspaceId: string): boolean {
      return deleting.has(workspaceId);
    },
  };
}
