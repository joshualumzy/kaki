import { randomBytes } from 'node:crypto';
import { normalizeMeetingCode, parseMeetingPaceInput, type MeetingPace } from '@kaki/shared';
import type { Pool, PoolClient } from 'pg';
import { ensureMeetingsSchema } from '../auth/schema';
import type { MeetingPersistence } from '../persist/persistence';
import type { MeetingInstance } from './instance';
import { removeCalendarEventForCancelledMeeting } from './calendarEvent';
import { agendaFromStored } from './agenda';
import { SAMPLE_WORKSPACE_ID } from '../workspace/constants';
import {
  meetingStatusNow,
  type AgendaItem,
  type ArchivedMeetingTodo,
  type MeetingMinutesArchive,
  type MeetingRow,
  type MeetingStatus,
} from './types';

/** A registry refusal the HTTP layer turns into a 503 with this exact message. */
export class MeetingBusyError extends Error {
  readonly code = 'busy';
  constructor(message = 'Kaki is running as many meetings as it can right now. Try again in a few minutes.') {
    super(message);
  }
}

/** A scheduled-plan change refused because the meeting has already started (or is starting). */
export class MeetingOpenError extends Error {
  readonly code = 'open';
  constructor(message = 'This meeting is open now. End it from the list instead.') {
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
    kind?: 'real' | 'practice';
    status?: MeetingStatus;
    scheduledFor?: string;
    agenda?: AgendaItem[];
    pace?: MeetingPace;
  }): Promise<MeetingRow>;
  get(id: string): Promise<MeetingRow | undefined>;
  list(workspaceId: string): Promise<MeetingRow[]>;
  /** Change a meeting's plan; undefined when the row is gone or `onlyIfScheduled` no longer holds. */
  update?(
    id: string,
    patch: {
      title?: string;
      agenda?: AgendaItem[];
      scheduledFor?: string;
      pace?: MeetingPace;
    },
    options?: { onlyIfScheduled?: boolean },
  ): Promise<MeetingRow | undefined>;
  /**
   * Delete one meeting and everything tied to it: its saved state, seat claims and its knowledge
   * chunk. Returns false when the row was already gone or `onlyIfScheduled` no longer holds.
   */
  delete?(id: string, options?: { onlyIfScheduled?: boolean }): Promise<boolean>;
  /**
   * Persist a meeting's transition from scheduled to open the moment it starts (even early), so a
   * live room can never still be edited or cancelled as if it had not begun. Returns true when the
   * row is (now) open, false when it is gone or already ended.
   */
  markOpen?(id: string): Promise<boolean>;
  /** Every meeting row this account owns, whatever its status. */
  listByOwner?(ownerUserId: string): Promise<MeetingRow[]>;
  /**
   * Delete every meeting that sits in one of the given workspaces and every practice meeting the
   * account owns (each with its saved state and seat claims). Hand the real meetings the account
   * owns in workspaces that stay to that workspace by clearing their owner. Run inside `client`
   * when it is given.
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
  /**
   * Hand every scheduled (not open or ended) meeting one member owns in a workspace to another
   * member. Removal never ends a scheduled meeting, so its host authority must move with it.
   */
  transferScheduledOwnership?(input: {
    workspaceId: string;
    fromUserId: string;
    toUserId: string;
  }): Promise<void>;
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
    pace?: MeetingPace;
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
  /** Change a scheduled meeting's plan and drop a loaded lobby so the next opening uses it. */
  updateScheduled(
    id: string,
    patch: {
      title?: string;
      agenda?: AgendaItem[];
      scheduledFor?: string;
      pace?: MeetingPace;
    },
  ): Promise<MeetingRow | undefined>;
  /** Delete a cancelled meeting and everything it left behind. */
  cancel(id: string): Promise<void>;
  /**
   * Persist that a real meeting has started. Serialized with edit, cancel and load, so a meeting
   * can never be edited or deleted in the same instant its first Start moves it to open.
   * Returns false when the row is gone or already ended.
   */
  markStarted(id: string): Promise<boolean>;
  /**
   * Run one operation under a meeting's lifecycle lock. The instance uses it to serialize its
   * own Start transition with the registry's edit, cancel and load paths.
   */
  serialize<T>(id: string, task: () => Promise<T>): Promise<T>;
  /**
   * End an open meeting now, from outside its room: a running meeting ends normally with its
   * minutes, a lobby that never started is torn down, and an unloaded row is restored and ended
   * through that same lifecycle so its minutes are finalized.
   */
  endMeeting(id: string): Promise<'ended' | 'not-found' | 'starting'>;
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
  /**
   * Close one member's sockets in every loaded meeting of that workspace, and disconnect their
   * LiveKit audio. `keepOwner` keeps the meetings they still own, for a demotion that leaves owner
   * authority intact.
   */
  endWorkspaceMember(
    workspaceId: string,
    userId: string,
    options?: { keepOwner?: boolean },
  ): Promise<void>;
  /** Close one account's sockets and LiveKit audio in every loaded meeting, whatever its workspace. */
  endUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

