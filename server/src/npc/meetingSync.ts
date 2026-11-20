import type { RunnerMeetingSnapshot } from '@kaki/shared';

/** What one MEETING_STARTED event tells the runner about the meeting the server opened. */
export interface StartedEvent {
  meetingId: string;
  agendaIndex?: number;
  resumed?: boolean;
}

/** A prepare request from the server, once its wire form has been checked. */
export interface PrepareRequest {
  requestId: string;
  attempt: string;
  meetingId: string;
  agendaIndex?: number;
  resumed?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalAgendaIndex(value: unknown): { agendaIndex?: number } {
  return typeof value === 'number' ? { agendaIndex: value } : {};
}

function optionalResumed(value: unknown): { resumed?: boolean } {
  return typeof value === 'boolean' ? { resumed: value } : {};
}

/**
 * Read a prepare request from the service channel, or undefined when it cannot identify the attempt.
 * A request without a meeting id cannot be fenced, so it must never reach the runner.
 */
export function parsePrepareRequest(value: unknown): PrepareRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Record<string, unknown>;
  if (!isNonEmptyString(request.requestId) || !isNonEmptyString(request.attempt) || !isNonEmptyString(request.meetingId)) {
    return undefined;
  }
  return {
    requestId: request.requestId,
    attempt: request.attempt,
    meetingId: request.meetingId,
    ...optionalAgendaIndex(request.agendaIndex),
    ...optionalResumed(request.resumed),
  };
}

/** Read a MEETING_STARTED payload, or undefined when it names no meeting to open. */
export function parseStartedEvent(value: unknown): StartedEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const payload = value as Record<string, unknown>;
  if (!isNonEmptyString(payload.meetingId)) return undefined;
  return {
    meetingId: payload.meetingId,
    ...optionalAgendaIndex(payload.agendaIndex),
    ...optionalResumed(payload.resumed),
  };
}

/** How one server prepare attempt ended. */
export type PrepareOutcome =
  | { kind: 'prepared' }
  | { kind: 'failed'; reason: string }
  | { kind: 'superseded'; reason: string };

/** The runner operations the sync needs; the real one is `startNpcRunner`'s return value. */
export interface MeetingSyncRunner {
  meetingId(): string | undefined;
  wasPreparedFor(meetingId: string): boolean;
  /** Replace the meeting from a server snapshot; true when a newer version was adopted. */
  reconcileMeeting(state: RunnerMeetingSnapshot, options?: { currentConnection?: boolean }): boolean;
  prepareMeeting(request: {
    meetingId: string;
    attempt: string;
    agendaIndex?: number;
    resumed?: boolean;
    snapshot?: RunnerMeetingSnapshot;
  }): Promise<void>;
  markStarted(state: { meetingId?: string; agendaIndex?: number; resumed?: boolean }): Promise<void>;
  resetMeeting(meetingId?: string): void;
}

export interface MeetingSyncOptions {
  runner: MeetingSyncRunner;
  /** Read the server's authoritative snapshot; injected so tests need no HTTP server. */
  fetchState(): Promise<RunnerMeetingSnapshot>;
  log(message: string): void;
  /** The runner moved from one meeting to another: anything tagged for the old one is stale. */
  onMeetingChanged?(meetingId: string): void;
  /**
   * A newer snapshot was adopted. Anything queued against the old state (an unsent pause intent)
   * must be dropped: the snapshot now says what the server actually owns.
   */
  onSnapshotAdopted?(state: RunnerMeetingSnapshot): void;
}

export interface MeetingSync {
  /** A service socket (re)connected: discard anything older, then adopt the server's snapshot. */
  connected(): void;
  /**
   * Prepare one Start attempt from one snapshot, fenced end to end. A reset, reconnect or newer
   * attempt supersedes it: the late answer is logged and never reaches the runner.
   */
  prepare(request: PrepareRequest): Promise<PrepareOutcome>;
  /** MEETING_STARTED arrived: open immediately for this attempt, otherwise hydrate from the server. */
  started(event: StartedEvent): void;
  /** A RUNNER_STATE event arrived: adopt it unless it is older than the snapshot already held. */
  snapshot(state: RunnerMeetingSnapshot): void;
  /** MEETING_RESET arrived: clear the local meeting and refuse every older state fetch. */
  reset(meetingId?: string): void;
}

/**
 * Keeps the AI runner's local meeting state aligned with the server across reconnects and resets.
 * Every asynchronous fetch is fenced by a generation, so a response asked for before a reset (or
 * before a socket was replaced) can never reopen a meeting the server has already cleared.
 * Snapshots are additionally fenced by meeting id and version inside the runner's RunnerMeeting.
 */
