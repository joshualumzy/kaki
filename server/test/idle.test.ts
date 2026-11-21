import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp, type KakiApp } from '../src/app';
import { createIdleTracker, type IdleSnapshot } from '../src/core/idle';
import { accessProblem, type Route } from '../src/http/access';
import { createTestApp, portOf, settle } from './helpers';
import { testScenario } from './fixtures/scenario';

const TOKEN = 'runner-secret';
const START = Date.UTC(2026, 0, 1, 9, 0, 0);

type IdleState = IdleSnapshot;

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function openSocket(url: string, authorization?: string): Promise<WebSocket> {
  const socket = new WebSocket(
    url,
    authorization === undefined ? undefined : { headers: { authorization: `Bearer ${authorization}` } },
  );
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function readIdle(port: number): Promise<IdleState> {
  const response = await fetch(`http://127.0.0.1:${port}/idle`);
  expect(response.status).toBe(200);
  return (await response.json()) as IdleState;
}

async function waitForIdle(
  port: number,
  check: (state: IdleState) => boolean,
  label: string,
): Promise<IdleState> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const state = await readIdle(port);
    if (check(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
    }
    await settle(20);
  }
}

describe('idle tracker', () => {
  it('measures idle and action seconds against the injected clock and resets each separately', () => {
    let now = 1_000;
    const idle = createIdleTracker(() => now);

    expect(idle.snapshot()).toEqual({
      peopleConnected: 0,
      lastActivityAt: isoAt(1_000),
      idleSeconds: 0,
      lastActionAt: isoAt(1_000),
      actionIdleSeconds: 0,
    });

    now += 12_900;
    expect(idle.snapshot().idleSeconds).toBe(12);
    expect(idle.snapshot().actionIdleSeconds).toBe(12);

    idle.recordActivity();
    expect(idle.snapshot().idleSeconds).toBe(0);
    expect(idle.snapshot().actionIdleSeconds).toBe(12);

    now += 500;
    expect(idle.snapshot().idleSeconds).toBe(0);

    idle.recordAction();
    expect(idle.snapshot().actionIdleSeconds).toBe(0);
  });

  it('counts people up and down without dropping below zero', () => {
    const idle = createIdleTracker(() => 0);

    idle.personConnected();
    idle.personConnected();
    expect(idle.snapshot().peopleConnected).toBe(2);

    idle.personDisconnected();
    expect(idle.snapshot().peopleConnected).toBe(1);

    idle.personDisconnected();
    idle.personDisconnected();
    expect(idle.snapshot().peopleConnected).toBe(0);
  });
});

