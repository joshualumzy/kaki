import { randomBytes } from 'node:crypto';
import { normalizeMeetingCode } from '@kaki/shared';
import type { Pool, PoolClient } from 'pg';
import { ensureMeetingsSchema } from '../auth/schema';
import type { MeetingPersistence } from '../persist/persistence';
import type { MeetingInstance } from './instance';
import { agendaFromStored } from './agenda';
import { SAMPLE_WORKSPACE_ID } from '../workspace/constants';
import type { AgendaItem, ArchivedMeetingTodo, MeetingMinutesArchive, MeetingRow, MeetingStatus } from './types';

/** A registry refusal the HTTP layer turns into a 503 with this exact message. */
export class MeetingBusyError extends Error {
  readonly code = 'busy';
  constructor(message = 'Kaki is running as many meetings as it can right now. Try again in a few minutes.') {
    super(message);
  }
}

/** A practice request refused because every practice room is in use right now. */
export class PracticeFullError extends Error {
  readonly code = 'practice-full';
  constructor(
    message = 'All practice rooms are in use right now. Please try again in a few minutes.',
  ) {
    super(message);
  }
}

/** The `meetings` rows this server can load and list. */
export interface MeetingStore {
  create(input: {
    /** A caller-chosen id, so a practice meeting's row matches its instance; defaults to a fresh id. */
    id?: string;
    workspaceId: string;
    ownerUserId: string;
    title: string;
    status?: MeetingStatus;
    scheduledFor?: string;
    agenda?: AgendaItem[];
  }): Promise<MeetingRow>;
  get(id: string): Promise<MeetingRow | undefined>;
  list(workspaceId: string): Promise<MeetingRow[]>;
  /** Every meeting row this account owns, whatever its status. */
  listByOwner?(ownerUserId: string): Promise<MeetingRow[]>;
  /**
   * Delete every meeting that sits in one of the given workspaces (with its saved state and seat
   * claims), and hand the rows the account owns in workspaces that stay to that workspace by
   * clearing their owner. Run inside `client` when it is given.
   */
  deleteByOwner?(
    ownerUserId: string,
    workspaceIds: readonly string[],
    client?: PoolClient,
  ): Promise<void>;
  /** How many meetings this owner created at or after the given time, for the daily cap. */
  countCreatedByOwnerSince(ownerUserId: string, since: Date): Promise<number>;
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
  /**
   * Open one fresh practice meeting for a visitor. A signed-in visitor gets a meeting row in the
   * sample workspace owned by them, so their minutes can be kept in their own history; a signed-out
   * visitor stays memory-only.
   */
  createPractice(options?: { ownerUserId?: string; title?: string }): Promise<MeetingInstance>;
  /** The loaded practice meeting with this id, or undefined when it is not a practice one. */
  findPractice(id: string): MeetingInstance | undefined;
  list(workspaceId: string): Promise<MeetingRow[]>;
  /**
   * The id of the open or scheduled real meeting whose code this is, or undefined. A loaded meeting
   * is matched on its current code; an unloaded one on the code saved with it. A meeting that was
   * never opened has no code yet, so it cannot be found this way.
   */
  findByCode(code: string): Promise<string | undefined>;
  /**
   * End and release every meeting this account owns or that sits in one of the given workspaces,
   * before its account is deleted.
   */
  endOwnedBy(userId: string, workspaceIds: readonly string[]): Promise<void>;
  /** Save and dispose one meeting; its row and saved state stay. */
  unload(id: string): Promise<void>;
  /**
   * A loaded meeting has ended: keep its instance for the room and minutes people may still be
   * using, but stop counting it against its owner's open-meeting cap.
   */
  noteEnded(id: string): void;
  /** Every open meeting, for a runner connecting (or reconnecting) to the control channel. */
  openMeetings(): OpenMeeting[];
  close(): Promise<void>;
}