interface MeetingRegistryDeps {
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
   * How many practice meetings may be open at once. Practice and real meetings share `maxOpen`, so
   * real meetings keep `maxOpen - maxPractice` slots.
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
  /** Disconnect one account's LiveKit participant from a room after its access ended. */
  disconnectUser?(roomName: string, userId: string): Promise<void>;
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
  /** One lifecycle operation at a time per meeting: load, edit, cancel, end and Start. */
  const meetingLocks = new Map<string, Promise<unknown>>();
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
    [...loaded.values()].filter((instance) => !isEnded(instance)).length;
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
   * Run one meeting's lifecycle operations in turn. A load, an edit, a cancel, an end and the
   * Start transition all take this lock, so none can inspect the room and then act on a meeting
   * another of them changed underneath it.
   */
  function withMeetingLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = meetingLocks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    meetingLocks.set(id, run);
    return run.finally(() => {
      if (meetingLocks.get(id) === run) meetingLocks.delete(id);
    });
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

  /** Let go of a meeting that was built but must never reach the registry. */
  async function discardBuilt(
    id: string,
    instance: MeetingInstance,
    persistence: MeetingPersistence | undefined,
  ): Promise<void> {
    persistences.delete(id);
    try {
      await instance.dispose();
    } catch (error) {
      log(`kaki meetings: disposing the unregistered meeting ${id} failed: ${String(error)}`);
    }
    await persistence?.close().catch((error: unknown) =>
      log(`kaki meetings: closing the saved meeting ${id} failed: ${String(error)}`),
    );
  }

  /** Save and dispose a loaded meeting. Callers hold this meeting's lifecycle lock. */
  async function unloadLocked(id: string): Promise<void> {
    const instance = loaded.get(id);
    if (instance === undefined) return;
    await closeInstance(instance);
  }

