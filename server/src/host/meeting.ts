import type { KakiEvent } from '@kaki/shared';
import { CommandError, audienceRole } from '../core/hub';
import type { LlmClient } from '../services/llm';
import type { KakiContext, KakiModule } from '../core/modules';
import { createAgendaClock, type AgendaClock } from './clock';
import { installAutoDispatch } from './autoDispatch';
import { hostIsHumanFromSession } from '../meeting/runnerState';
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
interface MeetingModuleOptions {
  llm?: LlmClient;
  /** The model that judges meaning for answers and assignments; defaults to `llm`. */
  verifier?: LlmClient;
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
  verifier,
  replay,
  speed = 1,
  notetakerIntervalMs = DEFAULT_NOTETAKER_INTERVAL_MS,
  clock: sharedClock,
}: MeetingModuleOptions = {}): KakiModule {
  return {
    name: 'host-meeting',
    start({
      hub,
      tasks,
      activeScenario,
      persistence,
      resetMeeting: resetMeetingSession,
      serializeChange,
      onReset,
      meetingDetails,
      session,
    }: KakiContext) {
      const clock = sharedClock ?? createAgendaClock({ agenda: activeScenario().agenda, speed });
      clock.setAgenda(activeScenario().agenda);
      const runSerialized = async <T>(task: () => Promise<T> | T): Promise<T> =>
        serializeChange === undefined ? await task() : await serializeChange(task);
      const notetaker = createNotetaker({
        scenario: activeScenario,
        tasks,
        llm,
        ...(verifier === undefined ? {} : { verifier }),
        agendaIndex: () => clock.snapshot().agendaIndex,
        meetingElapsedSeconds: () => clock.snapshot().meetingElapsedSeconds,
        // Who is in the room: an AI seat is always there, a person seat only while someone holds it.
        attendingRoles: () => {
          const setup = session?.sealed();
          if (setup === undefined) return undefined;
          const held = new Set((session?.holders() ?? []).map((holder) => holder.seat.trim().toLowerCase()));
          return new Set(
            setup.seats
              .filter((seat) => seat.kind === 'ai' || held.has(seat.roleId.trim().toLowerCase()))
              .map((seat) => seat.roleId),
          );
        },
        // The "can you..." -> the one visitor shortcut only makes sense with a single person in the room.
        visitorOwnerShortcut: () => (meetingDetails?.().holders.length ?? 0) < 2,
      });
      if (llm === undefined) console.warn('kaki host: no LLM configured; the notetaker only tracks talk time');

      // A compatible saved meeting was loaded before the modules started; take up where it stopped.
      // A pre-Start setup draft restores the setup but leaves the clock and record untouched.
      const saved = persistence?.saved;
      const restoredRunning =
        saved !== undefined &&
        (saved.phase === 'running' || (saved.state.clock.started && !saved.state.clock.ended));
      // An ended meeting that came back consumed still needs its start time in the saved shape.
      let meetingStartedAt =
        saved !== undefined && (saved.phase === 'running' || saved.phase === 'ended')
          ? saved.startedAt
          : restoredRunning
            ? saved.startedAt
            : undefined;
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
          ...details,
          ...(meetingStartedAt === undefined ? {} : { startedAt: meetingStartedAt }),
          state: {
            clock: {
              started: now.started,
              ended: now.ended,
              paused: now.paused === true,
              ...(now.pauseKind === undefined ? {} : { pauseKind: now.pauseKind }),
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
      // A held suggestion waits for the active cast's Director to settle its topic. With no AI cast
      // there is no Director and no TOPIC_SETTLED, so the normal non-held rule must apply. Read the
      // cast now, not the pack captured at boot: Start can replace it with an all-person meeting.
      const holdSuggestionsUntilSettled = (): boolean =>
        replay === undefined && (activeScenario().npcs?.length ?? 0) > 0;
      // On by default: Sam dispatches and the recipient accepts or declines. KAKI_AUTO_DISPATCH=0 leaves it to a person in the Kaki dock.
      const stopAutoDispatch =
        process.env.KAKI_AUTO_DISPATCH === '0' ? undefined : installAutoDispatch({ hub, tasks, scenario: activeScenario,
          hostIsHuman: session === undefined
            ? () => humanHost
            : () => hostIsHumanFromSession(session, activeScenario()),
          holdUntilSettled: holdSuggestionsUntilSettled,
          agendaIndex: () => clock.snapshot().agendaIndex });

      let lastSignature: string | undefined;
      let lastPublishedAt = 0;

      // Clients keep every record they receive, so publish only when something people see has
      // changed, plus a heartbeat; between records, clients count elapsedSeconds up themselves.
      function publishRecord(): void {
        const now = clock.snapshot();
        if (!now.started) return;
        const { openQuestions, reviewIssues, talkSecondsFor, status, quietRoles } = notetaker.state();
        const talk = talkSecondsFor(now.agendaIndex);
        const signature = JSON.stringify([
          now.agendaIndex,
          now.overrun,
          Boolean(now.paused),
          now.paused ? now.pauseKind ?? null : null,
          openQuestions,
          reviewIssues,
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
            ...(reviewIssues.length === 0 ? {} : { reviewIssues }),
            elapsedSeconds: Math.floor(now.itemElapsedSeconds),
            speakerTalkSeconds: Object.fromEntries(
              Object.entries(talk).map(([role, seconds]) => [role, Math.round(seconds ?? 0)]),
            ),
            notetakerStatus: status,
            quietRoles,
            ...(now.paused
              ? { paused: true, ...(now.pauseKind === undefined ? {} : { pauseKind: now.pauseKind }) }
              : {}),
            ...(now.ended ? { ended: true } : {}),
          },
        };
        hub.publish(event, { retainKey: 'record' });
      }

      // Pause and resume come from the person's command or the app's room poll; both change the
      // clock's state, and both must refresh the screen record the same way.
      const stopPauseWatch = clock.onPauseChange(() => {
        lastSignature = undefined;
        guarded('publishing the record', publishRecord);
      });

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
            payload: { kind: 'OPENING', text: openingLine(activeScenario()) },
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
            text: `Hey team, we're a bit past time on ${spokenAgendaName(activeScenario(), item.title)} — let's wrap this one up so we can move on.`,
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
      } else if (saved !== undefined && saved.phase === 'ended') {
        // An ended meeting under review: republish its frozen record, marked ended, so a screen
        // that opens after the restart sees the meeting as over, never a running clock.
        lastSignature = undefined;
        publishRecord();
      }

      // A reset clears this module's own state. The meeting session owns the reset itself: identity,
      // retained keys, saved state and the one MEETING_RESET notification.
      const stopResetHook = onReset?.(() => {
        clock.reset();
        clock.setAgenda(activeScenario().agenda);
        notetaker.reset();
        meetingStartedAt = undefined;
        lastSignature = undefined;
        lastPublishedAt = 0;
        announcedAgendaIndex = -1;
        startTicker();
      });

      // The next line said after the meeting ended belongs to a new meeting: nothing carries over.
      // `savedCleared` is set by the host's New meeting, which has already waited for the clear itself.
      async function resetMeeting({ savedCleared = false }: { savedCleared?: boolean } = {}): Promise<void> {
        if (resetMeetingSession === undefined) {
          console.error('kaki host: no meeting session is available to reset the meeting');
          return;
        }
        // The context routes this through the one admission queue: a reset can never land between a
        // join's roster check and the room token or seat claim it was granted against.
        await resetMeetingSession({ savedAlreadyCleared: savedCleared });
        console.log('kaki host: a new meeting starts; the old record, questions and tasks are cleared');
      }

      /** Tell the room when the meeting has moved on to a new agenda item. */
      function announceAgendaItem(): void {
        const currentAgendaIndex = clock.snapshot().agendaIndex;
        if (currentAgendaIndex > 0 && currentAgendaIndex !== announcedAgendaIndex) {
          announcedAgendaIndex = currentAgendaIndex;
          const item = activeScenario().agenda[currentAgendaIndex];
          if (item) {
            hub.publish({
              type: 'HOST_SPEECH_TRIGGERED',
              audience: { kind: 'screen' },
              payload: { kind: 'OPENING', text: `Next up: ${cleanSpokenTopic(item.title)}.` },
            });
          }
        }
      }

      // Lines that arrive after the meeting ended each wait for the one reset to finish before they
      // join the new meeting. Chaining keeps their order and stops a second line resetting it again.
      let nextMeetingQueue: Promise<void> = Promise.resolve();
      function speakIntoNextMeeting(chunk: Parameters<typeof notetaker.addChunk>[0]): void {
        nextMeetingQueue = nextMeetingQueue
          .then(async () => {
            if (clock.snapshot().ended) await resetMeeting();
            if (!clock.snapshot().started) beginMeeting();
            notetaker.addChunk(chunk);
            if (replay === undefined && hasTaskAssignment(chunk.text)) {
              setTimeout(() => void runNotetaker(), 250).unref();
            }
            announceAgendaItem();
          })
          .catch((error: unknown) => console.error('kaki host: could not start the next meeting', error));
      }

      const unsubscribe = hub.subscribe((event) => {
        if (event.type === 'MEETING_STARTED') {
          clock.setAgenda(activeScenario().agenda);
          beginMeeting(event.payload.startedAt);
          return;
        }
        if (event.type !== 'TRANSCRIPT_CHUNK') return;

        const afterEnding = clock.snapshot().ended;
        if (afterEnding) {
          speakIntoNextMeeting(event.payload);
          return;
        }
        if (!clock.snapshot().started) {
          // The scripted replay has no browser pressing Start; any other live speech waits for the
          // server's Start.
          if (replay === undefined) return;
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
      async function endMeeting({ silent = false }: { silent?: boolean } = {}): Promise<void> {
        // Ending is a lifecycle change too: it waits for any join that is still signing or claiming.
        const ended = await runSerialized(() => {
          const now = clock.snapshot();
          if (!now.started || now.ended) return false;
          clock.end();
          // A replay can run a clock without a server Start; only a running session has a phase to end.
          if (session !== undefined && session.phase() === 'running') session.end();
          stopTicker();
          return true;
        });
        if (!ended) return;
        console.log('kaki host: the meeting is over');
        if (silent) {
          await resetMeeting();
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
        if (command.type === 'SET_PAUSED') {
          // The agenda clock is the one owner of the meeting's paused flag. The shared screen
          // (the host) and a person seated in this meeting drive it; nobody else may freeze the room.
          const senderRole = audienceRole(sender);
          if (senderRole === undefined) {
            if (sender.kind !== 'screen') {
              throw new CommandError('Only a person seated in this meeting can pause it');
            }
          } else {
            const seated = session?.holders().some(
              (holder) => holder.seat.trim().toLowerCase() === senderRole.trim().toLowerCase(),
            ) === true;
            if (!seated) throw new CommandError('Only a person seated in this meeting can pause it');
          }
          if (command.paused) clock.pause('person');
          else clock.resume();
          // The clock's pause listener republishes the record; save the kind with the meeting.
          publishRecord();
          persistence?.scheduleSave();
          return;
        }
        if (sender.kind !== 'screen') throw new CommandError('Only the shared screen can do that');
        if (command.type === 'NEW_MEETING') {
          // Only say the meeting started once the old one is really gone; otherwise the host must know.
          if (persistence !== undefined) {
            resetting = true;
            try {
              await persistence.clearSaved();
            } catch {
              resetting = false;
              throw new CommandError("Couldn't clear the saved meeting — try again");
            }
            // The hub commits this only if the sending socket still holds authority after the await.
            return {
              async commit() {
                try { await resetMeeting({ savedCleared: true }); }
                finally {
                  // The clear removed the old meeting. A draft the reset kept (an unconsumed edit) is
                  // part of the new lobby, so save it now that the pre-reset snapshot is allowed again.
                  resetting = false;
                  if (session?.draftTouched() === true) persistence.scheduleSave();
                }
              },
              cancel() {
                resetting = false;
                // The clear already completed; restore this meeting's snapshot if the reset was revoked.
                persistence.scheduleSave();
              },
            };
          }
          // No saved meeting to clear, but the reset still waits for the admission queue and still
          // happens only while the sending socket holds authority.
          return {
            async commit() {
              await resetMeeting({ savedCleared: true });
            },
          };
        }
        if (command.type === 'SET_HOST_MODE') {
          // The server derives host mode from the seat holders in the roster; this report is
          // accepted for older runners but never overrides that value.
          return;
        }
        if (command.type === 'END_MEETING') {
          await endMeeting({ silent: command.silent === true });
          return;
        }
        const now = clock.snapshot();
        if (!now.started || now.ended) throw new CommandError('The meeting is not running');
        if (now.agendaIndex + 1 >= activeScenario().agenda.length) throw new CommandError('That was the last agenda item');
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
        const lines = typeof replay === 'string' ? loadReplay(activeScenario(), replay) : Promise.resolve(replay);
        lines.then(
          (loaded) => {
            if (stopped) return;
            console.log(`kaki host: replaying ${loaded.length} transcript lines at ${speed}x`);
            stopReplay = startReplay({
              lines: loaded,
              hub,
              speed,
              onAgenda: (index) => clock.advanceTo(index),
              onEnd: () => void endMeeting(),
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
        stopResetHook?.();
        stopPauseWatch();
        stopTicker();
        clearInterval(notetakerTimer);
      };
    },
  };
}

export { openingLine } from './opening';