interface MeetingRegistryDeps {
  legacy: MeetingInstance;
  store: MeetingStore;
  /** Build an instance from its row; persistence is already loaded for it. */
  buildInstance(row: MeetingRow, persistence: MeetingPersistence | undefined): Promise<MeetingInstance>;
  /** Build a fresh practice instance with this registry id; a signed-in visitor's row is already created. */
  buildPracticeInstance(id: string, ownerUserId?: string): Promise<MeetingInstance>;
  /** Load the meeting's saved state; absent means memory only. */
  persistenceFor?(id: string): Promise<MeetingPersistence | undefined>;
  /** The id of the meeting whose saved state holds this code; absent means loaded meetings only. */
  findSavedIdByCode?(code: string): Promise<string | undefined>;
  maxOpen?: number;
  /**
   * How many practice meetings may be open at once. Practice and the always-open legacy room take
   * slots from `maxOpen`, so real meetings keep `maxOpen - maxPractice - 1` while the legacy room
   * exists; removing it leaves `maxOpen - maxPractice`.
   */
  maxPractice?: number;
  /** How many real meetings one owner may keep open at once. */
  maxOpenPerUser?: number;
  /** How many meetings one owner may create per day. */
  maxMeetingsPerDay?: number;
  unloadMs?: number;
  /** How long an empty practice meeting stays for its visitor to return; shorter than a real one. */
  practiceUnloadMs?: number;
  sweepMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Release a meeting's seat claims, so no stale claim outlives a deleted meeting. */
  releaseMeeting?: (meetingId: string) => Promise<void>;
  /** A meeting was opened (loaded) or closed (unloaded), for the runner control channel. */
  onOpened?(meeting: OpenMeeting): void;
  onClosed?(meetingId: string): void;
  /** A meeting of a workspace opened or closed, so its periodic index can start or stop. */
  onWorkspaceOpened?(workspaceId: string): void;
  onWorkspaceClosed?(workspaceId: string): void;
}

