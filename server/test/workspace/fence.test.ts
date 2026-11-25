import { describe, expect, it } from 'vitest';
import { createWorkspaceFence, WorkspaceFencedError } from '../../src/workspace/fence';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace fence', () => {
  it('drains an in-flight writer before a deletion and refuses writers afterwards', async () => {
    const fence = createWorkspaceFence();
    const hold = deferred();
    let sawDeletionStart = false;
    const inFlight = fence.run('workspace-1', async () => {
      await hold.promise;
      return 'saved';
    });
    const deletion = fence.beginDeletion('workspace-1').then((release) => {
      sawDeletionStart = true;
      return release;
    });

    // The deletion waits for the writer already inside the gate.
    await Promise.resolve();
    expect(sawDeletionStart).toBe(false);
    await expect(fence.run('workspace-1', async () => 'late')).rejects.toBeInstanceOf(
      WorkspaceFencedError,
    );
    hold.resolve();
    expect(await inFlight).toBe('saved');
    const release = await deletion;
    expect(sawDeletionStart).toBe(true);
    release();
    expect(await fence.run('workspace-1', async () => 'again')).toBe('again');
  });

  it('keeps background work inside the gate so a deletion waits for it', async () => {
    const fence = createWorkspaceFence();
    const hold = deferred();
    const tracked = fence.track('workspace-1', async () => {
      await hold.promise;
      return 'indexed';
    });
    const deletion = fence.beginDeletion('workspace-1');
    let started = false;
    void deletion.then(() => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    hold.resolve();
    expect(await tracked).toBe('indexed');
    const release = await deletion;
    release();
  });
});
