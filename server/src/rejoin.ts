/** How long an empty live-demo meeting is kept for the same person to return. */
export const DEFAULT_REJOIN_GRACE_MS = 120_000;

/** What an arriving person gets: carry on the meeting, start the next one, or join the occupied room. */
export type Admission = 'resume' | 'reset' | 'join';

/** Which person holds which seat, owned by the meeting session. */
export interface SeatHolder {
  name: string;
  seat: string;
}

export interface AdmissionInput {
  /** The session's phase; rejoin never derives it from speech or the transcript. */
  phase: 'lobby' | 'starting' | 'running' | 'ended';
  /** The seat holders the session knows, so the people who left may come back. */
  holders: readonly SeatHolder[];
  /** Everyone already in the room, excluding the joiner. */
  present: readonly unknown[];
  name: string;
  seat?: string;
  /** Whether the empty-room grace window is open right now. */
  graceActive: boolean;
}

const normalise = (name: string): string => name.trim().toLowerCase();

function isHolder(holders: readonly SeatHolder[], name: string, seat?: string): boolean {
  const wantedName = normalise(name);
  const wantedSeat = seat?.trim().toLowerCase();
  return holders.some((holder) => {
    if (normalise(holder.name) === wantedName) return true;
    return (
      wantedSeat !== undefined &&
      wantedSeat !== '' &&
      holder.seat.trim().toLowerCase() === wantedSeat &&
      normalise(holder.name) === wantedName
    );
  });
}

/**
 * The one admission rule. A running meeting (or a lobby meeting someone already joined) holds for
 * its seat holders while the room is empty and the grace is open; a stranger starts the next one.
 * A restored meeting with no holders is carried on by whoever arrives first inside the grace.
 */
export function admission({ phase, holders, present, name, seat, graceActive }: AdmissionInput): Admission {
  // People are still in the room: this is an ordinary join, never a reset under their feet
  // (an ended meeting may still have minutes waiting for their approval).
  if (present.length > 0) return 'join';
  // The meeting is over and the room is empty: a new guest must never land in a finished meeting.
  if (phase === 'ended') return 'reset';
  // Inside the grace, whoever arrives first carries on a meeting that has no saved holders.
  if (holders.length === 0) return phase === 'running' && graceActive ? 'resume' : 'reset';
  if (!graceActive) return 'reset';
  return isHolder(holders, name, seat) ? 'resume' : 'reset';
}

export interface RejoinGuardOptions {
  /** How long the meeting survives an empty room; 0 resets as soon as someone joins an empty room. */
  graceMs: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** How often the app server checks who is in the live-demo room. */
export const REJOIN_POLL_MS = 5_000;

/**
 * The one place that owns "the room has been empty since T". The session owns the phase and the
 * seat holders; this guard only owns the empty-room grace window and tells the app when it ends so
 * the holders who did not come back can be pruned.
 */
export interface RejoinGuard {
  /** The server observed the room empty: start the grace window. Repeated calls are ignored. */
  emptied(): void;
  /** The server observed people again: cancel the grace window without resetting anything. */
  occupied(): void;
  /** Treat this arrival as the moment the room emptied, if no poll saw it (the join race). */
  beginGrace(): void;
  /** The grace window is open right now (not merely started and left to expire). */
  graceActive(): boolean;
  /** The window has been started and not cleared, even if it has already expired. */
  isEmpty(): boolean;
  /** Whether a known holder would be kept if they arrived now (the pre-commit decision). */
  wouldHold(): boolean;
  /** A person joined: clear the window and log how long the pause was. */
  joined(): void;
  /** A new meeting starts: forget the grace without pruning anything. */
  reset(): void;
  /** Run `hook` when the grace expires; the app prunes the holders that did not return. */
  onGraceExpired(hook: () => void): () => void;
  /** Stop the grace timer. */
  close(): void;
}

/** Create the guard that holds the meeting open for `graceMs` after the room empties. */
export function createRejoinGuard({
  graceMs,
  now = Date.now,
  log = (message) => console.log(message),
}: RejoinGuardOptions): RejoinGuard {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(`The rejoin grace must be a non-negative number of milliseconds, got ${graceMs}`);
  }

