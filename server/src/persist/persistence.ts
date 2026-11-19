import { Pool } from 'pg';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from './postgres';
import {
  assertCompatibleSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type SavedMeetingState,
  type StoredMeeting,
} from './state';

/** How the meeting module reads its own state when a save is due. */
export type MeetingSnapshotSource = () => { startedAt: string; state: SavedMeetingState } | undefined;

/**
 * Saves the meeting across a restart. `scheduleSave` never writes twice at once: while a write is in
 * flight newer state is remembered and written next, so the latest state wins.
 */
export interface MeetingPersistence {
  /** The compatible meeting found at startup, if any. */
  readonly saved: StoredMeeting | undefined;
  /** The meeting module supplies how to read its current state. */
  registerSource(source: MeetingSnapshotSource): void;
  /** Queue a save of the latest state; safe to call on every change. */
  scheduleSave(): void;
  /** Delete the saved meeting, after any write already in flight. */
  clearSaved(): Promise<void>;
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

/** Create the coalescing saver over a store; nothing is written until `scheduleSave` is called. */
export function createMeetingPersistence({
  store,
  saved,
  now = () => new Date(),
  log = (message) => console.error(message),
  closeStore,
}: MeetingPersistenceOptions): MeetingPersistence {
  let source: MeetingSnapshotSource | undefined;
  let dirty = false;
  let draining = false;
  let closed = false;
  // One promise chain: a clear queued during a write runs after it, never beside it.
  let tail: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    tail = tail.then(task, task);
    return tail;
  }

  function scheduleSave(): void {
    if (closed) return;
    dirty = true;
    if (draining) return;
    draining = true;
    void enqueue(async () => {
      try {
        while (dirty) {
          dirty = false;
          let snapshot: ReturnType<MeetingSnapshotSource>;
          try {
            snapshot = source?.();
          } catch (error) {
            log(`[persist] could not read the meeting to save: ${errorMessage(error)}`);
            continue;
          }
          if (snapshot === undefined) continue;
          try {
            await store.save({
              schemaVersion: MEETING_STATE_SCHEMA_VERSION,
              savedAt: now().toISOString(),
              startedAt: snapshot.startedAt,
              state: snapshot.state,
            });
          } catch (error) {
            // A database problem must not take the meeting down; it is logged every time it happens.
            log(`[persist] save failed: ${errorMessage(error)}`);
          }
        }
      } finally {
        draining = false;
      }
    });
  }

  async function clearSaved(): Promise<void> {
    dirty = false;
    await enqueue(async () => {
      try {
        await store.clear();
      } catch (error) {
        log(`[persist] clear failed: ${errorMessage(error)}`);
      }
    });
  }

  async function flush(): Promise<void> {
    // A change can queue another write while this one is being waited on; wait for those too.
    let seen: Promise<void>;
    do {
      seen = tail;
      await seen;
    } while (seen !== tail);
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
    log(`kaki persist: restored the meeting that started at ${saved.startedAt}`);
  }

  return createMeetingPersistence({
    store,
    saved,
    closeStore: () => pool.end(),
  });
}