const DEFAULT_MAX_OPEN = 10;
const DEFAULT_MAX_PRACTICE = 5;
const DEFAULT_MAX_OPEN_PER_USER = 2;
const DEFAULT_MAX_MEETINGS_PER_DAY = 20;
const DEFAULT_UNLOAD_MS = 30 * 60_000;
const DEFAULT_PRACTICE_UNLOAD_MS = 5 * 60_000;
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
  const maxPractice =
    deps.maxPractice ?? positiveEnvNumber('KAKI_MAX_PRACTICE', DEFAULT_MAX_PRACTICE);
  const maxOpenPerUser =
    deps.maxOpenPerUser ??
    positiveEnvNumber('KAKI_MAX_OPEN_MEETINGS_PER_USER', DEFAULT_MAX_OPEN_PER_USER);
  const maxMeetingsPerDay =
    deps.maxMeetingsPerDay ??
    positiveEnvNumber('KAKI_MAX_MEETINGS_PER_DAY', DEFAULT_MAX_MEETINGS_PER_DAY);
  const unloadMs = deps.unloadMs ?? positiveEnvNumber('KAKI_MEETING_UNLOAD_MS', DEFAULT_UNLOAD_MS);
  const practiceUnloadMs =
    deps.practiceUnloadMs ??
    positiveEnvNumber('KAKI_PRACTICE_UNLOAD_MS', DEFAULT_PRACTICE_UNLOAD_MS);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.log(message));
  const loaded = new Map<string, MeetingInstance>();
  /**
   * The owner of each loaded real meeting that still holds an open slot. An ended meeting keeps
   * its instance (for its room and minutes) but is removed here, so it never counts against the
   * per-owner cap; loading an already-ended one never adds it.
   */
  const owners = new Map<string, string>();
  /** Loads in flight per owner, so two simultaneous opens cannot both slip under the cap. */
  const loadingOwners = new Map<string, number>();
  /** One in-flight create per owner, so simultaneous creates cannot both slip under the daily cap. */
  const creating = new Map<string, Promise<unknown>>();
  const persistences = new Map<string, MeetingPersistence>();
  const loading = new Map<string, Promise<MeetingInstance | undefined>>();
  /** Practice instances being built right now, so two simultaneous opens cannot both slip under the cap. */
  let practiceCreating = 0;
  let closed = false;

  const openMeeting = (instance: MeetingInstance): OpenMeeting => ({
    meetingId: instance.id,
    kind: instance.runnerKind,
    roomName: instance.roomName,
  });

  /** An ended instance stays loaded for its room and minutes, but it holds no open slot. */
  const isEnded = (instance: MeetingInstance): boolean => instance.session.phase() === 'ended';
  const openCount = (): number =>
    [...loaded.values()].filter((instance) => !isEnded(instance)).length + 1; // the legacy instance is always open
  const practiceCount = (): number =>
    [...loaded.values()].filter((instance) => instance.runnerKind === 'practice' && !isEnded(instance))
      .length;

  /** The start of the current UTC day, the boundary of the daily creation cap. */
  const startOfDay = (): Date => {
    const start = new Date(now());
    start.setUTCHours(0, 0, 0, 0);
    return start;
  };

  const openForOwner = (ownerUserId: string): number => {
    let count = 0;
    for (const id of loaded.keys()) {
      if (owners.get(id) === ownerUserId) count += 1;
    }
    return count;
  };

  function dailyLimitMessage(limit: number): string {
    return `You can create up to ${limit} meeting${limit === 1 ? '' : 's'} a day. Try again tomorrow.`;
  }

  /** Run one owner's creates in turn, so the daily count is checked against settled rows. */
  async function serializedCreate<T>(ownerUserId: string, task: () => Promise<T>): Promise<T> {
    const previous = creating.get(ownerUserId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    creating.set(ownerUserId, next);
    try {
      return await next;
    } finally {
      if (creating.get(ownerUserId) === next) creating.delete(ownerUserId);
    }
  }

  /**
   * A signed-in practice's row is kept for its minutes, so once the practice ends or is unloaded
   * mark it ended; otherwise abandoned practices pile up as open rows in the sample workspace.
   */
  async function endPracticeRow(instance: MeetingInstance): Promise<void> {
    if (instance.runnerKind !== 'practice') return;
    try {
      await deps.store.markEnded?.(instance.id, new Date(now()).toISOString());
    } catch (error) {
      log(`kaki meetings: marking the practice ${instance.id} ended failed: ${String(error)}`);
    }
  }

  async function closeInstance(instance: MeetingInstance): Promise<void> {
    loaded.delete(instance.id);
    owners.delete(instance.id);
    const persistence = persistences.get(instance.id);
    persistences.delete(instance.id);
    await endPracticeRow(instance);
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
    // An ended meeting is served for its room and minutes; it never takes a server-wide slot.
    if (row.status !== 'ended' && openCount() >= maxOpen) {
      log(`kaki meetings: refusing to open ${id}: ${openCount()} meetings are already open`);
      throw new MeetingBusyError();
    }
    const ownerUserId = row.ownerUserId;
    // An ended meeting can still be opened for its room and minutes, but it holds no open slot:
    // viewing it never takes one, and ending it frees the owner's.
    const slotOwner = ownerUserId !== null && row.status !== 'ended' ? ownerUserId : undefined;
    if (slotOwner !== undefined) {
      const alreadyOpen =
        openForOwner(slotOwner) + (loadingOwners.get(slotOwner) ?? 0);
      if (alreadyOpen >= maxOpenPerUser) {
        log(
          `kaki meetings: refusing to open ${id}: its owner already has ${alreadyOpen} meetings open`,
        );
        throw new MeetingBusyError(
          `You already have ${alreadyOpen} meeting${alreadyOpen === 1 ? '' : 's'} open. End one to start another.`,
        );
      }
      loadingOwners.set(slotOwner, (loadingOwners.get(slotOwner) ?? 0) + 1);
    }
    try {
      const persistence = await deps.persistenceFor?.(id);
      if (persistence !== undefined) persistences.set(id, persistence);
      const instance = await deps.buildInstance(row, persistence);
      loaded.set(id, instance);
      if (slotOwner !== undefined) owners.set(id, slotOwner);
      deps.onOpened?.(openMeeting(instance));
      deps.onWorkspaceOpened?.(instance.workspaceId);
      return instance;
    } finally {
      if (slotOwner !== undefined) {
        const next = (loadingOwners.get(slotOwner) ?? 1) - 1;
        if (next <= 0) loadingOwners.delete(slotOwner);
        else loadingOwners.set(slotOwner, next);
      }
    }
  }

  const registry: MeetingRegistry = {
    async create({ workspaceId, ownerUserId, title, scheduledFor, agenda }) {
      const cleanTitle = title.trim();
      if (cleanTitle === '') throw new Error('a meeting needs a title');
      const scheduledAt = scheduledFor === undefined ? undefined : Date.parse(scheduledFor);
      if (scheduledAt !== undefined && Number.isNaN(scheduledAt)) {
        throw new Error('a meeting scheduledFor must be a date');
      }
      return serializedCreate(ownerUserId, async () => {
        const createdToday = await deps.store.countCreatedByOwnerSince(ownerUserId, startOfDay());
        if (createdToday >= maxMeetingsPerDay) {
          log(
            `kaki meetings: refusing to create a meeting for ${ownerUserId}: ` +
              `${createdToday} already created today`,
          );
          throw new MeetingBusyError(dailyLimitMessage(maxMeetingsPerDay));
        }
        const status: MeetingStatus =
          scheduledAt !== undefined && scheduledAt > now() ? 'scheduled' : 'open';
        return deps.store.create({
          workspaceId,
          ownerUserId,
          title: cleanTitle,
          status,
          ...(scheduledFor === undefined ? {} : { scheduledFor }),
          ...(agenda === undefined ? {} : { agenda }),
        });
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

    async createPractice(options = {}) {
      if (closed) throw new Error('the meeting registry is closed');
      const practiceOpen = practiceCount() + practiceCreating;
      if (practiceOpen >= maxPractice) {
        log(`kaki meetings: refusing a practice meeting: ${practiceOpen} are already open`);
        throw new PracticeFullError();
      }
      if (openCount() + practiceCreating >= maxOpen) {
        log(`kaki meetings: refusing a practice meeting: ${openCount()} meetings are already open`);
        throw new MeetingBusyError();
      }
      practiceCreating += 1;
      try {
        const id = newMeetingId();
        const instance = await deps.buildPracticeInstance(id, options.ownerUserId);
        if (options.ownerUserId !== undefined) {
          try {
            // The row shares the instance id, so the minutes writer can save straight to it.
            await deps.store.create({
              id,
              workspaceId: SAMPLE_WORKSPACE_ID,
              ownerUserId: options.ownerUserId,
              title: options.title?.trim() || 'Practice meeting',
            });
          } catch (error) {
            // The instance never reached the registry, so nothing else will dispose it.
            await instance
              .dispose()
              .catch((disposeError: unknown) =>
                log(
                  `kaki meetings: disposing the practice ${instance.id} after its row failed: ${String(disposeError)}`,
                ),
              );
            throw error;
          }
        }
        loaded.set(instance.id, instance);
        deps.onOpened?.(openMeeting(instance));
        deps.onWorkspaceOpened?.(instance.workspaceId);
        return instance;
      } finally {
        practiceCreating -= 1;
      }
    },

    findPractice(id) {
      const instance = loaded.get(id);
      return instance !== undefined && instance.runnerKind === 'practice' ? instance : undefined;
    },

    list: (workspaceId) => deps.store.list(workspaceId),

    async endOwnedBy(userId, workspaceIds) {
      if (deps.store.listByOwner === undefined) {
        throw new Error('the meetings store cannot list an account\'s meetings');
      }
      if (deps.store.markEnded === undefined) {
        throw new Error('the meetings store cannot mark a meeting ended');
      }
      // The doomed set is every meeting this account owns plus every meeting that sits in one of
      // the workspaces about to be deleted, whoever owns it. Deduplicate the two lists by row id.
      const byId = new Map<string, MeetingRow>();
      for (const row of await deps.store.listByOwner(userId)) byId.set(row.id, row);
      for (const workspaceId of workspaceIds) {
        for (const row of await deps.store.list(workspaceId)) byId.set(row.id, row);
      }
      const failed: string[] = [];
      for (const row of byId.values()) {
        if (row.id === LEGACY_MEETING_ID) continue;
        const instance = loaded.get(row.id);
        // Try every step for every row, then report what failed: one bad meeting must not stop
        // the others from ending cleanly.
        if (instance !== undefined && instance.session.phase() === 'running') {
          if (instance.hub.handleServerCommand === undefined) {
            failed.push(row.id);
            log(`kaki meetings: ${row.id} cannot be silent-ended for a deleted account`);
          } else {
            try {
              await instance.hub.handleServerCommand(
                { type: 'END_MEETING', silent: true },
                { kind: 'screen' },
              );
            } catch (error) {
              failed.push(row.id);
              log(`kaki meetings: silent-ending ${row.id} for a deleted account failed: ${String(error)}`);
            }
          }
        }
        if (row.status !== 'ended') {
          try {
            await deps.store.markEnded(row.id, new Date().toISOString());
          } catch (error) {
            failed.push(row.id);
            log(`kaki meetings: marking ${row.id} ended for a deleted account failed: ${String(error)}`);
          }
        }
        try {
          await deps.releaseMeeting?.(row.id);
        } catch (error) {
          failed.push(row.id);
          log(`kaki meetings: releasing the seats of ${row.id} failed: ${String(error)}`);
        }
        // Unload last: the silent end still needs the instance's hub and persistence.
        if (instance !== undefined) {
          try {
            await registry.unload(row.id);
          } catch (error) {
            failed.push(row.id);
            log(`kaki meetings: unloading ${row.id} for a deleted account failed: ${String(error)}`);
          }
        }
        log(`kaki meetings: ended ${row.id} for a deleted account`);
      }
      // Deleting the rows now would strand anyone still in a room we could not end.
      if (failed.length > 0) {
        throw new Error(`could not end ${[...new Set(failed)].join(', ')}`);
      }
    },

    async unload(id) {
      if (id === LEGACY_MEETING_ID) {
        throw new Error('the legacy practice meeting cannot be unloaded');
      }
      const instance = loaded.get(id);
      if (instance === undefined) return;
      await closeInstance(instance);
    },

    noteEnded(id) {
      owners.delete(id);
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
      owners.clear();
      await Promise.all(
        instances.map(async (instance) => {
          await endPracticeRow(instance);
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
      const practice = instance.runnerKind === 'practice';
      // An ended meeting is kept only while someone is still viewing its room or minutes, so once
      // it is empty it is a throwaway: unload it at once rather than waiting out the idle time.
      const ended = isEnded(instance);
      const idleFor = practice ? practiceUnloadMs : unloadMs;
      if (!ended && at - instance.lastActivityAt() < idleFor) continue;
      log(
        ended
          ? `kaki meetings: unloading the ended meeting ${instance.id}`
          : `kaki meetings: unloading ${instance.id}; nobody has been there for ${Math.round(idleFor / 60_000)} min`,
      );
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
    async create({ id, workspaceId, ownerUserId, title, status = 'open', scheduledFor, agenda = [] }) {
      await ensureMeetingsSchema(pool);
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Take a shared lock on the owner before inserting. It proves the account still exists, and
        // it waits for, or blocks, an account deletion's FOR UPDATE lock on the same row, so a
        // meeting can never be inserted between that deletion's open-meeting check and its commit.
        const owner = await client.query('select id from users where id = $1 for key share', [
          ownerUserId,
        ]);
        if ((owner.rowCount ?? 0) === 0) {
          throw new Error(`meeting owner ${ownerUserId} no longer exists`);
        }
        const result = await client.query(
          `insert into meetings (id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda)
           values ($1, $2, $3, $4, 'real', $5, $6, $7::jsonb)
           returning id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, created_at, ended_at,
                     minutes_text, minutes_todos, minutes_archived_at`,
          [id ?? newMeetingId(), workspaceId, ownerUserId, title, status, scheduledFor ?? null, JSON.stringify(agenda)],
        );
        await client.query('commit');
        return row(result.rows[0]);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
    async countCreatedByOwnerSince(ownerUserId, since) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query<{ count: string }>(
        'select count(*)::text as count from meetings where owner_user_id = $1 and created_at >= $2',
        [ownerUserId, since],
      );
      return Number(result.rows[0]?.count ?? '0');
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
    async listByOwner(ownerUserId) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where owner_user_id = $1 order by created_at asc`,
        [ownerUserId],
      );
      return result.rows.map(row);
    },
    async deleteByOwner(ownerUserId, workspaceIds, transaction) {
      const run = async (db: Pool | PoolClient): Promise<void> => {
        const deleted = await db.query<{ id: string }>(
          `delete from meetings where workspace_id = any($1::text[]) returning id`,
          [[...workspaceIds]],
        );
        // A meeting the account owned in a workspace that stays belongs to that workspace: keep
        // the row and its minutes, and hand it over by clearing the owner.
        await db.query('update meetings set owner_user_id = null where owner_user_id = $1', [
          ownerUserId,
        ]);
        const ids = deleted.rows.map((record) => record.id);
        if (ids.length > 0) {
          await db.query('delete from meeting_state where id = any($1::text[])', [ids]);
          await db.query('delete from seat_claims where meeting_id = any($1::text[])', [ids]);
        }
      };
      if (transaction !== undefined) {
        await run(transaction);
        return;
      }
      await ensureMeetingsSchema(pool);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await run(client);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** The in-memory meeting rows tests use when no database is configured. */
export function createMemoryMeetingStore(): MeetingStore & { rows: Map<string, MeetingRow> } {
  const rows = new Map<string, MeetingRow>();
  return {
    rows,
    async create({ id, workspaceId, ownerUserId, title, status = 'open', scheduledFor, agenda = [] }) {
      const meeting: MeetingRow = {
        id: id ?? newMeetingId(),
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
    async countCreatedByOwnerSince(ownerUserId, since) {
      const from = since.getTime();
      return [...rows.values()].filter(
        (meeting) => meeting.ownerUserId === ownerUserId && Date.parse(meeting.createdAt) >= from,
      ).length;
    },
    async list(workspaceId) {
      return [...rows.values()]
        .filter((meeting) => meeting.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async listByOwner(ownerUserId) {
      return [...rows.values()]
        .filter((meeting) => meeting.ownerUserId === ownerUserId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async deleteByOwner(ownerUserId, workspaceIds, _client) {
      const wanted = new Set(workspaceIds);
      for (const [id, meeting] of rows) {
        if (wanted.has(meeting.workspaceId)) {
          rows.delete(id);
        } else if (meeting.ownerUserId === ownerUserId) {
          // The workspace stays, so the meeting and its minutes stay with it.
          rows.set(id, { ...meeting, ownerUserId: null });
        }
      }
    },
  };
}