export function createMeetingSync({
  runner,
  fetchState,
  log,
  onMeetingChanged,
  onSnapshotAdopted,
}: MeetingSyncOptions): MeetingSync {
  let generation = 0;

  function apply(state: RunnerMeetingSnapshot): void {
    const previous = runner.meetingId();
    // Everything this module applies came from the live service connection: a fetch tied to the
    // current generation, or an event on the current socket. That authority is what lets the runner
    // adopt a restarted server's new epoch even when its sequence starts again.
    const adopted = runner.reconcileMeeting(state, { currentConnection: true });
    if (adopted) onSnapshotAdopted?.(state);
    // Only a snapshot the runner actually adopted can have moved the meeting; a stale read that was
    // refused must not throw away the current meeting's queued commands.
    const moved = runner.meetingId();
    if (previous !== undefined && moved !== undefined && previous !== moved) {
      onMeetingChanged?.(moved);
    }
  }

  function readState(accept: (state: RunnerMeetingSnapshot) => void): void {
    const asked = generation;
    void fetchState()
      .then((state) => {
        if (asked !== generation) {
          log('discarded a meeting-state fetch that a reset or reconnect superseded');
          return;
        }
        accept(state);
      })
      .catch((error: unknown) => {
        if (asked !== generation) return;
        log(`could not read the meeting state: ${String(error)}`);
      });
  }

  return {
    connected() {
      generation += 1;
      readState(apply);
    },
    async prepare(request) {
      // One generation fence covers the whole continuation: fetch, snapshot adoption and the
      // runner's preparation. Any reset, reconnect, Start or newer prepare changes it.
      generation += 1;
      const fence = generation;
      const supersededReason = `prepare attempt ${request.attempt} for meeting ${request.meetingId} was superseded`;
      let state: RunnerMeetingSnapshot;
      try {
        state = await fetchState();
      } catch (error: unknown) {
        if (fence !== generation) {
          log(`discarded a superseded meeting-state read: ${supersededReason}`);
          return { kind: 'superseded', reason: supersededReason };
        }
        log(`could not read the meeting state: ${String(error)}`);
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      if (fence !== generation) {
        log(`discarded a superseded prepare snapshot: ${supersededReason}`);
        return { kind: 'superseded', reason: supersededReason };
      }
      if (state.meetingId !== request.meetingId) {
        return {
          kind: 'failed',
          reason: `the server state names meeting ${state.meetingId}, not ${request.meetingId}`,
        };
      }
      apply(state);
      try {
        await runner.prepareMeeting({
          meetingId: request.meetingId,
          attempt: request.attempt,
          ...(request.agendaIndex === undefined ? {} : { agendaIndex: request.agendaIndex }),
          ...(request.resumed === undefined ? {} : { resumed: request.resumed }),
          snapshot: state,
        });
      } catch (error: unknown) {
        if (fence !== generation) {
          log(`discarded a superseded prepare: ${supersededReason}`);
          return { kind: 'superseded', reason: supersededReason };
        }
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      if (fence !== generation) {
        log(`discarded a superseded prepare: ${supersededReason}`);
        return { kind: 'superseded', reason: supersededReason };
      }
      if (runner.meetingId() !== request.meetingId) {
        return {
          kind: 'failed',
          reason: `the runner moved to meeting ${runner.meetingId()} while preparing ${request.meetingId}`,
        };
      }
      return { kind: 'prepared' };
    },
    started(event) {
      // Any state read asked for before this start would say "not started"; it must not undo it.
      generation += 1;
      // A start we prepared for is the server committing this exact attempt: open it now, with the
      // welcome a fresh meeting expects. Anything else is a meeting that was already running.
      if (runner.meetingId() === event.meetingId && runner.wasPreparedFor(event.meetingId)) {
        void runner
          .markStarted({
            meetingId: event.meetingId,
            ...(event.agendaIndex === undefined ? {} : { agendaIndex: event.agendaIndex }),
            resumed: event.resumed === true,
          })
          .catch((error: unknown) => log(`could not open the prepared meeting: ${String(error)}`));
        return;
      }
      readState((state) => {
        if (state.meetingId !== event.meetingId || state.started !== true) {
          log(
            `ignored MEETING_STARTED for ${event.meetingId}: the server state is ` +
              `${state.meetingId} (started=${state.started})`,
          );
          return;
        }
        apply(state);
      });
    },
    snapshot(state) {
      const previous = runner.meetingId();
      apply(state);
      const moved = runner.meetingId();
      if (previous !== undefined && moved !== undefined && previous !== moved) {
        // Reads and prepares asked for before this meeting moved cannot speak for the new one.
        generation += 1;
        log(`discarded reads started before the runner moved from ${previous} to ${moved}`);
      }
    },
    reset(meetingId) {
      generation += 1;
      runner.resetMeeting(meetingId);
    },
  };
}
