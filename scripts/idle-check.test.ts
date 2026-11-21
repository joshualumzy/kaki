import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repo = process.cwd();
const script = join(repo, 'deploy', 'idle', 'kaki-idle-check.sh');
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(repo, 'deploy', 'idle', '.test-'));
  tempDirs.push(dir);
  return dir;
}

/** A fake /proc/uptime whose first field is `seconds`. */
function uptimeFile(seconds: number): string {
  const path = join(tempDir(), 'uptime');
  writeFileSync(path, `${seconds}.00 0.00\n`);
  return path;
}

function serveIdle(body: unknown, status = 200): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected the fake idle server to listen on a TCP port');
      }
      resolve(`http://127.0.0.1:${address.port}/idle`);
    });
  });
}

function idleState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    peopleConnected: 0,
    lastActivityAt: new Date().toISOString(),
    idleSeconds: 3_600,
    ...overrides,
  };
}

interface RunResult {
  status: number;
  output: string;
}

async function run(env: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, KAKI_IDLE_DRY_RUN: '1', ...env },
    });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      status: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('VM idle checker', () => {
  it('would deallocate when nobody is connected and the idle window has passed', async () => {
    const url = await serveIdle(idleState());
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/decision=deallocate/);
    expect(result.output).toMatch(/dry run: would POST/);
    expect(result.output).toMatch(/peopleConnected=0/);
    expect(result.output).toMatch(/idleSeconds=3600/);
    expect(result.output).toMatch(/uptimeSeconds=1200/);
  });

  it('stays on while somebody is connected', async () => {
    const url = await serveIdle(idleState({ peopleConnected: 1, idleSeconds: 9_999 }));
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/decision=stay on: 1 people connected/);
    expect(result.output).not.toMatch(/decision=deallocate/);
  });

  it('stays on while the idle window is still open', async () => {
    const url = await serveIdle(idleState({ idleSeconds: 120 }));
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/decision=stay on: idle 120s is under 3600s/);
    expect(result.output).not.toMatch(/decision=deallocate/);
  });

  it('stays on just after boot even when the server looks idle', async () => {
    const url = await serveIdle(idleState());
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(60) });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/decision=stay on: the VM booted 60s ago/);
    expect(result.output).not.toMatch(/decision=deallocate/);
  });

  it('honours KAKI_IDLE_MINUTES', async () => {
    const url = await serveIdle(idleState({ idleSeconds: 120 }));
    const result = await run({
      KAKI_IDLE_URL: url,
      KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200),
      KAKI_IDLE_MINUTES: '1',
    });

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/decision=deallocate/);
    expect(result.output).toMatch(/thresholdSeconds=60/);
  });

  it('stays on and exits non-zero when the server is down', async () => {
    const result = await run({ KAKI_IDLE_URL: 'http://127.0.0.1:1/idle', KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('idle check could not read server state; staying on');
  });

  it('stays on and exits non-zero when the response is not readable JSON', async () => {
    const url = await serveIdle('not json');
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('idle check could not read server state; staying on');
  });

  it('stays on and exits non-zero when the server answers with an error', async () => {
    const url = await serveIdle({ error: 'boom' }, 500);
    const result = await run({ KAKI_IDLE_URL: url, KAKI_IDLE_UPTIME_FILE: uptimeFile(1_200) });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('idle check could not read server state; staying on');
  });
});