describe('GET /idle', () => {
  let app: KakiApp | undefined;
  let now: number;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  async function start(options: Parameters<typeof createTestApp>[0] = {}): Promise<number> {
    now = START;
    app = await createTestApp({ idleClock: () => now, serviceToken: TOKEN, ...options });
    return portOf(app);
  }

  it('starts idle at process start and reports the snapshot shape', async () => {
    const port = await start();

    expect(await readIdle(port)).toEqual({
      peopleConnected: 0,
      lastActivityAt: isoAt(START),
      idleSeconds: 0,
      lastActionAt: isoAt(START),
      actionIdleSeconds: 0,
    });
  });

  it('does not count /health or the idle request itself as activity', async () => {
    const port = await start();

    now += 30_000;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    now += 10_000;

    const state = await readIdle(port);
    expect(state.idleSeconds).toBe(40);
    expect(state.actionIdleSeconds).toBe(40);
  });

  it('counts a person GET poll as activity but not as an action', async () => {
    const port = await start();

    now += 100_000;
    expect((await fetch(`http://127.0.0.1:${port}/api/scenario`)).status).toBe(200);
    now += 7_000;

    const state = await readIdle(port);
    expect(state.idleSeconds).toBe(7);
    expect(state.actionIdleSeconds).toBe(107);
  });

  it('counts a person state-changing request as an action', async () => {
    const port = await start();

    now += 100_000;
    const response = await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' });
    expect(response.ok).toBe(false);
    now += 7_000;

    const state = await readIdle(port);
    expect(state.idleSeconds).toBe(7);
    expect(state.actionIdleSeconds).toBe(7);
  });

  it("does not count the runner's HTTP traffic as activity", async () => {
    const port = await start();

    now += 100_000;
    const runner = await fetch(`http://127.0.0.1:${port}/api/runner/meeting-state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(runner.status).toBe(200);
    now += 10_000;

    const state = await readIdle(port);
    expect(state.idleSeconds).toBe(110);
    expect(state.actionIdleSeconds).toBe(110);
  });

  it('counts the runner-reported human line as a person action, not as activity', async () => {
    const port = await start();

    now += 100_000;
    const line = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        seat: 'chef',
        text: 'The prep list is ready',
        source: 'speech',
        clientLineId: 'line-1',
        meetingId: 'm1',
        participantIdentity: 'Ada',
      }),
    });
    // The meeting is not running, so the write is refused; the person still spoke.
    expect(line.status).toBe(409);
    now += 5_000;

    const state = await readIdle(port);
    expect(state.idleSeconds).toBe(105);
    expect(state.actionIdleSeconds).toBe(5);
  });

  it('counts people up and down, and a person frame as activity', async () => {
    const port = await start();
    const person = await openSocket(`ws://127.0.0.1:${port}/ws?audience=screen`);

    try {
      expect((await readIdle(port)).peopleConnected).toBe(1);

      now += 100_000;
      person.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
      await settle(50);
      now += 5_000;

      const state = await readIdle(port);
      expect(state.idleSeconds).toBe(5);
      expect(state.actionIdleSeconds).toBe(5);
    } finally {
      await closeSocket(person);
    }

    expect((await waitForIdle(port, (state) => state.peopleConnected === 0, 'people to disconnect'))
      .peopleConnected).toBe(0);
  });

  it('does not count the runner sockets or their frames as people or activity', async () => {
    now = START;
    const withNpc = {
      ...testScenario,
      npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [] }],
    };
    app = await createApp({
      scenario: withNpc,
      speechRecognition: 'browser',
      serviceToken: TOKEN,
      idleClock: () => now,
    });
    const port = portOf(app);

    const service = await openSocket(`ws://127.0.0.1:${port}/ws?audience=service`, TOKEN);
    const role = await openSocket(`ws://127.0.0.1:${port}/ws?role=chef`, TOKEN);

    try {
      expect((await readIdle(port)).peopleConnected).toBe(0);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      now += 100_000;
      service.send(JSON.stringify({ kind: 'ready', requestId: 'r1', attempt: 'r1', meetingId: 'm1' }));
      role.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
      await settle(50);
      warn.mockRestore();
      now += 10_000;

      expect(await readIdle(port)).toMatchObject({
        peopleConnected: 0,
        idleSeconds: 110,
        actionIdleSeconds: 110,
      });
    } finally {
      await closeSocket(service);
      await closeSocket(role);
    }
  });

  it('declares the route loopback-only, outside the proxied prefixes', async () => {
    const port = await start();
    const route = app?.routes.find((candidate) => candidate.path === '/idle');

    expect(route).toMatchObject({ method: 'GET', access: 'loopback' });
    for (const prefix of ['/api', '/ws', '/health', '/rtc']) {
      expect(route?.path.startsWith(prefix)).toBe(false);
    }
    expect((await fetch(`http://127.0.0.1:${port}/idle`)).status).toBe(200);
  });
});

describe('loopback access', () => {
  const route: Route = { method: 'GET', path: '/idle', access: 'loopback' };
  const context = {
    authEnabled: false,
    devRoutes: false,
    serviceTokenConfigured: false,
    proxied: false,
    rawPath: '/idle',
  };

  it('answers a request from this machine', () => {
    expect(accessProblem(route, { kind: 'anonymous' }, { ...context, loopback: true })).toBeUndefined();
  });

  it('answers anything else with 404', () => {
    expect(accessProblem(route, { kind: 'anonymous' }, { ...context, loopback: false })).toEqual({
      status: 404,
      error: 'Not found',
    });
  });

  it('refuses a loopback request the public proxy forwarded', () => {
    expect(
      accessProblem(route, { kind: 'anonymous' }, { ...context, loopback: true, proxied: true }),
    ).toEqual({ status: 404, error: 'Not found' });
  });
});
