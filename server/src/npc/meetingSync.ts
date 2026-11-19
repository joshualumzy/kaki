import type { RunnerMeetingState, RunnerStartState } from './runner';

/** What one MEETING_STARTED event tells the runner about the meeting the server opened. */
export interface StartedEvent {
  meetingId: string;
  agendaIndex?: number;
  resumed?: boolean;
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
export function createMeetingSync({ runner, fetchState, log }: MeetingSyncOptions): MeetingSync {
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
      readState((state) => runner.reconcileMeeting(state));
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
        if (runner.meetingId() !== state.meetingId) runner.resetMeeting(state.meetingId);
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
