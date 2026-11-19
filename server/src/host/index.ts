import type { Scenario } from '@kaki/shared';
import { notetakerLlmFromEnv } from '../llm';
import { scenarioFolder } from '../loadScenario';
import type { KakiModule } from '../modules';
import { createAgendaClock } from './clock';
import { createMeetingModule } from './meeting';

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

/** The Host team's modules, and the meeting clock they run on so other server code can read meeting time. */
export interface HostModules {
  modules: KakiModule[];
  /** Seconds since the meeting started, or undefined before the first transcript line. */
  meetingElapsedSeconds: () => number | undefined;
  /** The agenda item the meeting is on, or undefined before it starts. */
  meetingAgendaIndex: () => number | undefined;
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
  };
}
