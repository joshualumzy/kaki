import type { Pool } from 'pg';
import {
  buildIcs,
  writeCalendarEvent,
  type CalendarSettings,
} from '../action/calendar';
import { CalendarUnreachableError } from './calendarEvent';
import {
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  type EncryptedSecret,
} from '../workspace/secrets';

/** Where a follow-up event lives now, without its password. */
export interface CalendarBinding {
  caldavUrl: string;
  viewBaseUrl: string;
  user?: string;
  calendar?: string;
}

/** Seal one live calendar's settings, keeping its password encrypted. */
function sealCalendarBinding(settings: CalendarSettings): {
  binding: CalendarBinding;
  secret: EncryptedSecret | null;
} {
  const { password, ...binding } = settings;
  if (password === undefined || password === '') return { binding, secret: null };
  return { binding, secret: encryptSecret(password, parseSecretKey(process.env.KAKI_SECRET_KEY)) };
}

/** One approved follow-up event, kept with the workspace that must cancel it later. */
export interface TaskCalendarEvent {
  taskId: string;
  meetingId: string | null;
  workspaceId: string;
  uid: string;
  sequence: number;
  fileId: string;
  state: 'not_connected' | 'synced' | 'error';
  error: string | null;
  syncedAt: string | null;
  title: string;
  description: string;
  /** Floating local clock time, exactly as the follow-up was drafted. */
  start: string;
  durationMinutes: number;
  binding: CalendarBinding;
  secret: EncryptedSecret | null;
}

export interface TaskCalendarEventInput extends Omit<TaskCalendarEvent, 'syncedAt' | 'error' | 'state'> {
  state: TaskCalendarEvent['state'];
  error: string | null;
  syncedAt: string | null;
}

/** The follow-up event rows that workspace deletion must find. */
export interface TaskCalendarEventStore {
  get(taskId: string): Promise<TaskCalendarEvent | undefined>;
  save(event: TaskCalendarEventInput): Promise<void>;
  listForWorkspace(workspaceId: string): Promise<TaskCalendarEvent[]>;
  delete(taskId: string): Promise<void>;
  deleteForWorkspace(workspaceId: string): Promise<void>;
}

/** The stable identity one approved follow-up keeps when it is retried or edited. */
export function taskCalendarUid(taskId: string): string {
  return `kaki-${taskId}@kaki.local`;
}

function openTaskCalendar(record: TaskCalendarEvent): CalendarSettings {
  if (record.secret === null) return { ...record.binding };
  return {
    ...record.binding,
    password: decryptSecret(record.secret, parseSecretKey(process.env.KAKI_SECRET_KEY)),
  };
}

export interface TaskCalendarLifecycle {
  run(input: {
    taskId: string;
    meetingId: string | null;
    workspaceId: string;
    title: string;
    notes: string;
    start: string;
    durationMinutes: number;
    settings: CalendarSettings;
  }): Promise<{ uid: string; fileId: string; sequence: number }>;
  /**
   * Take every follow-up of a workspace off its calendar before the workspace disappears. Throws
   * CalendarUnreachableError when a cancellation cannot be written, unless `deleteAnyway` is set;
   * then the rows are still removed and the titles that may remain are returned.
   */
  cancelForWorkspace(
    workspaceId: string,
    options?: { deleteAnyway?: boolean },
  ): Promise<string[]>;
}

