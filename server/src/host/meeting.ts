import type { KakiEvent, Scenario } from '@kaki/shared';
import type { LlmClient } from '../llm';
import type { KakiContext, KakiModule } from '../modules';
import { createAgendaClock } from './clock';
import { createNotetaker } from './notetaker';
import { loadReplay, startReplay, type ReplayLine } from './replay';

const TICK_MS = 1_000;
const DEFAULT_NOTETAKER_INTERVAL_MS = 7_000;
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
              }
            : undefined,
      });
      if (llm === undefined) console.warn('kaki host: no LLM configured; the notetaker only tracks talk time');

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

      const ticker = setInterval(() => {
        guarded('the agenda tick', () => {
          clock.tick();
          publishRecord();
        });
      }, TICK_MS);

      const unsubscribe = hub.subscribe((event) => {
        if (event.type !== 'TRANSCRIPT_CHUNK') return;
        
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
        
        const currentAgendaIndex = clock.snapshot().agendaIndex;
        if (currentAgendaIndex > 0 && currentAgendaIndex !== announcedAgendaIndex) {
          announcedAgendaIndex = currentAgendaIndex;
          const item = scenario.agenda[currentAgendaIndex];
          if (item) {
             hub.publish({
               type: 'HOST_SPEECH_TRIGGERED',
               audience: { kind: 'screen' },
               payload: {
                 kind: 'OPENING',
                 text: `Next up: ${item.title}.`,
               },
             });
          }
        }
      });
      const notetakerTimer = setInterval(() => void runNotetaker(), notetakerIntervalMs);

      function endMeeting(): void {
        clock.end();
        clearInterval(ticker);
        console.log('kaki host: the replay has finished; the meeting is over');
        hub.publish({
          type: 'HOST_SPEECH_TRIGGERED',
          audience: { kind: 'screen' },
          payload: {
            kind: 'CLOSING',
            text: `That concludes our meeting. Kaki is syncing the final tasks.`,
          },
        });
        // One last pass so the final lines still reach the record.
        void runNotetaker();
      }

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
              onEnd: endMeeting,
            });
          },
          (error: unknown) => console.error('kaki host: could not start the replay', error),
        );
      }

      return () => {
        stopped = true;
        stopReplay?.();
        unsubscribe();
        clearInterval(ticker);
        clearInterval(notetakerTimer);
      };
    },
  };
}

/** The host's welcome: the title, the agenda in order, and the first item to start on. */
export function openingLine(scenario: Scenario): string {
  const titles = scenario.agenda.map((item) => item.title);
  const first = scenario.agenda[0];
  const agenda = `${titles.length} items today: ${titles.join(', ')}.`;
  return first === undefined
    ? `Welcome to ${scenario.meetingTitle}.`
    : `Welcome to ${scenario.meetingTitle}. We have ${agenda} Let's start with ${first.title}, ${first.minutes} minutes.`;
}
