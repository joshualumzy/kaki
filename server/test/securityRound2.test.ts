import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { parseScenario, type Scenario } from '@kaki/shared';
import { assertSafeBind, clientAddress } from '../src/access';
import { createApp, type KakiApp } from '../src/app';
import { createAuth, secureCookiesFromEnv, type AuthOptions } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createMeetingCodeSource, type MeetingCodeSource } from '../src/meetingCode';
import { projectScenario } from '../src/scenarioProjection';
import { testScenario } from './fixtures/scenario';
import { portOf, settle, waitFor } from './helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';

type ConnectResult = { ok: true; ws: WebSocket } | { ok: false; status: number };

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  if (pair === undefined || pair === '') throw new Error('The response did not set a session cookie');
  return pair;
}

function connect(
  port: number,
  role: string,
  options: { cookie?: string; authorization?: string } = {},
): Promise<ConnectResult> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`,
    Object.keys(headers).length === 0 ? undefined : { headers },
  );
  return new Promise((resolve) => {
    let settled = false;
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, ws });
    });
    ws.once('unexpected-response', (_request, response) => {
      if (settled) return;
      settled = true;
      response.resume();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 0 });
    });
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

/** A scenario with every kind of private material the projection must withhold. */
function privateScenario(): Scenario {
  return {
    ...testScenario,
    roles: [
      {
        id: 'chef',
        label: 'Chef',
        card: { youAre: 'You run the kitchen.', facts: ['chef card secret'], responsibility: 'You order stock.' },
      },
      {
        id: 'cashier',
        label: 'Cashier',
        card: { youAre: 'You run the till.', facts: ['cashier card secret'], responsibility: 'You count the float.' },
      },
      {
        id: 'manager',
        label: 'Manager',
        card: { youAre: 'You manage the shop.', facts: ['manager card secret'], responsibility: 'You approve the roster.' },
      },
    ],
    attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy (Manager)' }],
    agenda: [
      {
        ...testScenario.agenda[0]!,
        directions: ['hidden direction'],
        seatFacts: { chef: 'chef seat secret', cashier: 'cashier seat secret' },
      },
    ],
    npcs: [
      {
        attendee: 'Cy',
        voice: 'test-voice',
        personality: 'Quiet.',
        agenda: 'Keep the kitchen running.',
        concerns: [],
        hiddenGoal: 'npc hidden goal',
      },
    ],
  };
}

/** A startable, AI-free meeting carrying private cards, for host seat powers. */
function hostSeatScenario(): Scenario {
  return {
    ...testScenario,
    roles: [
      {
        id: 'chef',
        label: 'Chef',
        card: { youAre: 'You run the kitchen.', facts: ['chef card secret'], responsibility: 'You order stock.' },
      },
      {
        id: 'cashier',
        label: 'Cashier',
        card: { youAre: 'You run the till.', facts: ['cashier card secret'], responsibility: 'You count the float.' },
      },
    ],
    agenda: [
      {
        ...testScenario.agenda[0]!,
        directions: ['hidden direction'],
        seatFacts: { chef: 'chef seat secret', cashier: 'cashier seat secret' },
      },
    ],
  };
}

const aiScenario: Scenario = {
  ...testScenario,
  roles: [...testScenario.roles, { id: 'manager', label: 'Manager' }],
  attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy' }],
  npcs: [
    {
      attendee: 'Cy',
      voice: 'test-voice',
      personality: 'Quiet until asked.',
      agenda: 'Keep the kitchen running.',
      concerns: [],
    },
  ],
};

describe('security round 2', () => {
  let apps: KakiApp[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function track(app: KakiApp): KakiApp {
    apps.push(app);
    return app;
  }

  async function authApp({
    scenario = testScenario,
    serviceToken,
    roomRoster,
    code = MEETING_CODE,
    secureCookies,
    withHost = true,
    verifyPassword,
    rejoinGraceMs,
    rejoinPollMs,
    admissionReservationMs,
  }: {
    scenario?: Scenario;
    serviceToken?: string;
    roomRoster?: (roomName: string) => Promise<Array<{ name: string; role?: string }> | undefined>;
    code?: string;
    secureCookies?: boolean;
    withHost?: boolean;
    verifyPassword?: AuthOptions['verifyPassword'];
    rejoinGraceMs?: number;
    rejoinPollMs?: number;
    admissionReservationMs?: number;
  } = {}): Promise<{ app: KakiApp; store: AuthStore; meetingCode: MeetingCodeSource }> {
    const store = createMemoryAuthStore();
    if (withHost) {
      await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    }
    const meetingCode = createMeetingCodeSource(code);
    const auth = createAuth({
      store,
      roles: ['chef', 'cashier'],
      meetingCode,
      ...(secureCookies === undefined ? {} : { secureCookies }),
      ...(verifyPassword === undefined ? {} : { verifyPassword }),
    });
    const app = track(
      await createApp({
        scenario,
        auth,
        meetingCode,
        roomRoster: roomRoster ?? (async () => []),
        ...(serviceToken === undefined ? {} : { serviceToken }),
        ...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
        ...(rejoinPollMs === undefined ? {} : { rejoinPollMs }),
        ...(admissionReservationMs === undefined ? {} : { admissionReservationMs }),
      }),
    );
    return { app, store, meetingCode };
  }

  function base(app: KakiApp): string {
    return `http://127.0.0.1:${portOf(app)}`;
  }

  function post(app: KakiApp, path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base(app)}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  function get(app: KakiApp, path: string, cookie?: string): Promise<Response> {
    return fetch(`${base(app)}${path}`, {
      redirect: 'manual',
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  async function signInAsHost(app: KakiApp): Promise<string> {
    const response = await post(app, '/api/auth/login', { email: HOST_EMAIL, password: HOST_PASSWORD });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function join(app: KakiApp, role: string): Promise<string> {
    const response = await post(app, '/api/join', { code: MEETING_CODE, role });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function meetingState(app: KakiApp): Promise<{ meetingId: string }> {
    return (await (await get(app, '/api/meeting/state')).json()) as { meetingId: string };
  }

  it('projects every audience to a scenario the shared parser accepts', () => {
    const scenario = privateScenario();

    const anonymous = projectScenario(scenario);
    expect(() => parseScenario(anonymous)).not.toThrow();
    expect(anonymous.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual([]);

    const seat = projectScenario(scenario, 'chef');
    expect(() => parseScenario(seat)).not.toThrow();
    expect(seat.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual(['chef card secret']);

    const hostSeat = projectScenario(scenario, 'chef');
    expect(() => parseScenario(hostSeat)).not.toThrow();
  });

  it('lets only the runner token reach the runner routes with auth on', async () => {
    const { app } = await authApp({ serviceToken: 'runner-secret' });
    const host = await signInAsHost(app);
    const seat = await join(app, 'chef');
    const bodies: Array<[string, unknown]> = [
      [
        '/api/runner/emit',
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() },
        },
      ],
      ['/api/runner/suggest-task', { title: 'Order stock', context: 'Prep', suggestedAssignee: 'chef' }],
      ['/api/runner/meeting-memory', [{ kind: 'decision', item: 'Prep', text: 'Order stock' }]],
      [
        '/api/runner/settle-topic',
        { title: 'Order stock', context: 'Prep', suggestedAssignee: 'chef', agendaItemTitle: 'Prep' },
      ],
    ];
    for (const [path, body] of bodies) {
      const asRunner = await fetch(`${base(app)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer runner-secret' },
        body: JSON.stringify(body),
      });
      expect(asRunner.status).toBe(200);

      expect((await post(app, path, body)).status).toBe(401);
      expect((await post(app, path, body, seat)).status).toBe(401);
      expect((await post(app, path, body, host)).status).toBe(401);
    }
  });

  it('refuses a stranger before resetting an empty meeting when auth is on', async () => {
    const { app } = await authApp({ roomRoster: async () => [] });
    const before = await meetingState(app);

    for (const meetingCode of [undefined, 'WRONG1']) {
      const response = await post(app, '/api/livekit/token', {
        participantName: 'Mallory',
        participantRole: 'chef',
        ...(meetingCode === undefined ? {} : { meetingCode }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { needsCode?: boolean; meetingCode?: unknown; token?: unknown };
      expect(body.needsCode).toBe(true);
      expect(body.meetingCode).toBeUndefined();
      expect(body.token).toBeUndefined();
      expect(await meetingState(app)).toEqual(before);
    }
  });

  it('admits a code holder as the first person into a fresh meeting with auth on', async () => {
    const { app, meetingCode } = await authApp({ roomRoster: async () => [] });
    const before = await meetingState(app);
    const codeBefore = meetingCode.value;

    const participant = await post(app, '/api/livekit/token', {
      participantName: 'Ada',
      participantRole: 'chef',
      meetingCode: MEETING_CODE,
    });
    expect(participant.status).toBe(200);
    const body = (await participant.json()) as { meetingCode: string; resumed?: boolean };
    expect(body.meetingCode).toBe(codeBefore);
    expect(body.resumed).toBe(false);
    // The first arrival keeps the generation that phones already joined under.
    expect((await meetingState(app)).meetingId).toBe(before.meetingId);
  });

  it('refuses a code holder once a meeting has run and the grace has passed, then the host starts the next', async () => {
    const { app, meetingCode } = await authApp({
      roomRoster: async () => [],
      rejoinGraceMs: 20,
      rejoinPollMs: 5,
      admissionReservationMs: 20,
    });
    const host = await signInAsHost(app);
    const seated = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef' },
      host,
    );
    expect(seated.status).toBe(200);
    const seatHost = cookieFrom(seated);
    expect((await post(app, '/api/meeting/start', {}, seatHost)).status).toBe(200);
    const codeBefore = meetingCode.value;

    // Everyone has left and the room poll's grace has expired.
    await settle(80);
    const before = await meetingState(app);

    const guest = await post(app, '/api/livekit/token', {
      participantName: 'Mallory',
      participantRole: 'cashier',
      meetingCode: MEETING_CODE,
    });
    expect(guest.status).toBe(409);
    expect(((await guest.json()) as { error: string }).error).toMatch(
      /meeting owner must start the next/i,
    );
    expect(await meetingState(app)).toEqual(before);
    expect(meetingCode.value).toBe(codeBefore);

    const hosted = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef' },
      seatHost,
    );
    expect(hosted.status).toBe(200);
    expect((await meetingState(app)).meetingId).not.toBe(before.meetingId);
  });

  it('leaves rejoin state untouched when it refuses a guest, so a known person still resumes', async () => {
    let people: Array<{ name: string; role?: string }> = [];
    const { app, meetingCode } = await authApp({
      roomRoster: async () => people,
      rejoinGraceMs: 20,
      rejoinPollMs: 60_000,
      admissionReservationMs: 20,
    });
    const host = await signInAsHost(app);
    const hosted = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef' },
      host,
    );
    expect(hosted.status).toBe(200);
    const seatHost = cookieFrom(hosted);

    // Booth joins a room Ada is already in, so both are known to the meeting.
    people = [{ name: 'Ada', role: 'chef' }];
    const known = await post(app, '/api/livekit/token', {
      participantName: 'Booth',
      participantRole: 'cashier',
      meetingCode: MEETING_CODE,
    });
    expect(known.status).toBe(200);
    const knownCookie = cookieFrom(known);
    expect((await post(app, '/api/meeting/start', {}, seatHost)).status).toBe(200);
    const codeBefore = meetingCode.value;
    const before = await meetingState(app);

    // They both left, but no poll saw the empty room yet, so the grace window has not started.
    people = [];
    await settle(80);

    const refused = await post(app, '/api/livekit/token', {
      participantName: 'Mallory',
      participantRole: 'cashier',
      meetingCode: MEETING_CODE,
    });
    expect(refused.status).toBe(409);
    expect(await meetingState(app)).toEqual(before);
    expect(meetingCode.value).toBe(codeBefore);

    // If the refusal had started a grace window, it would have expired by now and Booth would reset.
    await settle(80);
    const back = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Booth', participantRole: 'cashier', meetingCode: MEETING_CODE },
      knownCookie,
    );
    expect(back.status).toBe(200);
    const body = (await back.json()) as { meetingCode: string; resumed?: boolean };
    expect(body.meetingCode).toBe(codeBefore);
    expect(body.resumed).toBe(true);
    expect(await meetingState(app)).toEqual(before);
  });

  it('uses one atomic seat record for participants and the host’s seat', async () => {
    const { app } = await authApp({
      scenario: hostSeatScenario(),
      roomRoster: async () => [{ name: 'Hosty', role: 'cashier' }],
    });
    const host = await signInAsHost(app);
    const hostSeated = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      host,
    );
    expect(hostSeated.status).toBe(200);
    const seatHost = cookieFrom(hostSeated);

    const otherJoin = await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' });
    expect(otherJoin.status).toBe(409);
    const otherToken = await post(app, '/api/livekit/token', {
      participantName: 'Other',
      participantRole: 'chef',
      meetingCode: MEETING_CODE,
    });
    expect(otherToken.status).toBe(409);

    const rejoin = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      seatHost,
    );
    expect(rejoin.status).toBe(200);
  });

  it('lets only one of two simultaneous joins take the same seat', async () => {
    const { app } = await authApp();
    const [first, second] = await Promise.all([
      post(app, '/api/join', { code: MEETING_CODE, role: 'chef' }),
      post(app, '/api/join', { code: MEETING_CODE, role: 'chef' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it('drops a host seat grant when the meeting rotates but keeps host powers', async () => {
    const { app } = await authApp({
      scenario: hostSeatScenario(),
      roomRoster: async () => [{ name: 'Hosty', role: 'cashier' }],
    });
    const host = await signInAsHost(app);
    const seated = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      host,
    );
    expect(seated.status).toBe(200);
    const seatHost = cookieFrom(seated);
    const port = portOf(app);

    const oldSeat = await connect(port, 'chef', { cookie: seatHost });
    expect(oldSeat.ok).toBe(true);
    if (!oldSeat.ok) return;
    const oldSeatClosed = waitForClose(oldSeat.ws);

    app.hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId: randomUUID() } });
    await settle();
    expect(await oldSeatClosed).toBe(4001);

    expect((await get(app, '/api/meeting-code', seatHost)).status).toBe(200);
    const body = (await (await get(app, '/api/scenario', seatHost)).json()) as Scenario;
    expect(body.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual([]);
    expect(body.agenda[0]?.seatFacts).toBeUndefined();

    const oldSeatFeed = await connect(port, 'chef', { cookie: seatHost });
    expect(oldSeatFeed.ok).toBe(false);
    if (!oldSeatFeed.ok) expect(oldSeatFeed.status).toBe(401);
  });

  it('closes sockets authorized by a host session that is swapped for a seat session', async () => {
    const { app } = await authApp({
      scenario: hostSeatScenario(),
      roomRoster: async () => [{ name: 'Hosty', role: 'cashier' }],
    });
    const host = await signInAsHost(app);
    const port = portOf(app);
    const screen = await connect(port, 'screen', { cookie: host });
    const lifecycle = await connect(port, 'lifecycle', { cookie: host });
    expect(screen.ok && lifecycle.ok).toBe(true);
    if (!screen.ok || !lifecycle.ok) return;
    const screenClosed = waitForClose(screen.ws);
    const lifecycleClosed = waitForClose(lifecycle.ws);

    const seated = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      host,
    );
    expect(seated.status).toBe(200);

    await waitFor(
      () => (screenClosed !== undefined && lifecycleClosed !== undefined ? true : undefined),
      'the old host sockets to close',
    );
    expect([await screenClosed, await lifecycleClosed]).toEqual([4001, 4001]);
  });

  it('closes a runner socket once its role is no longer played by an AI', async () => {
    const scenario = { ...aiScenario, npcs: [...(aiScenario.npcs ?? [])] };
    const { app } = await authApp({ scenario, serviceToken: 'runner-secret' });
    const port = portOf(app);
    const runner = await connect(port, 'manager', { authorization: 'Bearer runner-secret' });
    expect(runner.ok).toBe(true);
    if (!runner.ok) return;
    const closed = waitForClose(runner.ws);

    runner.ws.send(JSON.stringify({ type: 'DECLINE_TASK', taskId: 'first' }));
    await settle();
    scenario.npcs = [];

    runner.ws.send(JSON.stringify({ type: 'DECLINE_TASK', taskId: 'second' }));
    expect(await closed).toBe(4008);
  });

  it('refuses auth-on startup without an https public URL on a public bind', async () => {
    const makeAuth = (code: MeetingCodeSource) =>
      createAuth({ store: createMemoryAuthStore(), roles: ['chef', 'cashier'], meetingCode: code });

    const code = createMeetingCodeSource(MEETING_CODE);
    const auth = makeAuth(code);
    await expect(createApp({ scenario: testScenario, host: '0.0.0.0', auth, meetingCode: code })).rejects.toThrow(
      /KAKI_PUBLIC_URL/,
    );
    await auth.close();

    vi.stubEnv('KAKI_PUBLIC_URL', 'http://kaki.example');
    const httpCode = createMeetingCodeSource(MEETING_CODE);
    const httpAuth = makeAuth(httpCode);
    await expect(
      createApp({ scenario: testScenario, host: '0.0.0.0', auth: httpAuth, meetingCode: httpCode }),
    ).rejects.toThrow(/KAKI_PUBLIC_URL/);
    await httpAuth.close();

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    const allowedCode = createMeetingCodeSource(MEETING_CODE);
    const allowedAuth = makeAuth(allowedCode);
    const allowed = await createApp({
      scenario: testScenario,
      host: '0.0.0.0',
      auth: allowedAuth,
      meetingCode: allowedCode,
    });
    await allowed.close();

    vi.unstubAllEnvs();
    vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example');
    const httpsCode = createMeetingCodeSource(MEETING_CODE);
    const httpsAuth = makeAuth(httpsCode);
    const https = await createApp({
      scenario: testScenario,
      host: '0.0.0.0',
      auth: httpsAuth,
      meetingCode: httpsCode,
    });
    await https.close();
  });

  it('considers the public URL in the open-server bind guard', () => {
    vi.stubEnv('KAKI_PUBLIC_URL', 'http://public.example');
    expect(() => assertSafeBind('127.0.0.1', false)).toThrow(/KAKI_ALLOW_OPEN/);
  });

  it('marks the session cookie Secure when the public URL is https', async () => {
    expect(secureCookiesFromEnv({ KAKI_PUBLIC_URL: 'https://kaki.example' })).toBe(true);
    expect(secureCookiesFromEnv({ KAKI_PUBLIC_URL: 'http://kaki.example' })).toBe(false);
    expect(secureCookiesFromEnv({})).toBe(false);

    const { app } = await authApp({ secureCookies: true });
    const login = await post(app, '/api/auth/login', { email: HOST_EMAIL, password: HOST_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('Secure');
  });

  it('keeps Mattermost Secure cookies when the public URL is https', async () => {
    vi.stubEnv('MATTERMOST_URL', 'http://mattermost.test');
    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'https://mm.example');
    vi.stubEnv('MATTERMOST_PASSWORD', 'a-real-password');
    vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example');
    const { app } = await authApp();
    const host = await signInAsHost(app);

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('http://mattermost.test')) {
          return new Response('{}', {
            status: 200,
            headers: { 'set-cookie': 'MMAUTHTOKEN=abc; Path=/; Secure; HttpOnly' },
          });
        }
        return realFetch(input, init);
      }),
    );

    const target = encodeURIComponent('http://localhost:8083/kopitiam/channels/town-square');
    const response = await get(app, `/api/mattermost/open?url=${target}`, host);
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('trusts X-Forwarded-For only from loopback and takes the right-most untrusted address', () => {
    const request = (remoteAddress: string, forwarded: string) =>
      ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress } }) as never;

    vi.stubEnv('KAKI_TRUST_PROXY', '1');
    expect(clientAddress(request('127.0.0.1', '198.51.100.1, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientAddress(request('127.0.0.1', '198.51.100.1, 127.0.0.1'))).toBe('198.51.100.1');
    expect(clientAddress(request('198.51.100.7', '198.51.100.1'))).toBe('198.51.100.7');

    vi.stubEnv('KAKI_TRUST_PROXY', '0');
    expect(clientAddress(request('127.0.0.1', '198.51.100.1'))).toBe('127.0.0.1');
  });

  it('accepts Mattermost links by path and redirects to the configured public base', async () => {
    vi.stubEnv('MATTERMOST_URL', 'http://127.0.0.1:8083');
    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'https://mm.public.example');
    vi.stubEnv('MATTERMOST_PASSWORD', 'a-real-password');
    const app = track(await createApp({ scenario: testScenario }));

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('http://127.0.0.1:8083')) {
          return new Response(JSON.stringify({ id: 'demo-user' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return realFetch(input, init);
      }),
    );

    for (const origin of ['http://localhost:8083', 'http://127.0.0.1:8083', 'https://kaki.public.example:8083']) {
      const target = encodeURIComponent(`${origin}/kopitiam/channels/town-square`);
      const response = await get(app, `/api/mattermost/open?url=${target}`);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://mm.public.example/kopitiam/channels/town-square');
    }

    const outside = encodeURIComponent('ftp://evil.example/kopitiam/channels/town-square');
    expect((await get(app, `/api/mattermost/open?url=${outside}`)).status).toBe(400);
  });

  it('runs a dummy password verification for an unknown email', async () => {
    const verifyPassword = vi.fn(async () => false);
    const { app } = await authApp({ withHost: false, verifyPassword });
    const response = await post(app, '/api/auth/login', { email: 'nobody@example.com', password: 'a-guess' });
    expect(response.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
