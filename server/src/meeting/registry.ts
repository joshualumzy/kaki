import { randomBytes } from 'node:crypto';
import { normalizeMeetingCode } from '@kaki/shared';
import type { Pool } from 'pg';
import { ensureMeetingsSchema } from '../auth/schema';
import type { MeetingPersistence } from '../persist/persistence';
import type { MeetingInstance } from './instance';
import { agendaFromStored } from './agenda';
import type { AgendaItem, ArchivedMeetingTodo, MeetingMinutesArchive, MeetingRow, MeetingStatus } from './types';

/** A registry refusal the HTTP layer turns into a 503 with this exact message. */
export class MeetingBusyError extends Error {
  readonly code = 'busy';
  constructor() {
    super('Kaki is running as many meetings as it can right now. Try again in a few minutes.');
  }
}

/** The `meetings` rows this server can load and list. */
export interface MeetingStore {
  create(input: {
    workspaceId: string;
    ownerUserId: string;
    title: string;
    status?: MeetingStatus;
    scheduledFor?: string;
    agenda?: AgendaItem[];
  }): Promise<MeetingRow>;
  get(id: string): Promise<MeetingRow | undefined>;
  list(workspaceId: string): Promise<MeetingRow[]>;
  /** Mark the row ended once the meeting finishes, so workspace pages show it as over. */
  markEnded?(id: string, endedAt: string): Promise<void>;
  /** Keep Kaki's own copy of the minutes and to-dos with the meeting row. */
  saveMinutes?(id: string, archive: { minutes: string; todos: ArchivedMeetingTodo[] }): Promise<void>;
  /** Tick one archived to-do done or not; returns the updated list, or undefined when there is no archive. */
  setTodoDone?(id: string, taskId: string, done: boolean): Promise<ArchivedMeetingTodo[] | undefined>;
  /** Release the store's connection, when it owns one. */
  close?(): Promise<void>;
}

/** One open meeting as the runner's control channel sees it. */
export interface OpenMeeting {
  meetingId: string;
  kind: 'real' | 'practice';
  roomName: string;
}

/** The server's one owner of the open meetings and their lazy loading. */
export interface MeetingRegistry {
  create(input: {
    workspaceId: string;
    ownerUserId: string;
    title: string;
    scheduledFor?: string;
    agenda?: AgendaItem[];
  }): Promise<MeetingRow>;
  /** The loaded instance, or one rebuilt from its row; undefined when no such meeting exists. */
  get(id: string): Promise<MeetingInstance | undefined>;
  /** The practice/owner instance of today, always loaded. */
  legacy(): MeetingInstance;
  list(workspaceId: string): Promise<MeetingRow[]>;
  /**
   * The id of the open or scheduled real meeting whose code this is, or undefined. A loaded meeting
   * is matched on its current code; an unloaded one on the code saved with it. A meeting that was
   * never opened has no code yet, so it cannot be found this way.
   */
  findByCode(code: string): Promise<string | undefined>;
  /** Save and dispose one meeting; its row and saved state stay. */
  unload(id: string): Promise<void>;
  /** Every open meeting, for a runner connecting (or reconnecting) to the control channel. */
  openMeetings(): OpenMeeting[];
  close(): Promise<void>;
}

interface MeetingRegistryDeps {
  legacy: MeetingInstance;
  store: MeetingStore;
  /** Build an instance from its row; persistence is already loaded for it. */
  buildInstance(row: MeetingRow, persistence: MeetingPersistence | undefined): Promise<MeetingInstance>;
  /** Load the meeting's saved state; absent means memory only. */
  persistenceFor?(id: string): Promise<MeetingPersistence | undefined>;
  /** The id of the meeting whose saved state holds this code; absent means loaded meetings only. */
  findSavedIdByCode?(code: string): Promise<string | undefined>;
  maxOpen?: number;
  unloadMs?: number;
  sweepMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** A meeting was opened (loaded) or closed (unloaded), for the runner control channel. */
  onOpened?(meeting: OpenMeeting): void;
  onClosed?(meetingId: string): void;
  /** A meeting of a workspace opened or closed, so its periodic index can start or stop. */
  onWorkspaceOpened?(workspaceId: string): void;
  onWorkspaceClosed?(workspaceId: string): void;
}

