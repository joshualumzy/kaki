import type { RunnerMeetingState, RunnerStartState } from './runner';

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

/** The runner operations the sync needs; the real one is `startNpcRunner`'s return value. */
export interface MeetingSyncRunner {
  meetingId(): string | undefined;
  wasPreparedFor(meetingId: string): boolean;
  reconcileMeeting(state: RunnerMeetingState): void;
  markStarted(state: RunnerStartState & { meetingId?: string }): Promise<void>;
  resetMeeting(meetingId?: string): void;
}

export interface MeetingSyncOptions {
  runner: MeetingSyncRunner;
  /** Read the server's authoritative state; injected so tests need no HTTP server. */
  fetchState(): Promise<RunnerMeetingState>;
  log(message: string): void;
  /** The runner moved from one meeting to another: anything tagged for the old one is stale. */
  onMeetingChanged?(meetingId: string): void;
}

export interface MeetingSync {
  /** A service socket (re)connected: discard anything older, then adopt the server's state. */
  connected(): void;
  /** A Start attempt is beginning: a state read asked for before it belongs to the old meeting. */
  prepareStarted(): void;
  /** MEETING_STARTED arrived: open immediately for this attempt, otherwise hydrate from the server. */
  started(event: StartedEvent): void;
  /** MEETING_RESET arrived: clear the local meeting and refuse every older state fetch. */
  reset(meetingId?: string): void;
}

/**
 * Keeps the AI runner's local meeting state aligned with the server across reconnects and resets.
 * Every asynchronous fetch is fenced by a generation, so a response asked for before a reset (or
 * before a socket was replaced) can never reopen a meeting the server has already cleared.
 */
export function createMeetingSync({ runner, fetchState, log, onMeetingChanged }: MeetingSyncOptions): MeetingSync {
  let generation = 0;

  function readState(accept: (state: RunnerMeetingState) => void): void {
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
      readState((state) => {
        const previous = runner.meetingId();
        runner.reconcileMeeting(state);
        if (previous !== undefined && previous !== state.meetingId) {
          onMeetingChanged?.(state.meetingId);
        }
      });
    },
    prepareStarted() {
      generation += 1;
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
        // Hydration is always a resume: this runner never welcomed the meeting the server is running.
        const previous = runner.meetingId();
        if (previous !== state.meetingId) runner.resetMeeting(state.meetingId);
        if (previous !== undefined && previous !== state.meetingId) {
          onMeetingChanged?.(state.meetingId);
        }
        void runner
          .markStarted({
            meetingId: state.meetingId,
            ...(state.agendaIndex === undefined ? {} : { agendaIndex: state.agendaIndex }),
            resumed: true,
          })
          .catch((error: unknown) => log(`could not resume the running meeting: ${String(error)}`));
      });
    },
    reset(meetingId) {
      generation += 1;
      runner.resetMeeting(meetingId);
    },
  };
}
