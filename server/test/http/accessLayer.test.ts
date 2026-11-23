import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { defaultMeetingSetup, type Scenario } from '@kaki/shared';
import { ACCESS_LEVELS } from '../../src/http/access';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth, type Auth } from '../../src/auth/module';
import { hashPassword, hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createRoomToken } from '../../src/services/livekit';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { testScenario } from '../fixtures/scenario';
import { meetingPath, openRealMeeting, portOf, type TestMeeting } from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';

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

function openSocket(
  url: string,
  options: { cookie?: string; authorization?: string; headers?: Record<string, string> } = {},
): Promise<ConnectResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  const ws = new WebSocket(url, Object.keys(headers).length === 0 ? undefined : { headers });
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

/** Connect to one real meeting's WebSocket. */
function connectMeeting(
  port: number,
  meeting: { id: string } | string,
  query: string,
  options: { cookie?: string; authorization?: string; headers?: Record<string, string> } = {},
): Promise<ConnectResult> {
  const id = typeof meeting === 'string' ? meeting : meeting.id;
  return openSocket(`ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(id)}&${query}`, options);
}

describe('one access layer', () => {
  let apps: KakiApp[] = [];
  let store: AuthStore;
  let auth: Auth;

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
  });

  async function authApp({
    scenario = testScenario,
    serviceToken,
    roomRoster,
  }: {
    scenario?: Scenario;
    serviceToken?: string;
    roomRoster?: (roomName: string) => Promise<Array<{ name: string; role?: string }> | undefined>;
  } = {}): Promise<KakiApp> {
    store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    const app = await createApp({
      speechRecognition: 'browser',
      scenario,
      auth,
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

  function put(app: KakiApp, path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base(app)}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  }

  /** A signed-in product user; a real meeting's owner must be an account, not a password host. */
  async function signInGoogle(name: string): Promise<SignedIn> {
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

  /** Create one real meeting owned by a signed-in account, without opening its room yet. */
  async function createMeeting(
    app: KakiApp,
    options: { workspaceId?: string; agenda?: Array<{ title: string; minutes?: number }> } = {},
  ): Promise<{ meeting: TestMeeting; owner: SignedIn }> {
    const owner = await signInGoogle('Ada');
    const meeting = await openRealMeeting(app, {
      ownerUserId: owner.user.id,
      title: 'Weekly planning',
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.agenda === undefined ? {} : { agenda: options.agenda }),
    });
    return { meeting, owner };
  }

  /** Create one real meeting and open its room as its owner. */
  async function openMeeting(
    app: KakiApp,
    options: { workspaceId?: string; agenda?: Array<{ title: string; minutes?: number }> } = {},
  ): Promise<{ meeting: TestMeeting; owner: SignedIn }> {
    const created = await createMeeting(app, options);
    expect((await post(app, meetingPath(created.meeting, '/api/meeting/open'), {}, created.owner.cookie)).status).toBe(200);
    return created;
  }

  /** A guest joins the meeting's link, then takes a plain seat through the token route. */
  async function joinGuest(app: KakiApp, meeting: TestMeeting, name: string): Promise<string> {
    const joined = await post(app, meetingPath(meeting, '/join'), { name });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    const seated = await post(app, meetingPath(meeting, '/api/livekit/token'), { participantName: name }, guest);
    expect(seated.status).toBe(200);
    return cookieFrom(seated);
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
    await expect(createApp({ speechRecognition: 'browser', scenario: testScenario, host: '0.0.0.0' })).rejects.toThrow(/KAKI_ALLOW_OPEN/);

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    const allowed = await createApp({ speechRecognition: 'browser', scenario: testScenario, host: '0.0.0.0' });
    expect(allowed.server.address()).not.toBeNull();
    await allowed.close();
  });

  it('keeps dev routes off by default and refuses to enable them with sign-in on', async () => {
    const plain = await createApp({ speechRecognition: 'browser', scenario: testScenario });
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
    auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    await expect(
      createApp({ speechRecognition: 'browser', scenario: testScenario, auth, devRoutes: true }),
    ).rejects.toThrow(/KAKI_DEV_ROUTES/);
  });

  // Legacy-only: the shared practice room is the one meeting a client can name a room for; a real meeting derives its room from its id.
  it('lets only the host start a meeting when sign-in is on', async () => {
    const app = await authApp();
    const { meeting, owner } = await createMeeting(app);

    expect((await post(app, meetingPath(meeting, '/api/meeting/start'), {})).status).toBe(401);

    // The owner opens the empty room and takes a seat; the old host token is replaced by the seat session.
    expect((await post(app, meetingPath(meeting, '/api/meeting/open'), {}, owner.cookie)).status).toBe(200);
    const seated = await post(
      app,
      meetingPath(meeting, '/api/livekit/token'),
      { participantName: 'Ada' },
      owner.cookie,
    );
    expect(seated.status).toBe(200);
    const seatHost = cookieFrom(seated);

    const participant = await joinGuest(app, meeting, 'Guest');
    expect((await post(app, meetingPath(meeting, '/api/meeting/start'), {}, participant)).status).toBe(403);
    expect((await post(app, meetingPath(meeting, '/api/meeting/start'), {}, seatHost)).status).toBe(200);
  });

  it('denies Mattermost open to strangers, rejects off-site targets, and never falls back to a password', async () => {
    vi.stubEnv('MATTERMOST_URL', 'http://mattermost.test');
    vi.stubEnv('MATTERMOST_PASSWORD', 'a-real-password');
    const app = await authApp();
    const { meeting } = await openMeeting(app, { workspaceId: SAMPLE_WORKSPACE_ID });
    const target = encodeURIComponent('http://mattermost.test/kopitiam/channels/town-square');

    expect((await get(app, meetingPath(meeting, `/api/mattermost/open?url=${target}`))).status).toBe(401);

    const participant = await joinGuest(app, meeting, 'Guest');
    const offSite = encodeURIComponent('ftp://evil.example/kopitiam/channels/town-square');
    const denied = await get(app, meetingPath(meeting, `/api/mattermost/open?url=${offSite}`), participant);
    expect(denied.status).toBe(400);

    vi.stubEnv('MATTERMOST_PASSWORD', '');
    const missing = await get(app, meetingPath(meeting, `/api/mattermost/open?url=${target}`), participant);
    expect(missing.status).toBe(503);
    expect(missing.headers.get('content-type')).toContain('text/html');
    const page = await missing.text();
    expect(page).toMatch(/not configured/);
    expect(page).not.toMatch(/MATTERMOST_PASSWORD|MATTERMOST_URL|KAKI_PUBLIC_URL/);
  });

  it('refuses cross-site writes and WebSocket upgrades, while reads and the OAuth callback still work', async () => {
    const app = await authApp({ serviceToken: 'runner-secret' });
    const port = portOf(app);
    const { meeting, owner } = await openMeeting(app);
    const evil = 'http://evil.example';

    const blocked = await fetch(`${base(app)}${meetingPath(meeting, '/api/meeting/open')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: evil },
      body: '{}',
    });
    expect(blocked.status).toBe(403);

    const sameOrigin = await fetch(`${base(app)}${meetingPath(meeting, '/api/meeting/open')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: base(app) },
      body: '{}',
    });
    expect(sameOrigin.status).toBe(200);

    const sameOriginFetchMetadata = await fetch(`${base(app)}${meetingPath(meeting, '/api/meeting/close')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: owner.cookie,
        'sec-fetch-site': 'same-origin',
        origin: evil,
      },
      body: '{}',
    });
    expect(sameOriginFetchMetadata.status).toBe(200);

    const read = await fetch(`${base(app)}${meetingPath(meeting, '/api/meeting/state')}`, {
      headers: { cookie: owner.cookie, origin: evil },
    });
    expect(read.status).toBe(200);

    const callback = await fetch(`${base(app)}/api/auth/google/callback?code=x&state=y`, {
      headers: { origin: evil, 'sec-fetch-site': 'cross-site' },
    });
    expect(callback.status).not.toBe(403);

    const mattermost = await fetch(
      `${base(app)}${meetingPath(meeting, `/api/mattermost/open?url=${encodeURIComponent('http://mattermost.test/x')}`)}`,
      { headers: { cookie: owner.cookie, origin: evil } },
    );
    expect(mattermost.status).toBe(403);

    const crossSiteSocket = await connectMeeting(port, meeting, 'audience=service', {
      authorization: 'Bearer runner-secret',
      headers: { origin: evil },
    });
    expect(crossSiteSocket).toEqual({ ok: false, status: 403 });
    const sameOriginSocket = await connectMeeting(port, meeting, 'audience=service', {
      authorization: 'Bearer runner-secret',
      headers: { origin: base(app) },
    });
    expect(sameOriginSocket.ok).toBe(true);
    if (sameOriginSocket.ok) sameOriginSocket.ws.terminate();
  });

  // Legacy-only: a phone joins with a code and a role, receiving that role's card and facts.
  it('never exposes an unopened owner draft on the public scenario, only the opened snapshot', async () => {
    const app = await authApp();
    const { meeting, owner } = await createMeeting(app);
    const draftBase = defaultMeetingSetup(testScenario);
    const draft = {
      ...draftBase,
      title: 'Private draft title',
      agenda: [{ id: 'agenda-1', title: 'Private draft topic', minutes: 5, ownerRoleId: 'chef' }],
    };
    expect((await put(app, meetingPath(meeting, '/api/setup'), draft, owner.cookie)).status).toBe(200);

    const publicBefore = (await (await get(app, meetingPath(meeting, '/api/scenario'))).json()) as Scenario;
    expect(publicBefore.meetingTitle).not.toBe('Private draft title');
    expect(publicBefore.agenda.map((item) => item.title)).not.toContain('Private draft topic');
    const ownerBefore = (await (await get(app, meetingPath(meeting, '/api/scenario'), owner.cookie)).json()) as Scenario;
    expect(ownerBefore.meetingTitle).toBe('Private draft title');

    // Opening the room publishes exactly the plan that was opened.
    expect((await post(app, meetingPath(meeting, '/api/meeting/open'), {}, owner.cookie)).status).toBe(200);
    const publicOpened = (await (await get(app, meetingPath(meeting, '/api/scenario'))).json()) as Scenario;
    expect(publicOpened.meetingTitle).toBe('Private draft title');
    expect(publicOpened.agenda.map((item) => item.title)).toContain('Private draft topic');

    // A later edit is the next meeting's draft; it must not change what this room shows.
    const nextDraft = { ...draft, title: 'Next private title', agenda: [{ ...draft.agenda[0]!, title: 'Next private topic' }] };
    expect((await put(app, meetingPath(meeting, '/api/setup'), nextDraft, owner.cookie)).status).toBe(200);
    const publicStillOpened = (await (await get(app, meetingPath(meeting, '/api/scenario'))).json()) as Scenario;
    expect(publicStillOpened.meetingTitle).toBe('Private draft title');
    expect(publicStillOpened.agenda.map((item) => item.title)).not.toContain('Next private topic');
    const ownerAfter = (await (await get(app, meetingPath(meeting, '/api/scenario'), owner.cookie)).json()) as Scenario;
    expect(ownerAfter.meetingTitle).toBe('Next private title');

    const chef = await joinGuest(app, meeting, 'Guest');
    const seatBody = (await (await get(app, meetingPath(meeting, '/api/scenario'), chef)).json()) as Scenario;
    expect(seatBody.meetingTitle).toBe('Private draft title');
    expect(seatBody.agenda.map((item) => item.title)).not.toContain('Next private topic');
  });

  // Legacy-only: the public role picker and its pack role cards belong to the shared demo meeting.
  it('gives the runner the full scenario only on a real meeting’s service route', async () => {
    const app = await authApp({ serviceToken: 'runner-secret' });
    const { meeting, owner } = await openMeeting(app, { agenda: [{ title: 'Budget', minutes: 10 }] });

    const publicBody = (await (await get(app, meetingPath(meeting, '/api/scenario'))).json()) as Scenario;
    expect(publicBody.agenda.map((item) => item.title)).toContain('Budget');

    const guest = await joinGuest(app, meeting, 'Guest');
    expect((await get(app, meetingPath(meeting, '/api/scenario'), guest)).status).toBe(200);

    const full = await fetch(`${base(app)}${meetingPath(meeting, '/api/scenario/full')}`, {
      headers: { authorization: 'Bearer runner-secret' },
    });
    expect(full.status).toBe(200);
    expect(((await full.json()) as Scenario).agenda.map((item) => item.title)).toContain('Budget');

    // Without the token, the service route is not public for anyone, host included.
    expect((await get(app, meetingPath(meeting, '/api/scenario/full'))).status).toBe(401);
    expect((await get(app, meetingPath(meeting, '/api/scenario/full'), owner.cookie)).status).toBe(401);
  });

  // Legacy-only: phone seats are claimed by code and role, so the same role cannot be held twice.
  it('accepts the runner token only in the Authorization header and never on a human seat', async () => {
    const app = await authApp({ serviceToken: 'runner-secret' });
    const port = portOf(app);
    const { meeting } = await openMeeting(app);

    const urlToken = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meeting.id)}&role=service&token=runner-secret`,
      );
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

    const header = await connectMeeting(port, meeting, 'audience=service', {
      authorization: 'Bearer runner-secret',
    });
    expect(header.ok).toBe(true);
    if (header.ok) header.ws.terminate();

    const humanSeat = await connectMeeting(port, meeting, 'role=everyone', {
      authorization: 'Bearer runner-secret',
    });
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
