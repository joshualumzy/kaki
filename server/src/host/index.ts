import { notetakerLlmFromEnv } from '../llm';
import { scenarioFolder } from '../loadScenario';
import type { KakiModule } from '../modules';
import { createMeetingModule } from './meeting';

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

const replay = process.env.KAKI_REPLAY === '1';

/** Modules the Host team plugs into the meeting server. */
export const hostModules: KakiModule[] = [
  createMeetingModule({
    llm: notetakerLlmFromEnv(),
    replay: replay ? scenarioFolder() : undefined,
    // A live meeting runs in real time unless KAKI_CLOCK_SPEED shortens the agenda (3 turns a 10 minute item into about 3 minutes).
    speed: replay ? positiveNumber('KAKI_REPLAY_SPEED', 1) : positiveNumber('KAKI_CLOCK_SPEED', 1),
    notetakerIntervalMs: positiveNumber('KAKI_NOTETAKER_INTERVAL_MS', 7_000),
  }),
];
