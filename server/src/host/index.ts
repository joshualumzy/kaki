import type { Scenario } from '@kaki/shared';
import { notetakerLlmFromEnv } from '../llm';
import { scenarioFolder } from '../loadScenario';
import type { KakiModule } from '../modules';
import { createAgendaClock, type MeetingPauseKind } from './clock';
import { createMeetingModule } from './meeting';

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

/** The server's one owner of the agenda clock's pause, shared with the app that watches the room. */
export interface MeetingPauseControl {
  /** Whether the clock is paused, or undefined before the meeting starts. */
  paused: () => boolean | undefined;
  /** Why it is paused, when it is. */
  kind: () => MeetingPauseKind | undefined;
  pause: (kind: MeetingPauseKind) => void;
  resume: () => void;
}

/** The Host team's modules, and the meeting clock they run on so other server code can read meeting time. */
interface HostModules {
  modules: KakiModule[];
  /** Seconds since the meeting started, or undefined before the first transcript line. */
  meetingElapsedSeconds: () => number | undefined;
  /** The agenda item the meeting is on, or undefined before it starts. */
  meetingAgendaIndex: () => number | undefined;
  /** Whether the agenda clock is paused, or undefined before the meeting starts. */
  meetingPaused: () => boolean | undefined;
  /** The clock's pause, so the app can pause for an empty room and resume when someone returns. */
  meetingPause: MeetingPauseControl;
}

/** Build the modules the Host team plugs into the meeting server for one scenario. */
export function createHostModules(scenario: Scenario): HostModules {
  const replay = process.env.KAKI_REPLAY === '1';
  // A live meeting runs in real time unless KAKI_CLOCK_SPEED shortens the agenda (3 turns a 10 minute item into about 3 minutes).
  const speed = replay ? positiveNumber('KAKI_REPLAY_SPEED', 1) : positiveNumber('KAKI_CLOCK_SPEED', 1);
  const clock = createAgendaClock({ agenda: scenario.agenda, speed });
  return {
    modules: [
      createMeetingModule({
        llm: notetakerLlmFromEnv(),
        replay: replay ? scenarioFolder() : undefined,
        speed,
        notetakerIntervalMs: positiveNumber('KAKI_NOTETAKER_INTERVAL_MS', 7_000),
        clock,
      }),
    ],
    meetingElapsedSeconds: () => {
      const snapshot = clock.snapshot();
      return snapshot.started ? snapshot.meetingElapsedSeconds : undefined;
    },
    meetingAgendaIndex: () => {
      const snapshot = clock.snapshot();
      return snapshot.started ? snapshot.agendaIndex : undefined;
    },
    meetingPaused: () => {
      const snapshot = clock.snapshot();
      return snapshot.started ? snapshot.paused === true : undefined;
    },
    meetingPause: {
      paused: () => {
        const snapshot = clock.snapshot();
        return snapshot.started ? snapshot.paused === true : undefined;
      },
      kind: () => clock.snapshot().pauseKind,
      pause: (kind) => clock.pause(kind),
      resume: () => clock.resume(),
    },
  };
}
