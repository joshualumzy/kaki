import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { demoRoomName, type Scenario } from '@kaki/shared';
import { ACCESS_LEVELS } from '../src/access';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createRoomToken } from '../src/livekit';
import { createMeetingCodeSource, type MeetingCodeSource } from '../src/meetingCode';
import { testScenario } from './fixtures/scenario';
import { portOf } from './helpers';

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
    attendees: [
      ...testScenario.attendees,
      { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy (Manager)' },
    ],
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

/** A startable, AI-free meeting carrying the same private material, for host seat powers. */
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

describe('one access layer', () => {
  let apps: KakiApp[] = [];
  let store: AuthStore;
  let meetingCode: MeetingCodeSource;
  let auth: ReturnType<typeof createAuth>;

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
  });

  async function authApp({
    scenario = testScenario,
    serviceToken,
    roomRoster,
    code = MEETING_CODE,
  }: {
    scenario?: Scenario;
    serviceToken?: string;
    roomRoster?: (roomName: string) => Promise<Array<{ name: string; role?: string }> | undefined>;
    code?: string;
  } = {}): Promise<KakiApp> {
    store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    meetingCode = createMeetingCodeSource(code);
    auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    const app = await createApp({
      scenario,
      auth,
      meetingCode,
      roomRoster: roomRoster ?? (async () => []),
      ...(serviceToken === undefined ? {} : { serviceToken }),
    });
    apps.push(app);
    return app;
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
    return fetch(`${base(app)}${path}`, cookie === undefined ? undefined : { headers: { cookie } });
  }

  async function join(app: KakiApp, role: string): Promise<string> {
    const response = await post(app, '/api/join', { code: MEETING_CODE, role });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function signInAsHost(app: KakiApp): Promise<string> {
    const response = await post(app, '/api/auth/login', { email: HOST_EMAIL, password: HOST_PASSWORD });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  it('declares an access level for every route and answers unlisted paths with 404', async () => {
    const app = await authApp();

    const levels = new Set<string>(ACCESS_LEVELS);
    expect(app.routes.length).toBeGreaterThan(0);
    for (const route of app.routes) expect(levels.has(route.access)).toBe(true);

    expect((await get(app, '/api/not-a-route')).status).toBe(404);
    expect((await get(app, '/not-a-route')).status).toBe(404);
    expect((await post(app, '/api/scenario', {})).status).toBe(404);
  });

  it('refuses an open server on a non-loopback bind without KAKI_ALLOW_OPEN', async () => {
    await expect(createApp({ scenario: testScenario, host: '0.0.0.0' })).rejects.toThrow(/KAKI_ALLOW_OPEN/);

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    const allowed = await createApp({ scenario: testScenario, host: '0.0.0.0' });
    expect(allowed.server.address()).not.toBeNull();
    await allowed.close();
  });

  it('keeps dev routes off by default and refuses to enable them with sign-in on', async () => {
    const plain = await createApp({ scenario: testScenario });
    try {
      const response = await fetch(`${base(plain)}/dev/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(404);
    } finally {
      await plain.close();
    }

    store = createMemoryAuthStore();
    meetingCode = createMeetingCodeSource(MEETING_CODE);
    auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    await expect(
      createApp({ scenario: testScenario, auth, meetingCode, devRoutes: true }),
    ).rejects.toThrow(/KAKI_DEV_ROUTES/);
  });

  it('pins the LiveKit room so a fresh client room cannot reset a running meeting or learn its code', async () => {
    const pinned = demoRoomName(testScenario);
    const roster = vi.fn(async (roomName: string) =>
      roomName === pinned ? [{ name: 'Ada', role: 'chef' }] : [],
    );
    const app = await authApp({ roomRoster: roster });
    const before = (await (await get(app, '/api/meeting/state')).json()) as { meetingId: string };

    const response = await post(app, '/api/livekit/token', {
      roomName: 'fresh-room',
      participantName: 'Mallory',
      participantRole: 'cashier',
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { needsCode?: boolean; meetingCode?: unknown };
    expect(body.needsCode).toBe(true);
    expect(body.meetingCode).toBeUndefined();
    expect(roster).toHaveBeenCalledWith(pinned);

    const after = (await (await get(app, '/api/meeting/state')).json()) as { meetingId: string };
    expect(after.meetingId).toBe(before.meetingId);
  });

  it('lets only the host start a meeting when sign-in is on', async () => {
    const app = await authApp();

    expect((await post(app, '/api/meeting/start', {})).status).toBe(401);

    // The owner opens the empty room and takes a seat; the old host token is replaced by the seat session.
    const host = await signInAsHost(app);
    const seated = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef' },
      host,
    );
    expect(seated.status).toBe(200);
    const seatHost = cookieFrom(seated);

    const participant = await join(app, 'cashier');
    expect((await post(app, '/api/meeting/start', {}, participant)).status).toBe(403);
    expect((await post(app, '/api/meeting/start', {}, seatHost)).status).toBe(200);
  });

  it('denies Mattermost open to strangers, rejects off-site targets, and never falls back to a password', async () => {
    vi.stubEnv('MATTERMOST_URL', 'http://mattermost.test');
    vi.stubEnv('MATTERMOST_PASSWORD', 'a-real-password');
    const app = await authApp();
    const target = encodeURIComponent('http://mattermost.test/kopitiam/channels/town-square');

    expect((await get(app, `/api/mattermost/open?url=${target}`)).status).toBe(401);

    const participant = await join(app, 'chef');
    const offSite = encodeURIComponent('ftp://evil.example/kopitiam/channels/town-square');
    const denied = await get(app, `/api/mattermost/open?url=${offSite}`, participant);
    expect(denied.status).toBe(400);

    vi.stubEnv('MATTERMOST_PASSWORD', '');
    const open = await createApp({ scenario: testScenario });
    try {
      const missing = await get(open, `/api/mattermost/open?url=${target}`);
      expect(missing.status).toBe(503);
      expect(((await missing.json()) as { error: string }).error).toMatch(/MATTERMOST_PASSWORD/);
    } finally {
      await open.close();
    }
  });

  it('starts the same seat session for a LiveKit join so the joiner sees their own card and facts', async () => {
    // Someone is already in another seat, so this joined person is not the one starting the meeting.
    const scenario = privateScenario();
    scenario.npcs = [];
    const app = await authApp({
      scenario,
      roomRoster: async () => [{ name: 'Ghost', role: 'manager' }],
    });

    const response = await post(app, '/api/livekit/token', {
      participantName: 'Ada',
      participantRole: 'chef',
      meetingCode: MEETING_CODE,
    });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);

    const me = (await (await get(app, '/api/auth/me', cookie)).json()) as { kind: string; role: string };
    expect(me).toEqual({ kind: 'participant', role: 'chef', authEnabled: true });

    const seatBody = (await (await get(app, '/api/scenario', cookie)).json()) as Scenario;
    const chefCard = seatBody.roles.find((role) => role.id === 'chef')?.card;
    expect(chefCard?.facts).toEqual(['chef card secret']);
    expect(seatBody.agenda[0]?.seatFacts).toEqual({ chef: 'chef seat secret' });
    expect(seatBody.roles.find((role) => role.id === 'cashier')?.card?.facts).toEqual([]);
    expect(seatBody.agenda[0]?.seatFacts?.cashier).toBeUndefined();
    expect(seatBody.agenda[0]?.directions).toBeUndefined();
  });

  it('keeps a playable seat card public but never its facts, and hides AI-only cards', async () => {
    const app = await authApp({ scenario: privateScenario() });

    const publicBody = (await (await get(app, '/api/scenario')).json()) as Scenario;
    const chefCard = publicBody.roles.find((role) => role.id === 'chef')?.card;
    const cashierCard = publicBody.roles.find((role) => role.id === 'cashier')?.card;
    expect(chefCard).toMatchObject({ youAre: 'You run the kitchen.', responsibility: 'You order stock.' });
    expect(cashierCard).toMatchObject({ youAre: 'You run the till.', responsibility: 'You count the float.' });
    expect(chefCard?.facts).toEqual([]);
    expect(cashierCard?.facts).toEqual([]);
    expect(publicBody.roles.find((role) => role.id === 'manager')?.card).toBeUndefined();
    expect(publicBody.agenda[0]?.seatFacts).toBeUndefined();
    expect(publicBody.agenda[0]?.directions).toBeUndefined();
    expect(publicBody.npcs?.[0]?.hiddenGoal).toBeUndefined();
  });

  it('keeps a signed-in host who takes a seat as host with that seat’s card and powers', async () => {
    const app = await authApp({ scenario: hostSeatScenario() });
    const host = await signInAsHost(app);

    const joined = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      host,
    );
    expect(joined.status).toBe(200);
    const seatHost = cookieFrom(joined);

    // The join replaces the host session rather than leaving the old token usable beside the new one.
    expect((await get(app, '/api/auth/me', host)).status).toBe(401);

    const me = await get(app, '/api/auth/me', seatHost);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: 'host', authEnabled: true });

    const body = (await (await get(app, '/api/scenario', seatHost)).json()) as Scenario;
    expect(body.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual(['chef card secret']);
    expect(body.agenda[0]?.seatFacts).toEqual({ chef: 'chef seat secret' });
    expect(body.roles.find((role) => role.id === 'cashier')?.card?.facts).toEqual([]);
    expect(body.agenda[0]?.seatFacts?.cashier).toBeUndefined();
    expect(body.agenda[0]?.directions).toBeUndefined();

    // A host session carrying a seat still carries every host power.
    expect((await get(app, '/api/meeting-code', seatHost)).status).toBe(200);
    expect((await post(app, '/api/meeting/start', {}, seatHost)).status).toBe(200);

    // The host can follow their seat's feed as well as the host's screen feed.
    const seatFeed = await connect(portOf(app), 'chef', { cookie: seatHost });
    const screenFeed = await connect(portOf(app), 'screen', { cookie: seatHost });
    expect(seatFeed.ok && screenFeed.ok).toBe(true);
    if (seatFeed.ok) seatFeed.ws.terminate();
    if (screenFeed.ok) screenFeed.ws.terminate();
  });

  it('gives the host a plain session again when they sign in later', async () => {
    const app = await authApp({ scenario: hostSeatScenario() });
    const host = await signInAsHost(app);
    const joined = await post(
      app,
      '/api/livekit/token',
      { participantName: 'Ada', participantRole: 'chef', meetingCode: MEETING_CODE },
      host,
    );
    expect(joined.status).toBe(200);

    const again = await signInAsHost(app);
    const body = (await (await get(app, '/api/scenario', again)).json()) as Scenario;
    expect(body.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual([]);
    expect(body.agenda[0]?.seatFacts).toBeUndefined();
  });

  it('projects the scenario for each audience and gives the runner the full one only on its service route', async () => {
    const app = await authApp({ scenario: privateScenario(), serviceToken: 'runner-secret' });
    const publicBody = (await (await get(app, '/api/scenario')).json()) as Scenario;
    expect(publicBody.agenda[0]?.directions).toBeUndefined();
    expect(publicBody.agenda[0]?.seatFacts).toBeUndefined();
    expect(publicBody.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual([]);
    expect(publicBody.roles.find((role) => role.id === 'manager')?.card).toBeUndefined();
    expect(publicBody.npcs?.[0]?.hiddenGoal).toBeUndefined();

    const chef = await join(app, 'chef');
    const seatBody = (await (await get(app, '/api/scenario', chef)).json()) as Scenario;
    expect(seatBody.agenda[0]?.seatFacts).toEqual({ chef: 'chef seat secret' });
    expect(seatBody.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual(['chef card secret']);
    expect(seatBody.roles.find((role) => role.id === 'cashier')?.card?.facts).toEqual([]);
    expect(seatBody.roles.find((role) => role.id === 'manager')?.card).toBeUndefined();
    expect(seatBody.agenda[0]?.directions).toBeUndefined();

    const full = await fetch(`${base(app)}/api/scenario/full`, {
      headers: { authorization: 'Bearer runner-secret' },
    });
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as Scenario;
    expect(fullBody.agenda[0]?.seatFacts).toEqual({
      chef: 'chef seat secret',
      cashier: 'cashier seat secret',
    });
    expect(fullBody.agenda[0]?.directions).toEqual(['hidden direction']);
    expect(fullBody.npcs?.[0]?.hiddenGoal).toBe('npc hidden goal');

    // Without the token, the service route is not public.
    expect((await get(app, '/api/scenario/full')).status).toBe(401);
  });

  it('refuses a seat another live participant session already holds', async () => {
    const app = await authApp();
    const chef = await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' });
    expect(chef.status).toBe(200);
    const twice = await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' });
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { error: string }).error).toMatch(/seat is taken/i);

    const cashier = await post(app, '/api/join', { code: MEETING_CODE, role: 'cashier' });
    expect(cashier.status).toBe(200);
  });

  it('accepts the runner token only in the Authorization header and never on a human seat', async () => {
    const app = await authApp({ serviceToken: 'runner-secret' });
    const port = portOf(app);

    const urlToken = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service&token=runner-secret`);
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => {
        ws.terminate();
        resolve(0);
      });
      ws.once('error', () => resolve(0));
    });
    expect(urlToken).toBe(401);

    const header = await connect(port, 'service', { authorization: 'Bearer runner-secret' });
    expect(header.ok).toBe(true);
    if (header.ok) header.ws.terminate();

    const humanSeat = await connect(port, 'chef', { authorization: 'Bearer runner-secret' });
    expect(humanSeat.ok).toBe(false);
    if (!humanSeat.ok) expect(humanSeat.status).toBe(401);
  });

  it('honours X-Forwarded-For for rate limits only when KAKI_TRUST_PROXY=1', async () => {
    vi.stubEnv('KAKI_TRUST_PROXY', '1');
    const app = await authApp();
    const attempt = (forwardedFor: string) =>
      fetch(`${base(app)}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
        body: JSON.stringify({ email: 'limited@example.com', password: 'wrong' }),
      });

    for (let index = 0; index < 5; index += 1) expect((await attempt('198.51.100.1')).status).toBe(401);
    expect((await attempt('198.51.100.1')).status).toBe(429);
    expect((await attempt('198.51.100.2')).status).toBe(401);
  });

  it('refuses the devkey/secret LiveKit fallback when sign-in is on', async () => {
    vi.stubEnv('KAKI_AUTH', '1');
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    await expect(createRoomToken({ roomName: 'r', participantName: 'Ada' })).rejects.toThrow(/LIVEKIT_API_KEY/);

    vi.stubEnv('LIVEKIT_API_KEY', 'real-key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'real-secret');
    await expect(createRoomToken({ roomName: 'r', participantName: 'Ada' })).resolves.toEqual(expect.any(String));
  });
});