export function createTaskCalendarLifecycle({
  store,
  fetchImpl = fetch,
  timeoutMs,
  now = Date.now,
}: {
  store: TaskCalendarEventStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): TaskCalendarLifecycle {
  return {
    async run(input) {
      const existing = await store.get(input.taskId);
      const uid = existing?.uid ?? taskCalendarUid(input.taskId);
      const fileId = existing?.fileId ?? input.taskId;
      const sequence = existing === undefined ? 0 : existing.sequence + 1;
      let sealed: { binding: CalendarBinding; secret: EncryptedSecret | null };
      try {
        sealed = sealCalendarBinding(input.settings);
      } catch {
        const { password: _password, ...binding } = input.settings;
        sealed = { binding, secret: null };
      }
      const ics = buildIcs(
        uid,
        input.title,
        { start: input.start, durationMinutes: input.durationMinutes },
        input.notes,
        new Date(now()),
        { sequence },
      );
      const written = await writeCalendarEvent(
        input.settings,
        fileId,
        ics,
        fetchImpl,
        timeoutMs,
      );
      const common = {
        taskId: input.taskId,
        meetingId: input.meetingId,
        workspaceId: input.workspaceId,
        uid,
        sequence,
        fileId,
        title: input.title,
        description: input.notes,
        start: input.start,
        durationMinutes: input.durationMinutes,
        binding: sealed.binding,
        secret: sealed.secret,
      };
      if (!written.ok) {
        await store.save({
          ...common,
          state: 'error',
          error: written.message,
          syncedAt: existing?.syncedAt ?? null,
        });
        throw new Error(written.message);
      }
      await store.save({
        ...common,
        state: 'synced',
        error: null,
        syncedAt: new Date(now()).toISOString(),
      });
      return { uid, fileId, sequence };
    },

    async cancelForWorkspace(workspaceId, options = {}) {
      const remaining: string[] = [];
      for (const record of await store.listForWorkspace(workspaceId)) {
        try {
          await cancelOne(record);
          await store.delete(record.taskId);
        } catch (error) {
          if (options.deleteAnyway !== true) throw error;
          // The admin chose to delete anyway; its event may stay on the calendar.
          remaining.push(record.title);
          await store.delete(record.taskId);
        }
      }
      await store.deleteForWorkspace(workspaceId);
      return remaining;
    },
  };

  async function cancelOne(record: TaskCalendarEvent): Promise<void> {
    let settings: CalendarSettings;
    try {
      settings = openTaskCalendar(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The calendar login could not be read.';
      throw new CalendarUnreachableError(`${record.title}: ${message}`);
    }
    let ics: string;
    try {
      ics = buildIcs(
        record.uid,
        record.title,
        { start: record.start, durationMinutes: record.durationMinutes },
        record.description,
        new Date(now()),
        { sequence: record.sequence + 1, cancelled: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The event could not be rebuilt.';
      throw new CalendarUnreachableError(`${record.title}: ${message}`);
    }
    const written = await writeCalendarEvent(settings, record.fileId, ics, fetchImpl, timeoutMs);
    if (!written.ok) throw new CalendarUnreachableError(`${record.title}: ${written.message}`);
  }
}

interface TaskCalendarRow {
  task_id: string;
  meeting_id: string | null;
  workspace_id: string;
  uid: string;
  sequence: number;
  file_id: string;
  state: string;
  error: string | null;
  synced_at: Date | string | null;
  title: string;
  description: string;
  start_text: string;
  duration_minutes: number;
  calendar: CalendarBinding;
  secret: Buffer | null;
  iv: Buffer | null;
  tag: Buffer | null;
  key_id: string | null;
}

function fromRow(row: TaskCalendarRow): TaskCalendarEvent {
  const secret =
    row.secret === null || row.iv === null || row.tag === null || row.key_id === null
      ? null
      : { secret: row.secret, iv: row.iv, tag: row.tag, keyId: row.key_id };
  return {
    taskId: row.task_id,
    meetingId: row.meeting_id,
    workspaceId: row.workspace_id,
    uid: row.uid,
    sequence: row.sequence,
    fileId: row.file_id,
    state: row.state === 'synced' || row.state === 'error' ? row.state : 'not_connected',
    error: row.error,
    syncedAt: row.synced_at === null ? null : new Date(row.synced_at).toISOString(),
    title: row.title,
    description: row.description,
    start: row.start_text,
    durationMinutes: row.duration_minutes,
    binding: row.calendar,
    secret,
  };
}

const COLUMNS =
  'task_id, meeting_id, workspace_id, uid, sequence, file_id, state, error, synced_at, title, description, start_text, duration_minutes, calendar, secret, iv, tag, key_id';

function saveValues(event: TaskCalendarEventInput) {
  return [
    event.taskId,
    event.meetingId,
    event.workspaceId,
    event.uid,
    event.sequence,
    event.fileId,
    event.state,
    event.error,
    event.syncedAt,
    event.title,
    event.description,
    event.start,
    event.durationMinutes,
    JSON.stringify(event.binding),
    event.secret?.secret ?? null,
    event.secret?.iv ?? null,
    event.secret?.tag ?? null,
    event.secret?.keyId ?? null,
  ];
}

export function createPostgresTaskCalendarEventStore(pool: Pool): TaskCalendarEventStore {
  return {
    async get(taskId) {
      const result = await pool.query<TaskCalendarRow>(
        `select ${COLUMNS} from task_calendar_events where task_id = $1`,
        [taskId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : fromRow(row);
    },
    async save(event) {
      await pool.query(
        `insert into task_calendar_events
           (task_id, meeting_id, workspace_id, uid, sequence, file_id, state, error, synced_at,
            title, description, start_text, duration_minutes, calendar, secret, iv, tag, key_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
         on conflict (task_id) do update set
           meeting_id = excluded.meeting_id,
           workspace_id = excluded.workspace_id,
           uid = excluded.uid,
           sequence = excluded.sequence,
           file_id = excluded.file_id,
           state = excluded.state,
           error = excluded.error,
           synced_at = excluded.synced_at,
           title = excluded.title,
           description = excluded.description,
           start_text = excluded.start_text,
           duration_minutes = excluded.duration_minutes,
           calendar = excluded.calendar,
           secret = excluded.secret,
           iv = excluded.iv,
           tag = excluded.tag,
           key_id = excluded.key_id,
           updated_at = now()`,
        saveValues(event),
      );
    },
    async listForWorkspace(workspaceId) {
      const result = await pool.query<TaskCalendarRow>(
        `select ${COLUMNS} from task_calendar_events where workspace_id = $1 order by created_at asc`,
        [workspaceId],
      );
      return result.rows.map(fromRow);
    },
    async delete(taskId) {
      await pool.query('delete from task_calendar_events where task_id = $1', [taskId]);
    },
    async deleteForWorkspace(workspaceId) {
      await pool.query('delete from task_calendar_events where workspace_id = $1', [workspaceId]);
    },
  };
}

export function createMemoryTaskCalendarEventStore(): TaskCalendarEventStore {
  const rows = new Map<string, TaskCalendarEvent>();
  return {
    async get(taskId) {
      const row = rows.get(taskId);
      return row === undefined ? undefined : { ...row };
    },
    async save(event) {
      rows.set(event.taskId, { ...event });
    },
    async listForWorkspace(workspaceId) {
      return [...rows.values()].filter((row) => row.workspaceId === workspaceId);
    },
    async delete(taskId) {
      rows.delete(taskId);
    },
    async deleteForWorkspace(workspaceId) {
      for (const [taskId, row] of rows) {
        if (row.workspaceId === workspaceId) rows.delete(taskId);
      }
    },
  };
}
