import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildIcs, writeCalendarEvent, type CalendarSettings } from '../action/calendar';
import { buildMeetingIcs } from './calendarEvent';
import {
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  type EncryptedSecret,
} from '../workspace/secrets';

/** Where the event lives now, without its password. */
export interface CalendarBinding {
  caldavUrl: string;
  viewBaseUrl: string;
  user?: string;
  calendar?: string;
}

/** One calendar event that could not be taken off its calendar, kept until a retry succeeds. */
export interface PendingCalendarCancellation {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  meetingId: string | null;
  /** A meeting event uses UTC instants; a follow-up keeps the floating clock time it was saved with. */
  source: 'meeting' | 'followup';
  uid: string;
  /** The cancellation's SEQUENCE, already one past the resource's last write. */
  sequence: number;
  fileId: string;
  title: string;
  description: string;
  start: string;
  durationMinutes: number;
  binding: CalendarBinding;
  secret: EncryptedSecret | null;
  error: string;
  attempts: number;
  requestedBy: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
}

export type PendingCalendarCancellationInput = Omit<
  PendingCalendarCancellation,
  'id' | 'attempts' | 'createdAt' | 'lastAttemptAt'
>;

/** The durable side of a failed cancellation, so no external event is silently left behind. */
export interface CalendarCancellationStore {
  add(input: PendingCalendarCancellationInput): Promise<PendingCalendarCancellation>;
  get(id: string): Promise<PendingCalendarCancellation | undefined>;
  listForWorkspace(workspaceId: string): Promise<PendingCalendarCancellation[]>;
  listForUser(userId: string): Promise<PendingCalendarCancellation[]>;
  markAttempt(id: string, error: string, at: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The public shape a route may show: never a secret, even encrypted. */
export function pendingCancellationView(record: PendingCalendarCancellation) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    meetingId: record.meetingId,
    source: record.source,
    uid: record.uid,
    title: record.title,
    start: record.start,
    error: record.error,
    attempts: record.attempts,
    requestedBy: record.requestedBy,
    createdAt: record.createdAt,
    lastAttemptAt: record.lastAttemptAt,
  };
}

/** Seal one live calendar's settings for a later retry, keeping its password encrypted. */
export function sealCalendarBinding(settings: CalendarSettings): {
  binding: CalendarBinding;
  secret: EncryptedSecret | null;
} {
  const { password, ...binding } = settings;
  if (password === undefined || password === '') return { binding, secret: null };
  return { binding, secret: encryptSecret(password, parseSecretKey(process.env.KAKI_SECRET_KEY)) };
}

/** Build live settings from a stored binding and its encrypted password. */
export function openStoredCalendar(
  binding: CalendarBinding,
  secret: EncryptedSecret | null,
): CalendarSettings {
  if (secret === null) return { ...binding };
  return {
    ...binding,
    password: decryptSecret(secret, parseSecretKey(process.env.KAKI_SECRET_KEY)),
  };
}

/** Build live settings from a pending cancellation's stored binding. */
export function openCalendarBinding(record: PendingCalendarCancellation): CalendarSettings {
  return openStoredCalendar(record.binding, record.secret);
}

/** Build the cancellation resource for a pending record, in the format it was originally saved. */
function cancellationIcs(record: PendingCalendarCancellation, now: Date): string {
  if (record.source === 'followup') {
    return buildIcs(
      record.uid,
      record.title,
      { start: record.start, durationMinutes: record.durationMinutes },
      record.description,
      now,
      { sequence: record.sequence, cancelled: true },
    );
  }
  return buildMeetingIcs({
    uid: record.uid,
    sequence: record.sequence,
    title: record.title,
    description: record.description,
    start: new Date(record.start).toISOString(),
    durationMinutes: record.durationMinutes,
    cancelled: true,
    now,
  });
}

