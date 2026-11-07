import type { KakiEvent } from '@kaki/shared';
import { CommandError } from '../hub';
import type { LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import { createAgendaClock } from './clock';
import { installAutoDispatch } from './autoDispatch';
import { createNotetaker } from './notetaker';
import { openingLine } from './opening';
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
}

/**
 * The meeting record: agenda clock, notetaker and (optionally) the replay feed.
 * The clock starts on the first transcript line, live or replayed. A replay moves the agenda on
 * its own markers and ends the meeting after its last line; live, the notetaker moves the agenda.
 */
export function createMeetingModule({
  llm,
  replay,
  speed = 1,
  notetakerIntervalMs = DEFAULT_NOTETAKER_INTERVAL_MS,
}: MeetingModuleOptions = {}): KakiModule {
  return {
    name: 'host-meeting',
    start({ hub, tasks, scenario }: KakiContext) {
      const clock = createAgendaClock({ agenda: scenario.agenda, speed });
      const notetaker = createNotetaker({
        scenario,
        tasks,
        llm,
        agendaIndex: () => clock.snapshot().agendaIndex,
        onAgendaIndex:
          replay === undefined
            ? (index) => {
                clock.advanceTo(index);
                publishRecord();
                announceAgendaItem();
              }
            : undefined,
      });
      if (llm === undefined) console.warn('kaki host: no LLM configured; the notetaker only tracks talk time');
      let humanHost = false;
      // On by default: Sam dispatches and the recipient accepts or declines. KAKI_AUTO_DISPATCH=0 leaves it to a person on /screen.
      const stopAutoDispatch =
        process.env.KAKI_AUTO_DISPATCH === '0' ? undefined : installAutoDispatch({ hub, tasks, scenario, hostIsHuman: () => humanHost });

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
            text: `${item.title} is at ${item.minutes} minutes, please wrap up.`,
          },
        });
      });

      let announcedAgendaIndex = -1;

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

      // The next line said after the meeting ended belongs to a new meeting: nothing carries over.
      function resetMeeting(): void {
        clock.reset();
        notetaker.reset();
        tasks.reset();
        hub.clearRetained('record');
        hub.clearRetained('host:opening');
        hub.clearRetained('fact:');
        hub.clearRetained('nudge:');
        lastSignature = undefined;
        lastPublishedAt = 0;
        announcedAgendaIndex = -1;
        startTicker();
        hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: {} });
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
              payload: { kind: 'OPENING', text: `Next up: ${item.title}.` },
            });
          }
        }
      }

      const unsubscribe = hub.subscribe((event) => {
        if (event.type === 'MEETING_RESET') {
          if (clock.snapshot().started || clock.snapshot().ended) {
            clock.reset();
            notetaker.reset();
            tasks.reset();
            hub.clearRetained('record');
            hub.clearRetained('host:opening');
            hub.clearRetained('fact:');
            hub.clearRetained('nudge:');
            lastSignature = undefined;
            lastPublishedAt = 0;
            announcedAgendaIndex = -1;
            startTicker();
          }
          return;
        }
        if (event.type !== 'TRANSCRIPT_CHUNK') return;

        if (clock.snapshot().ended) resetMeeting();
        if (!clock.snapshot().started) {
          // Retained so a screen that opens a moment after the meeting starts still shows the welcome.
          hub.publish(
            {
              type: 'HOST_SPEECH_TRIGGERED',
              audience: { kind: 'screen' },
              payload: {
                kind: 'OPENING',
                text: openingLine(scenario),
              },
            },
            { retainKey: 'host:opening' },
          );
        }

        clock.start();
        notetaker.addChunk(event.payload);

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
            text: `That concludes our meeting. Kaki is syncing the final tasks.`,
          },
        });
        void runNotetaker();
      }

      hub.onCommand((command, sender) => {
        if (
          command.type !== 'END_MEETING' &&
          command.type !== 'NEXT_AGENDA_ITEM' &&
          command.type !== 'SET_HOST_MODE' &&
          command.type !== 'SET_PAUSED'
        ) {
          return;
        }
        if (sender !== 'screen') throw new CommandError('Only the shared screen can do that');
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
      if (replay !== undefined) {
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
