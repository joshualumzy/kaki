import { randomUUID } from 'node:crypto';
import type { KakiEvent } from '@kaki/shared';
import { CommandError } from '../hub';
import type { LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import { createAgendaClock, type AgendaClock } from './clock';
import { installAutoDispatch } from './autoDispatch';
import { createNotetaker, hasTaskAssignment } from './notetaker';
import { cleanSpokenTopic, openingLine, spokenAgendaName } from './opening';
import { loadReplay, startReplay, type ReplayLine } from './replay';

const TICK_MS = 1_000;
const DEFAULT_NOTETAKER_INTERVAL_MS = 4_500;
/** Republish an unchanged record after this much meeting time so clients can resync their clocks. */
const HEARTBEAT_MEETING_SECONDS = 30;
/** Talk time is compared at this granularity, so every transcript line does not cause a publish. */
const TALK_STEP_SECONDS = 10;

/** How the meeting module runs; `hostModules` builds this from the environment. */
export interface MeetingModuleOptions {
  llm?: LlmClient;
  /** Replay a scripted transcript: a scenario folder to load it from, or the lines themselves. */
  replay?: string | ReplayLine[];
  /** Meeting time per real second while replaying (2 = twice as fast). */
  speed?: number;
  notetakerIntervalMs?: number;
  /** Share the meeting clock with another module (the app stamps settled cards with it); omit to create one. */
  clock?: AgendaClock;
}

/**
 * The meeting record: agenda clock, notetaker and (optionally) the replay feed.
 * Live, the clock starts on the server's one MEETING_STARTED event, not on the first speech; a
 * replay starts it on its first line. A replay moves the agenda on its own markers and ends the
 * meeting after its last line; live, only the screen command moves the agenda.
 */
export function createMeetingModule({
  llm,
  replay,
  speed = 1,
  notetakerIntervalMs = DEFAULT_NOTETAKER_INTERVAL_MS,
  clock: sharedClock,
}: MeetingModuleOptions = {}): KakiModule {
  return {
    name: 'host-meeting',
    start({ hub, tasks, scenario, persistence, meetingId, resetMeetingIdentity, meetingDetails }: KakiContext) {
      // The app server owns the identity; a module run on its own (tests) still gets a stable one.
      let localMeetingId = randomUUID();
      const currentMeetingId = (): string => meetingId?.() ?? localMeetingId;
      const beginNewMeeting = (): string => {
        if (resetMeetingIdentity !== undefined) return resetMeetingIdentity();
        localMeetingId = randomUUID();
        return localMeetingId;
      };
      const clock = sharedClock ?? createAgendaClock({ agenda: scenario.agenda, speed });
      const notetaker = createNotetaker({
        scenario,
        tasks,
        llm,
        agendaIndex: () => clock.snapshot().agendaIndex,
        meetingElapsedSeconds: () => clock.snapshot().meetingElapsedSeconds,
      });
      if (llm === undefined) console.warn('kaki host: no LLM configured; the notetaker only tracks talk time');

      // A compatible saved meeting was loaded before the modules started; take up where it stopped.
      // A pre-Start setup draft restores the setup but leaves the clock and record untouched.
      const saved = persistence?.saved;
      const restoredRunning = saved !== undefined && saved.state.clock.started;
      let meetingStartedAt = restoredRunning ? saved.startedAt : undefined;
      // While the host's New meeting is waiting for the old one to be cleared, no pre-reset snapshot may be saved.
      let resetting = false;
      if (saved !== undefined) {
        clock.restore(saved.state.clock);
        notetaker.restore(saved.state.notetaker);
        if (restoredRunning) {
          console.log(`kaki host: restored the meeting that started at ${saved.startedAt}`);
        } else {
          console.log('kaki host: restored the saved meeting setup; the meeting has not started');
        }
      }

      persistence?.registerSource(() => {
        if (resetting) return undefined;
        const details = meetingDetails?.();
        if (details === undefined) return undefined;
        const now = clock.snapshot();
        return {
          ...(meetingStartedAt === undefined ? {} : { startedAt: meetingStartedAt }),
          ...details,
          state: {
            meetingId: currentMeetingId(),
            agenda: scenario.agenda.map((item) => item.title),
            clock: {
              started: now.started,
              ended: now.ended,
              paused: now.paused === true,
              agendaIndex: now.agendaIndex,
              itemElapsedSeconds: now.itemElapsedSeconds,
              meetingElapsedSeconds: now.meetingElapsedSeconds,
            },
            notetaker: notetaker.snapshot(),
            tasks: tasks.snapshot(),
          },
        };
      });
      let humanHost = false;
      // On by default: Sam dispatches and the recipient accepts or declines. KAKI_AUTO_DISPATCH=0 leaves it to a person on /screen.
      const stopAutoDispatch =
        process.env.KAKI_AUTO_DISPATCH === '0' ? undefined : installAutoDispatch({ hub, tasks, scenario,
          hostIsHuman: () => humanHost, holdUntilSettled: replay === undefined && (scenario.npcs?.length ?? 0) > 0 });

      let lastSignature: string | undefined;
      let lastPublishedAt = 0;

      // Clients keep every record they receive, so publish only when something people see has
      // changed, plus a heartbeat; between records, clients count elapsedSeconds up themselves.
      function publishRecord(): void {
        const now = clock.snapshot();
        if (!now.started) return;
        const { openQuestions, talkSecondsFor, status, quietRoles } = notetaker.state();
        const talk = talkSecondsFor(now.agendaIndex);
        const signature = JSON.stringify([
          now.agendaIndex,
          now.overrun,
          Boolean(now.paused),
          openQuestions,
          status,
          quietRoles,
          Object.entries(talk).map(([role, seconds]) => [role, Math.floor((seconds ?? 0) / TALK_STEP_SECONDS)]),
        ]);
        if (signature === lastSignature && now.meetingElapsedSeconds - lastPublishedAt < HEARTBEAT_MEETING_SECONDS) {
          return;
        }
        lastSignature = signature;
        lastPublishedAt = now.meetingElapsedSeconds;

        const event: KakiEvent = {
          type: 'MEETING_RECORD_UPDATED',
          // Phones don't show the record, and Wingman reads it in-process via hub.subscribe.
          audience: { kind: 'screen' },
          // elapsedSeconds and speakerTalkSeconds are for the current agenda item.
          payload: {
            agendaIndex: now.agendaIndex,
            openQuestions,
            elapsedSeconds: Math.floor(now.itemElapsedSeconds),
            speakerTalkSeconds: Object.fromEntries(
              Object.entries(talk).map(([role, seconds]) => [role, Math.round(seconds ?? 0)]),
            ),
            notetakerStatus: status,
            quietRoles,
            ...(now.paused ? { paused: true } : {}),
          },
        };
        hub.publish(event, { retainKey: 'record' });
      }

      /** Begin the one opening: the clock runs from the server's Start, never from the first speech. */
      function beginMeeting(startedAt?: string): void {
        const now = clock.snapshot();
        if (now.started || now.ended) return;
        clock.start();
        meetingStartedAt ??= startedAt ?? new Date().toISOString();
        // Retained so a screen that opens a moment after Start still shows the welcome.
        hub.publish(
          {
            type: 'HOST_SPEECH_TRIGGERED',
            audience: { kind: 'screen' },
            payload: { kind: 'OPENING', text: openingLine(scenario) },
          },
          { retainKey: 'host:opening' },
        );
      }

      // A failure here must not take the meeting server down with it.
      function guarded(label: string, run: () => void): void {
        try {
          run();
        } catch (error) {
          console.error(`kaki host: ${label} failed`, error);
        }
      }

      function runNotetaker(): Promise<void> {
        return notetaker
          .run()
          .then(() => guarded('publishing the record', publishRecord))
          .catch((error: unknown) => console.error('kaki host: the notetaker pass failed', error));
      }

      clock.onOverrun((index, item) => {
        console.log(`kaki host: agenda item ${index} "${item.title}" is over its ${item.minutes} minutes`);
        hub.publish({
          type: 'HOST_SPEECH_TRIGGERED',
          audience: { kind: 'screen' },
          payload: {
            kind: 'TIMEOUT',
            text: `Hey team, we're a bit past time on ${spokenAgendaName(scenario, item.title)} — let's wrap this one up so we can move on.`,
          },
        });
      });

      // On a restore the room already knows the current item; do not announce it again.
      let announcedAgendaIndex = saved?.state.clock.agendaIndex ?? -1;

      let ticker: ReturnType<typeof setInterval> | undefined;
      function startTicker(): void {
        ticker ??= setInterval(() => {
          guarded('the agenda tick', () => {
            clock.tick();
            publishRecord();
          });
        }, TICK_MS);
      }
      function stopTicker(): void {
        if (ticker !== undefined) clearInterval(ticker);
        ticker = undefined;
      }
      startTicker();

      if (restoredRunning) {
        // Retained so a screen that opens after the restart still says where this meeting came from.
        hub.publish(
          {
            type: 'MEETING_RESTORED',
            audience: { kind: 'screen' },
            payload: { startedAt: saved.startedAt ?? saved.savedAt },
          },
          { retainKey: 'meeting:restored' },
        );
        lastSignature = undefined;
        publishRecord();
      }

      // The next line said after the meeting ended belongs to a new meeting: nothing carries over.
      // `savedCleared` is set by the host's New meeting, which has already waited for the clear itself.
      let ownResetEvent: KakiEvent | undefined;
      function resetMeeting({ savedCleared = false }: { savedCleared?: boolean } = {}): void {
        if (!savedCleared) void persistence?.clearSaved().catch(() => undefined);
        clock.reset();
        notetaker.reset();
        tasks.reset();
        hub.clearRetained('meeting:started');
        hub.clearRetained('record');
        hub.clearRetained('host:opening');
        hub.clearRetained('fact:');
        hub.clearRetained('nudge:');
        hub.clearRetained('meeting:restored');
        meetingStartedAt = undefined;
        lastSignature = undefined;
        lastPublishedAt = 0;
        announcedAgendaIndex = -1;
        startTicker();
        // The reset starts a new meeting: the server rotates the identity before anyone sees the event.
        const reset: KakiEvent = {
          type: 'MEETING_RESET',
          audience: { kind: 'all' },
          payload: { meetingId: beginNewMeeting() },
        };
        ownResetEvent = reset;
        hub.publish(reset);
        ownResetEvent = undefined;
        console.log('kaki host: a new meeting starts; the old record, questions and tasks are cleared');
      }

      /** Tell the room when the meeting has moved on to a new agenda item. */
      function announceAgendaItem(): void {
        const currentAgendaIndex = clock.snapshot().agendaIndex;
        if (currentAgendaIndex > 0 && currentAgendaIndex !== announcedAgendaIndex) {
          announcedAgendaIndex = currentAgendaIndex;
          const item = scenario.agenda[currentAgendaIndex];
          if (item) {
            hub.publish({
              type: 'HOST_SPEECH_TRIGGERED',
              audience: { kind: 'screen' },
              payload: { kind: 'OPENING', text: `Next up: ${cleanSpokenTopic(item.title)}.` },
            });
          }
        }
      }

      const unsubscribe = hub.subscribe((event) => {
        if (event.type === 'MEETING_RESET') {
          // A reset published by another module (the join guard) must clear the saved meeting too.
          if (event !== ownResetEvent) void persistence?.clearSaved().catch(() => undefined);
          const wasActive = clock.snapshot().started || clock.snapshot().ended;
          clock.reset();
          notetaker.reset();
          tasks.reset();
          hub.clearRetained('meeting:started');
          hub.clearRetained('record');
          hub.clearRetained('host:opening');
          hub.clearRetained('fact:');
          hub.clearRetained('nudge:');
          hub.clearRetained('meeting:restored');
          meetingStartedAt = undefined;
          lastSignature = undefined;
          lastPublishedAt = 0;
          announcedAgendaIndex = -1;
          if (wasActive) {
            startTicker();
          }
          return;
        }
        if (event.type === 'MEETING_STARTED') {
          beginMeeting(event.payload.startedAt);
          return;
        }
        if (event.type !== 'TRANSCRIPT_CHUNK') return;

        const afterEnding = clock.snapshot().ended;
        if (afterEnding) resetMeeting();
        if (!clock.snapshot().started) {
          // The scripted replay and the first line of a meeting that just ended have no browser
          // pressing Start; any other live speech waits for the server's Start.
          if (replay === undefined && !afterEnding) return;
          beginMeeting();
        }

        notetaker.addChunk(event.payload);
        if (replay === undefined && hasTaskAssignment(event.payload.text)) {
          setTimeout(() => void runNotetaker(), 250).unref();
        }

        announceAgendaItem();
      });
      const notetakerTimer = setInterval(() => void runNotetaker(), notetakerIntervalMs);

      /** Freeze the clock and stop the heartbeat, and clear old events so the next visitor starts clean. */
      function endMeeting({ silent = false }: { silent?: boolean } = {}): void {
        const now = clock.snapshot();
        if (!now.started || now.ended) return;
        clock.end();
        stopTicker();
        console.log('kaki host: the meeting is over');
        if (silent) {
          resetMeeting();
          return;
        }
        // One last record so screens show the frozen clock, then a final notetaker pass for the last lines.
        lastSignature = undefined;
        guarded('publishing the record', publishRecord);
        hub.publish({
          type: 'HOST_SPEECH_TRIGGERED',
          audience: { kind: 'screen' },
          payload: {
            kind: 'CLOSING',
            text: `Alright team, that wraps up our huddle. Thanks everyone, let's get back to the floor.`,
          },
        });
        void runNotetaker();
      }

      hub.onCommand(async (command, sender) => {
        if (
          command.type !== 'END_MEETING' &&
          command.type !== 'NEW_MEETING' &&
          command.type !== 'NEXT_AGENDA_ITEM' &&
          command.type !== 'SET_HOST_MODE' &&
          command.type !== 'SET_PAUSED'
        ) {
          return;
        }
        if (sender !== 'screen') throw new CommandError('Only the shared screen can do that');
        if (command.type === 'NEW_MEETING') {
          // Only say the meeting started once the old one is really gone; otherwise the host must know.
          if (persistence !== undefined) {
            resetting = true;
            try {
              try {
                await persistence.clearSaved();
              } catch {
                throw new CommandError("Couldn't clear the saved meeting — try again");
              }
              resetMeeting({ savedCleared: true });
            } finally {
              // Always let snapshots through again, whether the clear failed or the reset threw.
              resetting = false;
            }
          } else {
            resetMeeting({ savedCleared: true });
          }
          return;
        }
        if (command.type === 'SET_HOST_MODE') {
          humanHost = command.human;
          return;
        }
        if (command.type === 'SET_PAUSED') {
          if (command.paused) clock.pause();
          else clock.resume();
          lastSignature = undefined;
          publishRecord();
          return;
        }
        if (command.type === 'END_MEETING') {
          endMeeting({ silent: command.silent === true });
          return;
        }
        const now = clock.snapshot();
        if (!now.started || now.ended) throw new CommandError('The meeting is not running');
        if (now.agendaIndex + 1 >= scenario.agenda.length) throw new CommandError('That was the last agenda item');
        clock.advanceTo(now.agendaIndex + 1);
        publishRecord();
        announceAgendaItem();
      });

      let stopReplay: (() => void) | undefined;
      let stopped = false;
      if (replay !== undefined && restoredRunning) {
        console.log('kaki host: the saved meeting was restored; the scripted replay stays stopped');
      }
      if (replay !== undefined && !restoredRunning) {
        const lines = typeof replay === 'string' ? loadReplay(scenario, replay) : Promise.resolve(replay);
        lines.then(
          (loaded) => {
            if (stopped) return;
            console.log(`kaki host: replaying ${loaded.length} transcript lines at ${speed}x`);
            stopReplay = startReplay({
              lines: loaded,
              hub,
              speed,
              onAgenda: (index) => clock.advanceTo(index),
              onEnd: () => endMeeting(),
            });
          },
          (error: unknown) => console.error('kaki host: could not start the replay', error),
        );
      }

      return () => {
        stopped = true;
        stopReplay?.();
        unsubscribe();
        stopAutoDispatch?.();
        stopTicker();
        clearInterval(notetakerTimer);
      };
    },
  };
}

export { openingLine } from './opening';
