import type { NpcProfile, RunnerMeetingSnapshot } from '@kaki/shared';
import { describe, expect, it } from 'vitest';
import { waitForRunnerCast } from '../../src/npc/bootMeeting';
import { testScenario } from '../fixtures/scenario';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const sam: NpcProfile = {
  attendee: 'Sam',
  voice: 'en-HK-SamNeural',
  personality: 'Calm',
  agenda: 'Keep time',
  concerns: [],
  role: 'host',
};

function snapshot(cast: NpcProfile[], version: number): RunnerMeetingSnapshot {
  return runnerSnapshot(testScenario, { cast, version });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runner boot with no AI cast on disk', () => {
  it('waits for the server to publish a cast, then boots with that cast', async () => {
    const none = deferred<RunnerMeetingSnapshot>();
    const withCast = deferred<RunnerMeetingSnapshot>();
    const lines: string[] = [];
    let calls = 0;
    const boot = waitForRunnerCast({
      base: testScenario,
      fetchState: () => (calls++ === 0 ? none.promise : withCast.promise),
      retryMs: 0,
      log: (line) => lines.push(line),
    });

    none.resolve(snapshot([], 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let settled = false;
    void boot.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(lines.some((line) => line.includes('no AI cast'))).toBe(true);

    withCast.resolve(snapshot([sam], 2));
    const result = await boot;
    expect(result.snapshot.cast).toEqual([sam]);
    expect(result.scenario.npcs).toEqual([sam]);
    expect(lines.filter((line) => line.includes('no AI cast'))).toHaveLength(1);
  });
});