const DEFAULT_MAX_OPEN = 10;
const DEFAULT_UNLOAD_MS = 30 * 60_000;
const DEFAULT_SWEEP_MS = 60_000;

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`kaki meetings: ${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

/** The registry key of the one legacy practice instance. */
export const LEGACY_MEETING_ID = 'meeting';

/** Generate a meeting id: 22 base64url characters from 128 random bits. */
export function newMeetingId(): string {
  return randomBytes(16).toString('base64url');
}

/** Create the registry over a meeting store; nothing is restored eagerly. */
export function createMeetingRegistry(deps: MeetingRegistryDeps): MeetingRegistry {
  const maxOpen = deps.maxOpen ?? positiveEnvNumber('KAKI_MAX_OPEN_MEETINGS', DEFAULT_MAX_OPEN);
  const unloadMs = deps.unloadMs ?? positiveEnvNumber('KAKI_MEETING_UNLOAD_MS', DEFAULT_UNLOAD_MS);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.log(message));
  const loaded = new Map<string, MeetingInstance>();
  const persistences = new Map<string, MeetingPersistence>();
  const loading = new Map<string, Promise<MeetingInstance | undefined>>();
  let closed = false;

  const openMeeting = (instance: MeetingInstance): OpenMeeting => ({
    meetingId: instance.id,
    kind: instance.runnerKind,
    roomName: instance.roomName,
  });

  const openCount = (): number => loaded.size + 1; // the legacy instance is always open

  async function closeInstance(instance: MeetingInstance): Promise<void> {
    loaded.delete(instance.id);
    const persistence = persistences.get(instance.id);
    persistences.delete(instance.id);
    try {
      await instance.dispose();
    } catch (error) {
      log(`kaki meetings: closing ${instance.id} failed: ${String(error)}`);
    }
    await persistence?.close().catch((error: unknown) =>
      log(`kaki meetings: closing the saved meeting ${instance.id} failed: ${String(error)}`),
    );
    deps.onClosed?.(instance.id);
    deps.onWorkspaceClosed?.(instance.workspaceId);
  }

  async function load(id: string): Promise<MeetingInstance | undefined> {
    if (closed) throw new Error('the meeting registry is closed');
    const row = await deps.store.get(id);
    if (row === undefined) return undefined;
    if (openCount() >= maxOpen) {
      log(`kaki meetings: refusing to open ${id}: ${openCount()} meetings are already open`);
      throw new MeetingBusyError();
    }
    const persistence = await deps.persistenceFor?.(id);
    if (persistence !== undefined) persistences.set(id, persistence);
    const instance = await deps.buildInstance(row, persistence);
    loaded.set(id, instance);
    deps.onOpened?.(openMeeting(instance));
    deps.onWorkspaceOpened?.(instance.workspaceId);
    return instance;
  }

  const registry: MeetingRegistry = {
    async create({ workspaceId, ownerUserId, title, scheduledFor, agenda }) {
      const cleanTitle = title.trim();
      if (cleanTitle === '') throw new Error('a meeting needs a title');
      const scheduledAt = scheduledFor === undefined ? undefined : Date.parse(scheduledFor);
      if (scheduledAt !== undefined && Number.isNaN(scheduledAt)) {
        throw new Error('a meeting scheduledFor must be a date');
      }
      const status: MeetingStatus = scheduledAt !== undefined && scheduledAt > now() ? 'scheduled' : 'open';
      return deps.store.create({
        workspaceId,
        ownerUserId,
        title: cleanTitle,
        status,
        ...(scheduledFor === undefined ? {} : { scheduledFor }),
        ...(agenda === undefined ? {} : { agenda }),
      });
    },

    async get(id) {
      if (id === LEGACY_MEETING_ID) return deps.legacy;
      const open = loaded.get(id);
      if (open !== undefined) return open;
      const pending = loading.get(id);
      if (pending !== undefined) return pending;
      const loadPromise = load(id).finally(() => loading.delete(id));
      loading.set(id, loadPromise);
      return loadPromise;
    },

    async findByCode(code) {
      const wanted = normalizeMeetingCode(code);
      if (wanted === '') return undefined;
      const isLive = async (id: string): Promise<boolean> => {
        const row = await deps.store.get(id);
        return row !== undefined && row.status !== 'ended';
      };
      for (const instance of loaded.values()) {
        if (normalizeMeetingCode(instance.meetingCode()) === wanted && (await isLive(instance.id))) {
          return instance.id;
        }
      }
      const savedId = await deps.findSavedIdByCode?.(wanted);
      if (savedId === undefined || savedId === LEGACY_MEETING_ID) return undefined;
      // A loaded meeting's code is the one it holds now; a stale saved copy must not match.
      const open = loaded.get(savedId);
      if (open !== undefined && normalizeMeetingCode(open.meetingCode()) !== wanted) return undefined;
      return (await isLive(savedId)) ? savedId : undefined;
    },

    legacy: () => deps.legacy,

    list: (workspaceId) => deps.store.list(workspaceId),

    async unload(id) {
      if (id === LEGACY_MEETING_ID) {
        throw new Error('the legacy practice meeting cannot be unloaded');
      }
      const instance = loaded.get(id);
      if (instance === undefined) return;
      await closeInstance(instance);
    },

    openMeetings() {
      return [openMeeting(deps.legacy), ...[...loaded.values()].map(openMeeting)];
    },

    async close() {
      if (closed) return;
      closed = true;
      if (sweep !== undefined) clearInterval(sweep);
      const instances = [...loaded.values()];
      loaded.clear();
      await Promise.all(
        instances.map(async (instance) => {
          try {
            await instance.dispose();
          } catch (error) {
            log(`kaki meetings: closing ${instance.id} failed: ${String(error)}`);
          }
          const persistence = persistences.get(instance.id);
          persistences.delete(instance.id);
          await persistence?.close().catch((error: unknown) =>
            log(`kaki meetings: closing the saved meeting ${instance.id} failed: ${String(error)}`),
          );
        }),
      );
    },
  };

  const sweep = setInterval(() => {
    const at = now();
    for (const instance of [...loaded.values()]) {
      if (instance.connectedPeople() > 0) continue;
      if (at - instance.lastActivityAt() < unloadMs) continue;
      log(`kaki meetings: unloading ${instance.id}; nobody has been there for ${Math.round(unloadMs / 60_000)} min`);
      void registry.unload(instance.id).catch((error: unknown) =>
        log(`kaki meetings: unloading ${instance.id} failed: ${String(error)}`),
      );
    }
  }, deps.sweepMs ?? DEFAULT_SWEEP_MS);
  sweep.unref?.();

  return registry;
}

/** The Postgres-backed meeting rows, shared with sign-in's pool. */
export function createPostgresMeetingStore(pool: Pool): MeetingStore {
  const row = (record: {
    id: string;
    workspace_id: string;
    owner_user_id: string | null;
    title: string;
    kind: string;
    status: string;
    scheduled_for: Date | string | null;
    agenda: unknown;
    created_at: Date | string;
    ended_at: Date | string | null;
    minutes_text?: string | null;
    minutes_todos?: ArchivedMeetingTodo[] | null;
    minutes_archived_at?: Date | string | null;
  }): MeetingRow => ({
    id: record.id,
    workspaceId: record.workspace_id,
    ownerUserId: record.owner_user_id,
    title: record.title,
    kind: 'real',
    status:
      record.status === 'scheduled' || record.status === 'ended' ? record.status : 'open',
    scheduledFor: record.scheduled_for === null ? null : new Date(record.scheduled_for).toISOString(),
    agenda: agendaFromStored(record.agenda),
    createdAt: new Date(record.created_at).toISOString(),
    endedAt: record.ended_at === null ? null : new Date(record.ended_at).toISOString(),
    ...(record.minutes_text === null || record.minutes_text === undefined
      ? {}
      : {
          minutes: {
            minutes: record.minutes_text,
            todos: record.minutes_todos ?? [],
            archivedAt:
              record.minutes_archived_at === null || record.minutes_archived_at === undefined
                ? new Date(record.created_at).toISOString()
                : new Date(record.minutes_archived_at).toISOString(),
          } satisfies MeetingMinutesArchive,
        }),
  });

  return {
    async create({ workspaceId, ownerUserId, title, status = 'open', scheduledFor, agenda = [] }) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        `insert into meetings (id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda)
         values ($1, $2, $3, $4, 'real', $5, $6, $7::jsonb)
         returning id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, created_at, ended_at,
                   minutes_text, minutes_todos, minutes_archived_at`,
        [newMeetingId(), workspaceId, ownerUserId, title, status, scheduledFor ?? null, JSON.stringify(agenda)],
      );
      return row(result.rows[0]);
    },
    async get(id) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where id = $1`,
        [id],
      );
      return result.rows[0] === undefined ? undefined : row(result.rows[0]);
    },
    async markEnded(id, endedAt) {
      await ensureMeetingsSchema(pool);
      await pool.query(
        "update meetings set status = 'ended', ended_at = $2 where id = $1 and status <> 'ended'",
        [id, endedAt],
      );
    },
    async saveMinutes(id, archive) {
      await ensureMeetingsSchema(pool);
      await pool.query(
        `update meetings
            set minutes_text = $2, minutes_todos = $3::jsonb, minutes_archived_at = now()
          where id = $1`,
        [id, archive.minutes, JSON.stringify(archive.todos)],
      );
    },
    async setTodoDone(id, taskId, done) {
      await ensureMeetingsSchema(pool);
      const current = await pool.query<{ minutes_todos: ArchivedMeetingTodo[] | null }>(
        'select minutes_todos from meetings where id = $1',
        [id],
      );
      const todos = current.rows[0]?.minutes_todos;
      if (todos === null || todos === undefined) return undefined;
      const next = todos.map((todo) => (todo.id === taskId ? { ...todo, done } : todo));
      if (!next.some((todo) => todo.id === taskId)) return undefined;
      await pool.query('update meetings set minutes_todos = $2::jsonb where id = $1', [
        id,
        JSON.stringify(next),
      ]);
      return next;
    },
    async list(workspaceId) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where workspace_id = $1 order by created_at desc`,
        [workspaceId],
      );
      return result.rows.map(row);
    },
  };
}

/** The in-memory meeting rows tests use when no database is configured. */
export function createMemoryMeetingStore(): MeetingStore & { rows: Map<string, MeetingRow> } {
  const rows = new Map<string, MeetingRow>();
  return {
    rows,
    async create({ workspaceId, ownerUserId, title, status = 'open', scheduledFor, agenda = [] }) {
      const meeting: MeetingRow = {
        id: newMeetingId(),
        workspaceId,
        ownerUserId,
        title,
        kind: 'real',
        status,
        scheduledFor: scheduledFor ?? null,
        agenda: [...agenda],
        createdAt: new Date().toISOString(),
        endedAt: null,
      };
      rows.set(meeting.id, meeting);
      return meeting;
    },
    async get(id) {
      return rows.get(id);
    },
    async markEnded(id, endedAt) {
      const meeting = rows.get(id);
      if (meeting === undefined) return;
      rows.set(id, { ...meeting, status: 'ended', endedAt });
    },
    async saveMinutes(id, archive) {
      const meeting = rows.get(id);
      if (meeting === undefined) return;
      rows.set(id, {
        ...meeting,
        minutes: { minutes: archive.minutes, todos: archive.todos.map((todo) => ({ ...todo })), archivedAt: new Date().toISOString() },
      });
    },
    async setTodoDone(id, taskId, done) {
      const meeting = rows.get(id);
      if (meeting?.minutes === undefined || meeting.minutes === null) return undefined;
      if (!meeting.minutes.todos.some((todo) => todo.id === taskId)) return undefined;
      const todos = meeting.minutes.todos.map((todo) => (todo.id === taskId ? { ...todo, done } : todo));
      rows.set(id, { ...meeting, minutes: { ...meeting.minutes, todos } });
      return todos.map((todo) => ({ ...todo }));
    },
    async list(workspaceId) {
      return [...rows.values()]
        .filter((meeting) => meeting.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