export interface CalendarCancellationService {
  record(input: PendingCalendarCancellationInput): Promise<PendingCalendarCancellation>;
  retry(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  listForWorkspace(workspaceId: string): Promise<PendingCalendarCancellation[]>;
  listForUser(userId: string): Promise<PendingCalendarCancellation[]>;
}

/** Record failed cancellations and retry them against the binding captured when they failed. */
export function createCalendarCancellationService({
  store,
  fetchImpl = fetch,
  timeoutMs,
  now = Date.now,
}: {
  store: CalendarCancellationStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): CalendarCancellationService {
  async function retryOne(record: PendingCalendarCancellation) {
    let ics: string;
    try {
      ics = cancellationIcs(record, new Date(now()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The event could not be rebuilt.';
      await store.markAttempt(record.id, message, new Date(now()).toISOString());
      return { ok: false as const, error: message };
    }
    let settings: CalendarSettings;
    try {
      settings = openCalendarBinding(record);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The calendar login could not be read.';
      await store.markAttempt(record.id, message, new Date(now()).toISOString());
      return { ok: false as const, error: message };
    }
    const written = await writeCalendarEvent(
      settings,
      record.fileId,
      ics,
      fetchImpl,
      timeoutMs,
    );
    if (written.ok) {
      await store.remove(record.id);
      return { ok: true as const };
    }
    await store.markAttempt(record.id, written.message, new Date(now()).toISOString());
    return { ok: false as const, error: written.message };
  }

  return {
    record(input) {
      return store.add(input);
    },
    async retry(id) {
      const record = await store.get(id);
      if (record === undefined) {
        return { ok: false, error: 'That cancellation is no longer waiting.' };
      }
      return retryOne(record);
    },
    listForWorkspace(workspaceId) {
      return store.listForWorkspace(workspaceId);
    },
    listForUser(userId) {
      return store.listForUser(userId);
    },
  };
}

interface CancellationRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  meeting_id: string | null;
  source: string;
  uid: string;
  sequence: number;
  file_id: string;
  title: string;
  description: string;
  start_text: string;
  duration_minutes: number;
  calendar: CalendarBinding;
  secret: Buffer | null;
  iv: Buffer | null;
  tag: Buffer | null;
  key_id: string | null;
  error: string;
  attempts: number;
  requested_by: string | null;
  created_at: Date | string;
  last_attempt_at: Date | string | null;
}

function fromRow(row: CancellationRow): PendingCalendarCancellation {
  const secret =
    row.secret === null || row.iv === null || row.tag === null || row.key_id === null
      ? null
      : { secret: row.secret, iv: row.iv, tag: row.tag, keyId: row.key_id };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    meetingId: row.meeting_id,
    source: row.source === 'followup' ? 'followup' : 'meeting',
    uid: row.uid,
    sequence: row.sequence,
    fileId: row.file_id,
    title: row.title,
    description: row.description,
    start: row.start_text,
    durationMinutes: row.duration_minutes,
    binding: row.calendar,
    secret,
    error: row.error,
    attempts: row.attempts,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at).toISOString(),
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(row.last_attempt_at).toISOString(),
  };
}

const COLUMNS =
  'id, workspace_id, workspace_name, meeting_id, source, uid, sequence, file_id, title, description, start_text, duration_minutes, calendar, secret, iv, tag, key_id, error, attempts, requested_by, created_at, last_attempt_at';

/** The Postgres-backed pending cancellations; they outlive their workspace row on purpose. */
export function createPostgresCalendarCancellationStore(pool: Pool): CalendarCancellationStore {
  const secretValues = (input: PendingCalendarCancellationInput) => [
    input.secret?.secret ?? null,
    input.secret?.iv ?? null,
    input.secret?.tag ?? null,
    input.secret?.keyId ?? null,
  ];
  return {
    async add(input) {
      const id = randomUUID();
      const result = await pool.query<CancellationRow>(
        `insert into calendar_cancellations
           (id, workspace_id, workspace_name, meeting_id, source, uid, sequence, file_id, title, description,
            start_text, duration_minutes, calendar, secret, iv, tag, key_id, error, requested_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19)
         returning ${COLUMNS}`,
        [
          id,
          input.workspaceId,
          input.workspaceName,
          input.meetingId,
          input.source,
          input.uid,
          input.sequence,
          input.fileId,
          input.title,
          input.description,
          input.start,
          input.durationMinutes,
          JSON.stringify(input.binding),
          ...secretValues(input),
          input.error,
          input.requestedBy,
        ],
      );
      return fromRow(result.rows[0] as CancellationRow);
    },
    async get(id) {
      const result = await pool.query<CancellationRow>(
        `select ${COLUMNS} from calendar_cancellations where id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : fromRow(row);
    },
    async listForWorkspace(workspaceId) {
      const result = await pool.query<CancellationRow>(
        `select ${COLUMNS} from calendar_cancellations where workspace_id = $1 order by created_at asc`,
        [workspaceId],
      );
      return result.rows.map(fromRow);
    },
    async listForUser(userId) {
      const result = await pool.query<CancellationRow>(
        `select ${COLUMNS} from calendar_cancellations where requested_by = $1 order by created_at asc`,
        [userId],
      );
      return result.rows.map(fromRow);
    },
    async markAttempt(id, error, at) {
      await pool.query(
        `update calendar_cancellations
            set error = $2, attempts = attempts + 1, last_attempt_at = $3
          where id = $1`,
        [id, error, at],
      );
    },
    async remove(id) {
      await pool.query('delete from calendar_cancellations where id = $1', [id]);
    },
  };
}

/** An in-memory pending store for tests and a database-less server. */
export function createMemoryCalendarCancellationStore(): CalendarCancellationStore {
  const rows = new Map<string, PendingCalendarCancellation>();
  return {
    async add(input) {
      const record: PendingCalendarCancellation = {
        ...input,
        id: randomUUID(),
        attempts: 0,
        createdAt: new Date().toISOString(),
        lastAttemptAt: null,
      };
      rows.set(record.id, record);
      return record;
    },
    async get(id) {
      const record = rows.get(id);
      return record === undefined ? undefined : { ...record };
    },
    async listForWorkspace(workspaceId) {
      return [...rows.values()]
        .filter((record) => record.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async listForUser(userId) {
      return [...rows.values()]
        .filter((record) => record.requestedBy === userId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async markAttempt(id, error, at) {
      const record = rows.get(id);
      if (record === undefined) return;
      rows.set(id, { ...record, error, attempts: record.attempts + 1, lastAttemptAt: at });
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