  let emptySince: number | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const expiryHooks = new Set<() => void>();

  function clearExpiry(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  function elapsed(): number | undefined {
    return emptySince === undefined ? undefined : Math.max(0, now() - emptySince);
  }

  function graceActive(): boolean {
    if (emptySince === undefined || graceMs <= 0) return false;
    return (elapsed() ?? 0) < graceMs;
  }

  function emptied(): void {
    if (emptySince !== undefined) return;
    emptySince = now();
    if (graceMs <= 0) return;
    log('[rejoin] grace started');
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      log('[rejoin] grace expired, reset on next join');
      for (const hook of expiryHooks) {
        try {
          hook();
        } catch (error) {
          console.error('kaki rejoin: a grace-expiry hook failed', error);
        }
      }
    }, graceMs);
    expiryTimer.unref?.();
  }

  function occupied(): void {
    if (emptySince === undefined) return;
    emptySince = undefined;
    clearExpiry();
  }

  return {
    emptied,
    occupied,
    beginGrace() {
      emptied();
    },
    graceActive,
    isEmpty: () => emptySince !== undefined,
    wouldHold: () => graceMs > 0 && (emptySince === undefined || (elapsed() ?? 0) < graceMs),
    joined() {
      if (emptySince === undefined) return;
      log(`[rejoin] resumed after ${Math.round((elapsed() ?? 0) / 1000)} s`);
      occupied();
    },
    reset: occupied,
    onGraceExpired(hook) {
      expiryHooks.add(hook);
      return () => {
        expiryHooks.delete(hook);
      };
    },
    close: clearExpiry,
  };
}

export interface RoomPollOptions {
  guard: Pick<RejoinGuard, 'emptied' | 'occupied'>;
  /** Whether a meeting is worth watching: someone joined, or it is running. */
  hasMeeting: () => boolean;
  /** Who is in the room, or undefined when LiveKit cannot be asked. */
  roster: (roomName: string) => Promise<readonly { name: string }[] | undefined>;
  /** The room of the last successful join; read on every poll. */
  roomName: () => string | undefined;
  /** True for a person (not an AI attendee), matching how the join route counts who is present. */
  isHuman: (name: string) => boolean;
  /** How often to look; defaults to `REJOIN_POLL_MS`. */
  intervalMs?: number;
}

export interface RoomPoll {
  /** Start watching after the first join; repeated calls are ignored. */
  start(): void;
  close(): void;
}

/**
 * Watch the live-demo room while a meeting exists, so the app server sees the room empty on its
 * own instead of waiting for a message from the NPC process (whose ordering it cannot rely on).
 */
export function createRoomPoll({
  guard,
  hasMeeting,
  roster,
  roomName,
  isHuman,
  intervalMs = REJOIN_POLL_MS,
}: RoomPollOptions): RoomPoll {
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;

  async function poll(): Promise<void> {
    if (polling || closed || !hasMeeting()) return;
    const name = roomName();
    if (name === undefined) return;
    polling = true;
    try {
      const people = await roster(name);
      // LiveKit not reachable: change nothing.
      if (people === undefined || closed) return;
      if (people.filter((person) => isHuman(person.name)).length === 0) guard.emptied();
      else guard.occupied();
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer !== undefined || closed) return;
      timer = setInterval(() => {
        void poll().catch((error: unknown) => {
          console.error('kaki server: could not check who is in the room', error);
        });
      }, intervalMs);
      timer.unref?.();
    },
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Read `KAKI_REJOIN_GRACE_MS`; absent means the default, and 0 keeps the old reset-on-empty behaviour. */
export function rejoinGraceMsFromEnv(): number {
  const raw = process.env.KAKI_REJOIN_GRACE_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_REJOIN_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid KAKI_REJOIN_GRACE_MS: ${raw}`);
  return value;
}
