import type { NpcProfile, RunnerMeetingSnapshot } from '@kaki/shared';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

  it('keeps the process alive while it waits for a cast to appear', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const script = `
      import { waitForRunnerCast } from './server/src/npc/bootMeeting.ts';
      import { testScenario } from './server/test/fixtures/scenario.ts';
      import { runnerSnapshot } from './server/test/fixtures/runnerSnapshot.ts';
      const none = runnerSnapshot(testScenario, { cast: [], version: 1 });
      const cast = runnerSnapshot(testScenario, {
        cast: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host' }],
        version: 2,
      });
      let reads = 0;
      const boot = await waitForRunnerCast({
        base: testScenario,
        fetchState: async () => (reads++ === 0 ? none : cast),
        retryMs: 100,
      });
      console.log('BOOTED ' + boot.snapshot.cast.length);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    clearTimeout(timeout);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    // Without a referenced retry timer the child exits before the second read, so nothing is booted.
    expect(stdout).toContain('BOOTED 1');
  }, 10_000);
});
