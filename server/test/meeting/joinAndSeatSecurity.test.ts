import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { defaultMeetingSetup, parseScenario, type Scenario } from '@kaki/shared';
import { assertSafeBind, clientAddress } from '../../src/http/access';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth, secureCookiesFromEnv, type AuthOptions } from '../../src/auth/module';
import { hashPassword, hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingCodeSource, type MeetingCodeSource } from '../../src/meeting/meetingCode';
import { projectScenario } from '../../src/meeting/scenarioProjection';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { testScenario } from '../fixtures/scenario';
import {
  createPracticeTestApp,
  createTestApp,
  meetingPath,
  openRealMeeting,
  portOf,
  settle,
  type TestMeeting,
} from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';

const transcriptEvent = {
  type: 'TRANSCRIPT_CHUNK',
  audience: { kind: 'all' },
  payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() },
};

type ConnectResult = { ok: true; ws: WebSocket } | { ok: false; status: number };

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  if (pair === undefined || pair === '') throw new Error('The response did not set a session cookie');
  return pair;
}

async function signInGoogle(store: AuthStore, name: string): Promise<SignedIn> {
  const email = `${randomUUID()}@example.com`;
  const user = await store.createGoogleUser({ googleSub: randomUUID(), name, email });
  const token = randomUUID();
  await store.createSession({
    tokenHash: hashToken(token),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: name,
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { user, cookie: `kaki_session=${token}` };
}

function connect(
  port: number,
  meetingId: string,
  query: string,
  options: { cookie?: string; authorization?: string } = {},
): Promise<ConnectResult> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meetingId)}&${query}`,
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
    attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', displayName: 'Cy (Manager)' }],
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

const aiScenario: Scenario = {
  ...testScenario,
  roles: [...testScenario.roles, { id: 'manager', label: 'Manager' }],
  attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', displayName: 'Cy' }],
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
      offeredRoles: () => ['chef', 'cashier'],
      ...(secureCookies === undefined ? {} : { secureCookies }),
      ...(verifyPassword === undefined ? {} : { verifyPassword }),
    });
    const app = track(
      await createApp({
        speechRecognition: 'browser',
        scenario,
        auth,
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

  async function meetingAuthApp(
    options: { serviceToken?: string } = {},
  ): Promise<{ app: KakiApp; store: AuthStore }> {
    const store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    const app = track(
      await createTestApp({
        auth,
        ...(options.serviceToken === undefined ? {} : { serviceToken: options.serviceToken }),
      }),
    );
    return { app, store };
  }

  async function openMeeting(
    app: KakiApp,
    store: AuthStore,
    options: { workspaceId?: string; agenda?: Array<{ title: string; minutes?: number }> } = {},
  ): Promise<{ meeting: TestMeeting; owner: SignedIn }> {
    const owner = await signInGoogle(store, 'Ada');
    const meeting = await openRealMeeting(app, {
      ownerUserId: owner.user.id,
      title: 'Weekly planning',
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.agenda === undefined ? {} : { agenda: options.agenda }),
    });
    expect((await post(app, meetingPath(meeting, '/api/meeting/open'), {}, owner.cookie)).status).toBe(200);
    return { meeting, owner };
  }

  async function joinGuest(
    app: KakiApp,
    meeting: TestMeeting,
    name: string,
  ): Promise<{ cookie: string; seat: string }> {
    const joined = await post(app, meetingPath(meeting, '/join'), { name });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    const seated = await post(app, meetingPath(meeting, '/api/livekit/token'), { participantName: name }, guest);
    expect(seated.status).toBe(200);
    const body = (await seated.json()) as { participantRole: string };
    return { cookie: cookieFrom(seated), seat: body.participantRole };
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
    const { app, store } = await meetingAuthApp({ serviceToken: 'runner-secret' });
    const { meeting, owner } = await openMeeting(app, store, { agenda: [{ title: 'Budget', minutes: 10 }] });
    const guest = await joinGuest(app, meeting, 'Guest');
    const bodies: Array<[string, unknown]> = [
      ['/api/runner/emit', { ...transcriptEvent, payload: { ...transcriptEvent.payload, speaker: 'Guest' } }],
      ['/api/runner/suggest-task', { title: 'Order stock', context: 'Prep', suggestedAssignee: guest.seat }],
      ['/api/runner/meeting-memory', []],
      ['/api/runner/settle-topic', { title: 'Order stock', context: 'Prep', suggestedAssignee: guest.seat, agendaItemTitle: 'Budget' }],
    ];
    for (const [path, body] of bodies) {
      const asRunner = await fetch(`${base(app)}${meetingPath(meeting, path)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer runner-secret' },
        body: JSON.stringify(body),
      });
      expect(asRunner.status, path).toBe(200);

      expect((await post(app, meetingPath(meeting, path), body)).status).toBe(401);
      expect((await post(app, meetingPath(meeting, path), body, guest.cookie)).status).toBe(401);
      expect((await post(app, meetingPath(meeting, path), body, owner.cookie)).status).toBe(401);
    }
  });

  it('drops a host seat grant when the meeting rotates but keeps host powers', async () => {
    const { app, store } = await meetingAuthApp();
    const { meeting, owner } = await openMeeting(app, store);
    const seated = await post(
      app,
      meetingPath(meeting, '/api/livekit/token'),
      { participantName: 'Ada' },
      owner.cookie,
    );
    expect(seated.status).toBe(200);
    const seatHost = cookieFrom(seated);
    const seat = ((await seated.json()) as { participantRole: string }).participantRole;
    const port = portOf(app);

    const oldSeat = await connect(port, meeting.id, `role=${encodeURIComponent(seat)}`, { cookie: seatHost });
    expect(oldSeat.ok).toBe(true);
    if (!oldSeat.ok) return;
    const oldSeatClosed = waitForClose(oldSeat.ws);

    meeting.session.reset();
    await settle();
    expect(await oldSeatClosed).toBe(4001);

    expect((await get(app, meetingPath(meeting, '/api/meeting-code'), seatHost)).status).toBe(200);
    const body = (await (await get(app, meetingPath(meeting, '/api/scenario'), seatHost)).json()) as Scenario;
    expect(body.roles.every((role) => role.card === undefined)).toBe(true);
    expect(body.agenda.every((item) => item.seatFacts === undefined)).toBe(true);

    // The same person still owns their workspace after their meeting seat claim is gone.
    expect((await get(app, '/api/workspaces', seatHost)).status).toBe(200);

    const oldSeatFeed = await connect(port, meeting.id, `role=${encodeURIComponent(seat)}`, {
      cookie: seatHost,
    });
    expect(oldSeatFeed.ok).toBe(false);
    if (!oldSeatFeed.ok) expect(oldSeatFeed.status).toBe(401);
  });

  it('closes a runner socket once its role is no longer played by an AI', async () => {
    const scenario = { ...aiScenario, npcs: [...(aiScenario.npcs ?? [])] };
    const app = await createPracticeTestApp({ scenario, serviceToken: 'runner-secret' });
    apps.push(app);
    const port = portOf(app);
    const runner = await connect(port, app.meetingId, 'role=manager', {
      authorization: 'Bearer runner-secret',
    });
    expect(runner.ok).toBe(true);
    if (!runner.ok) return;
    const closed = waitForClose(runner.ws);

    runner.ws.send(JSON.stringify({ type: 'DECLINE_TASK', taskId: 'first' }));
    await settle();
    // The active scenario is a value now: swap in one whose cast no longer voices the manager.
    app.session.beginStart({ ...scenario, npcs: [] }, defaultMeetingSetup(scenario));
    app.session.commitStart();

    runner.ws.send(JSON.stringify({ type: 'DECLINE_TASK', taskId: 'second' }));
    expect(await closed).toBe(4008);
  });

  it('refuses auth-on startup without an https public URL on a public bind', async () => {
    const makeAuth = () =>
      createAuth({ store: createMemoryAuthStore(), offeredRoles: () => ['chef', 'cashier'] });
    const auth = makeAuth();
    await expect(createApp({ speechRecognition: 'browser', scenario: testScenario, host: '0.0.0.0', auth})).rejects.toThrow(
      /KAKI_PUBLIC_URL/,
    );
    await auth.close();

    vi.stubEnv('KAKI_PUBLIC_URL', 'http://kaki.example');
    const httpAuth = makeAuth();
    await expect(
      createApp({ speechRecognition: 'browser', scenario: testScenario, host: '0.0.0.0', auth: httpAuth}),
    ).rejects.toThrow(/KAKI_PUBLIC_URL/);
    await httpAuth.close();

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    const allowedAuth = makeAuth();
    const allowed = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      host: '0.0.0.0',
      auth: allowedAuth,
    });
    await allowed.close();

    vi.unstubAllEnvs();
    vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example');
    const httpsAuth = makeAuth();
    const https = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      host: '0.0.0.0',
      auth: httpsAuth,
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
    const { app, store } = await meetingAuthApp();
    const { meeting, owner } = await openMeeting(app, store, { workspaceId: SAMPLE_WORKSPACE_ID });

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
    const response = await get(app, meetingPath(meeting, `/api/mattermost/open?url=${target}`), owner.cookie);
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
    const app = track(await createTestApp());
    const meeting = await openRealMeeting(app, { workspaceId: SAMPLE_WORKSPACE_ID });

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
      const response = await get(app, meetingPath(meeting, `/api/mattermost/open?url=${target}`));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://mm.public.example/kopitiam/channels/town-square');
    }

    const outside = encodeURIComponent('ftp://evil.example/kopitiam/channels/town-square');
    expect((await get(app, meetingPath(meeting, `/api/mattermost/open?url=${outside}`))).status).toBe(400);
  });

  it('runs a dummy password verification for an unknown email', async () => {
    const verifyPassword = vi.fn(async () => false);
    const { app } = await authApp({ withHost: false, verifyPassword });
    const response = await post(app, '/api/auth/login', { email: 'nobody@example.com', password: 'a-guess' });
    expect(response.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