  /**
   * Build and register one meeting. Callers hold this meeting's lifecycle lock, so an edit or a
   * cancel cannot slip between reading the row and registering the instance.
   */
  async function loadUnlocked(
    id: string,
    options: { skipQuota?: boolean } = {},
  ): Promise<MeetingInstance | undefined> {
    if (closed) throw new Error('the meeting registry is closed');
    const row = await deps.store.get(id);
    if (row === undefined) return undefined;
    // An ended meeting is served for its room and minutes; it never takes a server-wide slot.
    if (options.skipQuota !== true && row.status !== 'ended' && openCount() >= maxOpen) {
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
      if (options.skipQuota !== true && alreadyOpen >= maxOpenPerUser) {
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
      // The build may have taken long enough for the meeting to end or be cancelled. Recheck the
      // row before registering, so a terminal meeting never appears as an open instance.
      const current = await deps.store.get(id);
      // Discard a load whose meeting ended (or was cancelled) while it was building, unless the
      // instance itself came back ended: that is the minutes review an ended meeting is kept for.
      const instanceEnded = instance.session.phase() === 'ended';
      if (
        current === undefined ||
        (row.status !== 'ended' && current.status === 'ended' && !instanceEnded)
      ) {
        await discardBuilt(id, instance, persistence);
        return undefined;
      }
      loaded.set(id, instance);
      // An instance that came back ended is serving its minutes review, not holding an open slot.
      if (slotOwner !== undefined && current.status !== 'ended' && !instanceEnded) {
        owners.set(id, slotOwner);
      }
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
    async create({ workspaceId, ownerUserId, title, scheduledFor, agenda, pace }) {
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
          ...(pace === undefined ? {} : { pace }),
        });
      });
    },

    async get(id) {
      const open = loaded.get(id);
      if (open !== undefined) return open;
      const pending = loading.get(id);
      if (pending !== undefined) return pending;
      const loadPromise = withMeetingLock(id, () => loadUnlocked(id));
      loading.set(id, loadPromise);
      try {
        return await loadPromise;
      } finally {
        if (loading.get(id) === loadPromise) loading.delete(id);
      }
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
      if (savedId === undefined) return undefined;
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
              kind: 'practice',
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

    async updateScheduled(id, patch) {
      const update = deps.store.update;
      if (update === undefined) {
        throw new Error('the meetings store cannot update a meeting');
      }
      return withMeetingLock(id, async () => {
        const existing = await deps.store.get(id);
        if (existing === undefined) return undefined;
        const instance = loaded.get(id);
        // A loaded room that has begun starting or running is open now, whatever the row's schedule
        // says; changing its plan would unload the very room people are in.
        if (instance !== undefined && instance.session.phase() !== 'lobby') {
          throw new MeetingOpenError();
        }
        if (meetingStatusNow(existing, now()) !== 'scheduled') throw new MeetingOpenError();
        const row = await update(id, patch, { onlyIfScheduled: true });
        if (row === undefined) {
          const current = await deps.store.get(id);
          if (current === undefined) return undefined;
          throw new MeetingOpenError();
        }
        // A lobby may already be loaded (someone opened the link early). Rebase its saved draft and
        // agenda onto the edited row, then drop it, so the next opening validates against the new
        // plan instead of a stale snapshot that still names the old topics or pace.
        if (instance !== undefined) {
          instance.rebaseScheduledPlan?.(row);
          await unloadLocked(id);
        }
        return row;
      });
    },

    async markStarted(id) {
      const markOpen = deps.store.markOpen;
      if (markOpen === undefined) {
        throw new Error('the meetings store cannot mark a meeting open');
      }
      return withMeetingLock(id, async () => {
        const row = await deps.store.get(id);
        if (row === undefined || row.status === 'ended') return false;
        await markOpen(id);
        return true;
      });
    },

    serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
      return withMeetingLock(id, task);
    },

    async cancel(id) {
      const remove = deps.store.delete;
      if (remove === undefined) {
        throw new Error('the meetings store cannot delete a meeting');
      }
      await withMeetingLock(id, async () => {
        const row = await deps.store.get(id);
        if (row === undefined) return;
        const instance = loaded.get(id);
        if (instance !== undefined && instance.session.phase() !== 'lobby') {
          throw new MeetingOpenError('This meeting is open now. End it instead of cancelling it.');
        }
        if (meetingStatusNow(row, now()) !== 'scheduled') {
          throw new MeetingOpenError('This meeting is open now. End it instead of cancelling it.');
        }
        if (instance !== undefined) await unloadLocked(id);
        // Round 3 removes the calendar event here; the hook is named now so cancellation owns it.
        await removeCalendarEventForCancelledMeeting({
          meetingId: row.id,
          workspaceId: row.workspaceId,
          ownerUserId: row.ownerUserId,
          title: row.title,
          scheduledFor: row.scheduledFor,
        });
        await deps.releaseMeeting?.(id);
        const deleted = await remove(id, { onlyIfScheduled: true });
        if (!deleted && (await deps.store.get(id)) !== undefined) {
          throw new MeetingOpenError('This meeting is open now. End it instead of cancelling it.');
        }
      });
    },

    async endMeeting(id) {
      return withMeetingLock(id, async () => {
        const row = await deps.store.get(id);
        if (row === undefined) return 'not-found';
        let instance = loaded.get(id);
        // No instance here, but a saved session may still be running (for example after a restart).
        // Restore it and end it through the normal lifecycle, so its minutes are finalized exactly
        // as a room end would, rather than merely marking the row ended.
        if (instance === undefined && row.status !== 'ended') {
          instance = await loadUnlocked(id, { skipQuota: true });
        }
        if (instance === undefined) {
          const endedAt = new Date(now()).toISOString();
          await deps.store.markEnded?.(id, endedAt);
          owners.delete(id);
          return 'ended';
        }
        const phase = instance.session.phase();
        if (phase === 'starting') return 'starting';
        if (phase === 'running' && !instance.session.abandoned()) {
          if (instance.hub.handleServerCommand === undefined) {
            throw new Error('this meeting cannot be ended from the list');
          }
          // The shared screen is the host's channel; ending this way writes the minutes like any end.
          await instance.hub.handleServerCommand({ type: 'END_MEETING' }, { kind: 'screen' });
          // Keep the ended snapshot, then let the minutes the end scheduled finish writing.
          await instance.persistence?.flush();
        } else if (phase !== 'ended') {
          // A lobby that never started has no clock or minutes, so tearing the room down is its end.
          await unloadLocked(id);
        }
        const endedAt = new Date(now()).toISOString();
        const current = await deps.store.get(id);
        if (current !== undefined && current.status !== 'ended') {
          await deps.store.markEnded?.(id, endedAt);
        }
        owners.delete(id);
        return 'ended';
      });
    },

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
      await withMeetingLock(id, () => unloadLocked(id));
    },

    noteEnded(id) {
      owners.delete(id);
    },

    openMeetings() {
      return [...loaded.values()].map(openMeeting);
    },

    async endWorkspaceMember(workspaceId, userId, options = {}) {
      for (const instance of loaded.values()) {
        if (instance.workspaceId !== workspaceId) continue;
        // A demoted admin keeps host authority only on meetings they still own.
        if (options.keepOwner === true && instance.ownerUserId === userId) continue;
        instance.hub.endUser?.(userId);
        if (deps.disconnectUser !== undefined) {
          try {
            await deps.disconnectUser(instance.roomName, userId);
          } catch (error) {
            log(
              `kaki meetings: disconnecting ${userId} from the LiveKit room ${instance.roomName} failed: ${String(error)}`,
            );
          }
        }
      }
    },

    async endUser(userId) {
      for (const instance of loaded.values()) {
        instance.hub.endUser?.(userId);
        if (deps.disconnectUser !== undefined) {
          try {
            await deps.disconnectUser(instance.roomName, userId);
          } catch (error) {
            log(
              `kaki meetings: disconnecting ${userId} from the LiveKit room ${instance.roomName} failed: ${String(error)}`,
            );
          }
        }
      }
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

/** A stored pace must be readable; a malformed one fails loudly rather than drifting to a default. */
function paceFromStored(value: unknown): MeetingPace | null {
  if (value === null || value === undefined) return null;
  const parsed = parseMeetingPaceInput(value);
  if (!parsed.ok) throw new Error(`kaki meetings: the stored pace is malformed: ${parsed.error}`);
  return parsed.pace;
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
    pace?: unknown;
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
    kind: record.kind === 'practice' ? 'practice' : 'real',
    status:
      record.status === 'scheduled' || record.status === 'ended' ? record.status : 'open',
    scheduledFor: record.scheduled_for === null ? null : new Date(record.scheduled_for).toISOString(),
    agenda: agendaFromStored(record.agenda),
    pace: paceFromStored(record.pace),
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
    async create({ id, workspaceId, ownerUserId, title, kind = 'real', status = 'open', scheduledFor, agenda = [], pace }) {
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
        // A real workspace is locked in share mode while the owner's membership is checked. Removal
        // takes an exclusive workspace lock and checks for open meetings, so the two serialize:
        // either this insert commits before removal's check, or it waits and then finds no membership.
        if (workspaceId !== SAMPLE_WORKSPACE_ID) {
          const workspace = await client.query(
            'select id from workspaces where id = $1 for key share',
            [workspaceId],
          );
          // A real workspace locks and checks membership here. A plain id with no workspace row is
          // a databaseless fixture or an old direct caller; the API route already refused it.
          if ((workspace.rowCount ?? 0) > 0) {
            const member = await client.query(
              'select 1 from workspace_members where workspace_id = $1 and user_id = $2',
              [workspaceId, ownerUserId],
            );
            if ((member.rowCount ?? 0) === 0) {
              throw new Error(
                `meeting owner ${ownerUserId} is not a member of workspace ${workspaceId}`,
              );
            }
          }
        }
        const result = await client.query(
          `insert into meetings (id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
           returning id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace, created_at, ended_at,
                     minutes_text, minutes_todos, minutes_archived_at`,
          [
            id ?? newMeetingId(),
            workspaceId,
            ownerUserId,
            title,
            kind,
            status,
            scheduledFor ?? null,
            JSON.stringify(agenda),
            pace === undefined ? null : JSON.stringify(pace),
          ],
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
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where id = $1`,
        [id],
      );
      return result.rows[0] === undefined ? undefined : row(result.rows[0]);
    },
    async update(id, patch, options = {}) {
      await ensureMeetingsSchema(pool);
      const columns: string[] = [];
      const values: unknown[] = [id];
      if (patch.title !== undefined) {
        values.push(patch.title);
        columns.push(`title = $${values.length}`);
      }
      if (patch.agenda !== undefined) {
        values.push(JSON.stringify(patch.agenda));
        columns.push(`agenda = $${values.length}::jsonb`);
      }
      if (patch.pace !== undefined) {
        values.push(JSON.stringify(patch.pace));
        columns.push(`pace = $${values.length}::jsonb`);
      }
      if (patch.scheduledFor !== undefined) {
        values.push(patch.scheduledFor);
        columns.push(`scheduled_for = $${values.length}`);
      }
      if (columns.length === 0) return this.get?.(id);
      const result = await pool.query(
        `update meetings set ${columns.join(', ')} where id = $1${
          options.onlyIfScheduled === true ? " and status = 'scheduled'" : ''
        }
         returning id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace, created_at, ended_at,
                   minutes_text, minutes_todos, minutes_archived_at`,
        values,
      );
      return result.rows[0] === undefined ? undefined : row(result.rows[0]);
    },
    async delete(id, options = {}) {
      await ensureMeetingsSchema(pool);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const deleted = await client.query(
          `delete from meetings where id = $1${
            options.onlyIfScheduled === true ? " and status = 'scheduled'" : ''
          } returning id`,
          [id],
        );
        if ((deleted.rowCount ?? 0) === 0) {
          await client.query('rollback');
          return false;
        }
        // A deployment may hold meeting rows without every companion table yet. Delete each one
        // that exists, so a cancel never fails halfway over a table this server never created.
        const tables = await client.query<{
          states: string | null;
          claims: string | null;
          chunks: string | null;
        }>(
          `select to_regclass('meeting_state')::text as states,
                  to_regclass('seat_claims')::text as claims,
                  to_regclass('knowledge_chunks')::text as chunks`,
        );
        const found = tables.rows[0];
        if (found?.states !== null && found?.states !== undefined) {
          await client.query('delete from meeting_state where id = $1', [id]);
        }
        if (found?.claims !== null && found?.claims !== undefined) {
          await client.query('delete from seat_claims where meeting_id = $1', [id]);
        }
        // A cancelled meeting's minutes must not stay answerable from company records.
        if (found?.chunks !== null && found?.chunks !== undefined) {
          await client.query(
            "delete from knowledge_chunks where source = 'meeting' and ref = $1",
            [`meeting:${id}`],
          );
        }
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async markEnded(id, endedAt) {
      await ensureMeetingsSchema(pool);
      await pool.query(
        "update meetings set status = 'ended', ended_at = $2 where id = $1 and status <> 'ended'",
        [id, endedAt],
      );
    },
    async markOpen(id) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        "update meetings set status = 'open' where id = $1 and status = 'scheduled' returning id",
        [id],
      );
      if ((result.rowCount ?? 0) > 0) return true;
      const current = await pool.query<{ status: string }>(
        'select status from meetings where id = $1',
        [id],
      );
      return current.rows[0]?.status !== undefined && current.rows[0].status !== 'ended';
    },
    async transferScheduledOwnership({ workspaceId, fromUserId, toUserId }) {
      await ensureMeetingsSchema(pool);
      await pool.query(
        `update meetings set owner_user_id = $3
          where workspace_id = $1 and owner_user_id = $2 and status = 'scheduled'`,
        [workspaceId, fromUserId, toUserId],
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
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where workspace_id = $1 order by created_at desc`,
        [workspaceId],
      );
      return result.rows.map(row);
    },
    async listByOwner(ownerUserId) {
      await ensureMeetingsSchema(pool);
      const result = await pool.query(
        `select id, workspace_id, owner_user_id, title, kind, status, scheduled_for, agenda, pace, created_at, ended_at,
                  minutes_text, minutes_todos, minutes_archived_at
           from meetings where owner_user_id = $1 order by created_at asc`,
        [ownerUserId],
      );
      return result.rows.map(row);
    },
    async deleteByOwner(ownerUserId, workspaceIds, transaction) {
      const run = async (db: Pool | PoolClient): Promise<void> => {
        const deleted = await db.query<{ id: string }>(
          `delete from meetings
            where workspace_id = any($1::text[])
               or (owner_user_id = $2 and kind = 'practice')
            returning id`,
          [[...workspaceIds], ownerUserId],
        );
        // A real meeting the account owned in a workspace that stays belongs to that workspace:
        // keep the row and its minutes, and hand it over by clearing the owner.
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
    async create({ id, workspaceId, ownerUserId, title, kind = 'real', status = 'open', scheduledFor, agenda = [], pace }) {
      const meeting: MeetingRow = {
        id: id ?? newMeetingId(),
        workspaceId,
        ownerUserId,
        title,
        kind,
        status,
        scheduledFor: scheduledFor ?? null,
        agenda: [...agenda],
        pace: pace === undefined ? null : { ...pace },
        createdAt: new Date().toISOString(),
        endedAt: null,
      };
      rows.set(meeting.id, meeting);
      return meeting;
    },
    async get(id) {
      return rows.get(id);
    },
    async update(id, patch, options = {}) {
      const meeting = rows.get(id);
      if (meeting === undefined) return undefined;
      if (options.onlyIfScheduled === true && meeting.status !== 'scheduled') return undefined;
      const next: MeetingRow = {
        ...meeting,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.agenda === undefined ? {} : { agenda: [...patch.agenda] }),
        ...(patch.pace === undefined ? {} : { pace: { ...patch.pace } }),
        ...(patch.scheduledFor === undefined ? {} : { scheduledFor: patch.scheduledFor }),
      };
      rows.set(id, next);
      return next;
    },
    async delete(id, options = {}) {
      const meeting = rows.get(id);
      if (meeting === undefined) return false;
      if (options.onlyIfScheduled === true && meeting.status !== 'scheduled') return false;
      return rows.delete(id);
    },
    async markEnded(id, endedAt) {
      const meeting = rows.get(id);
      if (meeting === undefined) return;
      if (meeting.status === 'ended') return;
      rows.set(id, { ...meeting, status: 'ended', endedAt });
    },
    async markOpen(id) {
      const meeting = rows.get(id);
      if (meeting === undefined || meeting.status === 'ended') return false;
      if (meeting.status === 'scheduled') rows.set(id, { ...meeting, status: 'open' });
      return true;
    },
    async transferScheduledOwnership({ workspaceId, fromUserId, toUserId }) {
      for (const [id, meeting] of rows) {
        if (
          meeting.workspaceId === workspaceId &&
          meeting.ownerUserId === fromUserId &&
          meeting.status === 'scheduled'
        ) {
          rows.set(id, { ...meeting, ownerUserId: toUserId });
        }
      }
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
        if (
          wanted.has(meeting.workspaceId) ||
          (meeting.ownerUserId === ownerUserId && meeting.kind === 'practice')
        ) {
          rows.delete(id);
        } else if (meeting.ownerUserId === ownerUserId) {
          // The workspace stays, so the real meeting and its minutes stay with it.
          rows.set(id, { ...meeting, ownerUserId: null });
        }
      }
    },
  };
}
