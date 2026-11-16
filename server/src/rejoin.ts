/** How long an empty live-demo meeting is kept for the same person to return. */
export const DEFAULT_REJOIN_GRACE_MS = 120_000;

/**
 * What an arriving person gets when the room is empty: either start a fresh meeting, or carry on the
 * paused one because the same person came back inside the grace.
 */
export interface RejoinDecision {
  /** Start a fresh meeting: new code, cleared tasks, a fresh agenda and record. */
  reset: boolean;
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
 * The one place that owns "the room has been empty since T". The app server observes the roster
 * itself and decides when an empty meeting is reset; the NPC runner keeps its own local pause and
 * reacts to `MEETING_RESET` rather than guessing from the room on its own.
 */
export interface RejoinGuard {
  /** Record a successful join so the people in this meeting may return without the code. */
  joined(name: string, decision: RejoinDecision): void;
  /** The meeting has begun speaking (or is hosted by a human): a returning guest resumes it without the Start tour. */
  began(): void;
  /** Whether the meeting has begun speaking since the last reset. */
  hasBegun(): boolean;
  /** The server observed the room empty: start the grace window. Repeated calls are ignored. */
  emptied(): void;
  /** The server observed people again: cancel the grace window without resetting anything. */
  occupied(): void;
  /** The meeting has ended: nobody resumes it, the next arrival in an empty room starts a new one. */
  ended(): void;
  /** Whether a meeting exists: someone has joined since the last reset. */
  hasMeeting(): boolean;
  /** What someone arriving in an empty room should get. */
  admit(name: string): RejoinDecision;
  /** Stop the grace timer. */
  close(): void;
}

const normalise = (name: string): string => name.trim().toLowerCase();

/** Create the guard that holds the meeting open for `graceMs` after the room empties. */
export function createRejoinGuard({
  graceMs,
  now = Date.now,
  log = (message) => console.log(message),
}: RejoinGuardOptions): RejoinGuard {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(`The rejoin grace must be a non-negative number of milliseconds, got ${graceMs}`);
  }

  let started = false;
  let begun = false;
  let finished = false;
  const humans = new Set<string>();
  let emptySince: number | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearExpiry(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  function emptied(): void {
    if (emptySince !== undefined) return;
    emptySince = now();
    if (graceMs <= 0) return;
    log('[rejoin] grace started');
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      log('[rejoin] grace expired, reset on next join');
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
    began() {
      if (!started || finished) return;
      begun = true;
    },
    hasBegun: () => started && begun && !finished,
    ended() {
      if (!started || finished) return;
      finished = true;
      log('[rejoin] meeting ended, the next arrival starts a new one');
    },
    hasMeeting: () => started,
    admit(name) {
      // Nobody has joined since the last reset: there is no meeting to keep.
      if (!started) return { reset: true };
      // The meeting is over: a new guest must not land in a finished meeting where nobody speaks.
      if (finished) return { reset: true };
      // The grace is off: every arrival into an empty room starts a new meeting.
      if (graceMs <= 0) return { reset: true };
      // The last person may have left after the previous poll: treat this arrival as the moment the
      // room emptied, so the same person resumes instead of losing the meeting to a cross-process race.
      if (emptySince === undefined) emptied();
      const since = emptySince;
      if (since === undefined) return { reset: true };
      const elapsed = Math.max(0, now() - since);
      if (elapsed >= graceMs) return { reset: true };
      // The grace holds the paused meeting only for the person who left. Anyone else starts fresh.
      return { reset: !humans.has(normalise(name)) };
    },
    joined(name, decision) {
      if (decision.reset) {
        begun = false;
        finished = false;
        humans.clear();
        emptySince = undefined;
        clearExpiry();
      } else {
        const elapsed = emptySince === undefined ? 0 : Math.max(0, now() - emptySince);
        log(`[rejoin] resumed after ${Math.round(elapsed / 1000)} s`);
        emptySince = undefined;
        clearExpiry();
      }
      started = true;
      humans.add(normalise(name));
    },
    close: clearExpiry,
  };
}

export interface RoomPollOptions {
  guard: Pick<RejoinGuard, 'hasMeeting' | 'emptied' | 'occupied'>;
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
  roster,
  roomName,
  isHuman,
  intervalMs = REJOIN_POLL_MS,
}: RoomPollOptions): RoomPoll {
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;

  async function poll(): Promise<void> {
    if (polling || closed || !guard.hasMeeting()) return;
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
