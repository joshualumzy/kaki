import { Pool } from 'pg';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from './postgres';
import {
  assertCompatibleSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingSnapshot,
  type MeetingStateStore,
  type StoredMeeting,
} from './state';

/** How the meeting module reads its current snapshot when a save is due. */
export type MeetingSnapshotSource = () => MeetingSnapshot | undefined;

/**
 * Saves the meeting across a restart. Writes and clears happen in call order, one at a time; only
 * consecutive saves collapse to the latest state, so a clear can never overtake a save queued after it.
 */
export interface MeetingPersistence {
  /** The compatible meeting found at startup, if any. */
  readonly saved: StoredMeeting | undefined;
  /** The meeting module supplies how to read its current state. */
  registerSource(source: MeetingSnapshotSource): void;
  /** Queue a save of the latest state; safe to call on every change. */
  scheduleSave(): void;
  /**
   * Delete the saved meeting, after everything queued before it. A failed clear stays at the head of
   * the queue, is retried before later saves, and rejects this call so the caller can tell the host.
   */
  clearSaved(): Promise<void>;
  /**
   * Persist the current meeting over the saved one for a committed reset. A delete that fails must
   * not block the overwrite: the new meeting is saved over the old row instead, and the failure is
   * logged. Nothing is awaited; the reset does not depend on the database.
   */
  replaceSaved(): void;
  /** Wait for queued writes; used by shutdown and tests. */
  flush(): Promise<void>;
  /** Finish queued writes and release the database connection. */
  close(): Promise<void>;
}

export interface MeetingPersistenceOptions {
  store: MeetingStateStore;
  saved?: StoredMeeting;
  now?: () => Date;
  log?: (message: string) => void;
  closeStore?: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SaveEntry {
  kind: 'save';
}

interface ClearWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface ClearEntry {
  kind: 'clear';
  waiters: ClearWaiter[];
}

/** A committed reset: delete the old meeting, or save the new one over it if deleting fails. */
interface ReplaceEntry {
  kind: 'replace';
}

type QueueEntry = SaveEntry | ClearEntry | ReplaceEntry;

/** Tell everyone waiting on this clear that the attempt succeeded. */
function resolveClear(entry: ClearEntry): void {
  for (const waiter of entry.waiters.splice(0)) waiter.resolve();
}

/** Tell everyone waiting on this clear that the attempt failed. */
function rejectClear(entry: ClearEntry, error: unknown): void {
  for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
}

/** Create the ordered saver over a store; nothing is written until `scheduleSave` is called. */
export function createMeetingPersistence({
  store,
  saved,
  now = () => new Date(),
  log = (message) => console.error(message),
  closeStore,
}: MeetingPersistenceOptions): MeetingPersistence {
  let source: MeetingSnapshotSource | undefined;
  let closed = false;
  // Writes and clears in call order. The head is what runs next; a failed clear stays there and blocks
  // later saves until a retry succeeds, unless a committed reset is queued behind it to save over it.
  const queue: QueueEntry[] = [];
  let processing: Promise<void> | undefined;
  // Work arrived while the queue was running: it must run again even if the loop stopped on a failed clear.
  let rerun = false;

  async function runSave(): Promise<void> {
    let snapshot: ReturnType<MeetingSnapshotSource>;
    try {
      snapshot = source?.();
    } catch (error) {
      log(`[persist] could not read the meeting to save: ${errorMessage(error)}`);
      return;
    }
    if (snapshot === undefined) return;
    try {
      await store.save({
        schemaVersion: MEETING_STATE_SCHEMA_VERSION,
        savedAt: now().toISOString(),
        ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
        state: snapshot.state,
        setup: snapshot.setup,
        ...(snapshot.draftTouched === undefined ? {} : { draftTouched: snapshot.draftTouched }),
        meetingCode: snapshot.meetingCode,
        seats: snapshot.seats,
      });
    } catch (error) {
      // A database problem must not take the meeting down; it is logged every time it happens.
      log(`[persist] save failed: ${errorMessage(error)}`);
    }
  }

  /** Save the new meeting over a failed delete, after saying loudly that the delete failed. */
  async function overwriteAfterFailedClear(error: unknown): Promise<void> {
    log(`[persist] clear failed: ${errorMessage(error)}`);
    log(
      'kaki persist: the old saved meeting could not be deleted; overwriting it with the new meeting',
    );
    await runSave();
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const head = queue[0]!;
      if (head.kind === 'save') {
        queue.shift();
        await runSave();
        continue;
      }
      if (head.kind === 'replace') {
        queue.shift();
        try {
          await store.clear();
        } catch (error) {
          await overwriteAfterFailedClear(error);
        }
        continue;
      }
      try {
        await store.clear();
      } catch (error) {
        rejectClear(head, error);
        // A committed reset behind this clear supersedes it: the old meeting is overwritten by the
        // new one, so neither the failed delete nor the reset entry may stay queued.
        const replaceIndex = queue.findIndex((entry) => entry.kind === 'replace');
        if (replaceIndex < 0) {
          log(`[persist] clear failed: ${errorMessage(error)}`);
          // Leave the clear at the head: the next save retries it first rather than overwriting it.
          return;
        }
        queue.splice(0, replaceIndex + 1);
        await overwriteAfterFailedClear(error);
        continue;
      }
      queue.shift();
      resolveClear(head);
    }
  }

  /** Retry a clear left at the head at shutdown; the caller decides what to do if it fails again. */
  async function retryClearOnce(): Promise<void> {
    const head = queue[0];
    if (head?.kind !== 'clear') return;
    try {
      await store.clear();
    } catch (error) {
      log(
        'kaki persist: could not clear the saved meeting; it will be restored on next start. ' +
          'Run npm run meeting:reset to discard it.',
      );
      rejectClear(head, error);
      return;
    }
    queue.shift();
    resolveClear(head);
  }

  function start(): void {
    if (processing !== undefined) {
      rerun = true;
      return;
    }
    rerun = false;
    // Start on the next tick: a save must read its snapshot after every subscriber has applied the
    // event that asked for it, not halfway through the same publish.
    processing = Promise.resolve()
      .then(drain)
      .catch((error: unknown) => log(`[persist] the write queue failed: ${errorMessage(error)}`))
      .finally(() => {
        processing = undefined;
        if (rerun && queue.length > 0) start();
      });
  }

  function scheduleSave(): void {
    if (closed) return;
    // Only consecutive saves collapse: a clear between two saves keeps both, in order.
    if (queue[queue.length - 1]?.kind !== 'save') queue.push({ kind: 'save' });
    // Even a collapsed save asks the queue to run, so it retries a failed clear waiting at the head.
    start();
  }

  function replaceSaved(): void {
    if (closed) return;
    // One replacement is enough: it deletes the old meeting or saves over it, and any saves queued
    // after it write the latest state. Converting a queued save otherwise avoids writing it twice.
    if (!queue.some((entry) => entry.kind === 'replace')) {
      if (queue[queue.length - 1]?.kind === 'save') queue[queue.length - 1] = { kind: 'replace' };
      else queue.push({ kind: 'replace' });
    }
    start();
  }

  function clearSaved(): Promise<void> {
    if (closed) return Promise.reject(new Error('the meeting store is closed'));
    return new Promise<void>((resolve, reject) => {
      // Only one clear is ever queued: a second request joins it, so one attempt settles every caller
      // instead of leaving another promise waiting behind the same failed clear.
      const existing = queue.find((entry): entry is ClearEntry => entry.kind === 'clear');
      if (existing !== undefined) {
        existing.waiters.push({ resolve, reject });
      } else {
        queue.push({ kind: 'clear', waiters: [{ resolve, reject }] });
      }
      start();
    });
  }

  async function flush(): Promise<void> {
    for (;;) {
      const running = processing;
      if (running !== undefined) {
        await running.catch(() => undefined);
        continue;
      }
      if (queue.length === 0) return;
      if (queue[0]!.kind === 'clear') {
        // A committed reset behind the clear knows how to save over the old row, so let the queue
        // run; only a clear with nothing to overwrite gets the single shutdown retry.
        if (queue.some((entry) => entry.kind === 'replace')) {
          start();
          continue;
        }
        await retryClearOnce();
        // Retry a failed clear only once at shutdown: a database that is still down must not spin,
        // and later saves must not overwrite the meeting that clear is protecting.
        if (queue[0]?.kind === 'clear') return;
        continue;
      }
      start();
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    await flush();
    closed = true;
    if (closeStore !== undefined) {
      try {
        await closeStore();
      } catch (error) {
        log(`[persist] closing the database failed: ${errorMessage(error)}`);
      }
    }
  }

  return {
    saved,
    registerSource(next) {
      source = next;
    },
    scheduleSave,
    clearSaved,
    replaceSaved,
    flush,
    close,
  };
}

/**
 * Build persistence from the same Postgres sign-in uses. With no POSTGRES_URL the server runs as
 * before and the meeting simply does not survive a restart. A database that cannot be read stops
 * startup with a clear message, the same way sign-in does.
 */
export async function createMeetingPersistenceFromEnv({
  env = process.env,
  log = (message) => console.log(message),
}: {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
} = {}): Promise<MeetingPersistence | undefined> {
  const connectionString = env.POSTGRES_URL?.trim();
  if (connectionString === undefined || connectionString === '') {
    log('kaki persist: POSTGRES_URL is not set; the meeting will not survive a restart');
    return undefined;
  }

  const pool = new Pool({ connectionString });
  pool.on('error', (error) => console.error('kaki persist: database error', error));

  try {
    await ensureMeetingStateSchema(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(`kaki persist: could not reach Postgres to save the meeting: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const store = createPostgresMeetingStateStore(pool);
  let saved: StoredMeeting | undefined;
  try {
    saved = await store.load();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(`kaki persist: could not load the saved meeting: ${errorMessage(error)}`, { cause: error });
  }

  if (saved !== undefined) {
    try {
      assertCompatibleSavedMeeting(saved);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    log(
      saved.startedAt === undefined
        ? 'kaki persist: restored the saved meeting setup'
        : `kaki persist: restored the meeting that started at ${saved.startedAt}`,
    );
  }

  return createMeetingPersistence({
    store,
    saved,
    closeStore: () => pool.end(),
  });
}
