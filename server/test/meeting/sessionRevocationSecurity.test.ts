import { randomBytes, randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp, type CreateAppOptions, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword, hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingModule } from '../../src/host/meeting';
import type { MeetingPersistence } from '../../src/persist/persistence';
import { testScenario } from '../fixtures/scenario';
import {
  createTestApp,
  meetingPath,
  meetingWsUrl,
  openRealMeeting,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  type TestMeeting,
} from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';

type ConnectResult =
  | { ok: true; ws: WebSocket; closed: Promise<number> }
  | { ok: false; status: number };

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

function tokenFrom(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

function connectWebSocket(url: string, headers: Record<string, string>): Promise<ConnectResult> {
  const ws = new WebSocket(url, Object.keys(headers).length === 0 ? undefined : { headers });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return new Promise((resolve) => {
    let settled = false;
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, ws, closed });
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

function connect(
  port: number,
  meetingId: string,
  query: string,
  options: { cookie?: string; authorization?: string } = {},
): Promise<ConnectResult> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  return connectWebSocket(meetingWsUrl(port, meetingId, query), headers);
}

async function closeWithin(closed: Promise<number>, ms = 500): Promise<number | undefined> {
  return Promise.race([closed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function maskedFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

interface RawSocket {
  send(text: string): void;
  destroy(): void;
}

/** Open a WebSocket by hand so the test can ignore the server's close frame and keep sending. */
async function rawConnect(port: number, meetingId: string, role: string, cookie: string): Promise<RawSocket> {
  const socket = netConnect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    [
      `GET ${meetingWsUrl(port, meetingId, `role=${encodeURIComponent(role)}`).replace(`ws://127.0.0.1:${port}`, '')} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Cookie: ${cookie}`,
      '',
      '',
    ].join('\r\n'),
  );
  await new Promise<void>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const status = received.subarray(0, end).toString('utf8').split('\r\n')[0] ?? '';
      if (status.includes(' 101 ')) resolve();
      else reject(new Error(status));
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  // Keep the socket readable but never acknowledge the close frame, so the server stays in CLOSING.
  socket.on('data', () => undefined);
  return {
    send(text) {
      socket.write(maskedFrame(text));
    },
    destroy() {
      socket.destroy();
    },
  };
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

describe('security round 3', () => {
  let apps: KakiApp[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
  });

  function track(app: KakiApp): KakiApp {
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

  async function meetingAuthApp(
    options: {
      store?: AuthStore;
      auth?: ReturnType<typeof createAuth>;
      serviceToken?: string;
      devRoutes?: boolean;
      meetingModules?: CreateAppOptions['meetingModules'];
      persistenceFor?: CreateAppOptions['persistenceFor'];
    } = {},
  ): Promise<{ app: KakiApp; store: AuthStore }> {
    const store = options.store ?? createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const auth =
      options.auth ?? createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    const app = track(
      await createTestApp({
        auth,
        roomRoster: async () => [],
        ...(options.serviceToken === undefined ? {} : { serviceToken: options.serviceToken }),
        ...(options.devRoutes === undefined ? {} : { devRoutes: options.devRoutes }),
        ...(options.meetingModules === undefined ? {} : { meetingModules: options.meetingModules }),
        ...(options.persistenceFor === undefined ? {} : { persistenceFor: options.persistenceFor }),
      }),
    );
    return { app, store };
  }

  async function openMeeting(
    app: KakiApp,
    store: AuthStore,
  ): Promise<{ meeting: TestMeeting; owner: SignedIn }> {
    const owner = await signInGoogle(store, 'Ada');
    const meeting = await openRealMeeting(app, { ownerUserId: owner.user.id, title: 'Weekly planning' });
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

  it('checks that the seat claim still belongs to the session, not just its role', async () => {
    const store = createMemoryAuthStore();
    const { app } = await meetingAuthApp({ store });
    const { meeting } = await openMeeting(app, store);
    const guest = await joinGuest(app, meeting, 'Guest');
    const tokenHash = hashToken(tokenFrom(guest.cookie));

    // The session still names the role, but its claim has gone (for example, a replacement moved it).
    await store.releaseSeats({ holder: tokenHash });

    const socket = await connect(portOf(app), meeting.id, `role=${encodeURIComponent(guest.seat)}`, {
      cookie: guest.cookie,
    });
    expect(socket.ok).toBe(false);
    if (!socket.ok) expect(socket.status).toBe(401);
  });

  it('replaces a seat session through one store step and leaves everything unchanged when it fails', async () => {
    const baseStore = createMemoryAuthStore();
    let calls = 0;
    const store = {
      ...baseStore,
      async enterSeat(input: Parameters<AuthStore['enterSeat']>[0]) {
        calls += 1;
        if (calls === 2) throw new Error('the store is unavailable');
        return baseStore.enterSeat(input);
      },
    } as AuthStore;
    const { app } = await meetingAuthApp({ store });
    const { meeting } = await openMeeting(app, store);
    const guest = await joinGuest(app, meeting, 'Guest');

    const second = await post(
      app,
      meetingPath(meeting, '/api/livekit/token'),
      { participantName: 'Guest' },
      guest.cookie,
    );
    expect(second.status).toBe(500);

    // The original session and its claim are untouched.
    expect((await get(app, '/api/auth/me', guest.cookie)).status).toBe(200);
    const socket = await connect(portOf(app), meeting.id, `role=${encodeURIComponent(guest.seat)}`, {
      cookie: guest.cookie,
    });
    expect(socket.ok).toBe(true);
    if (socket.ok) socket.ws.terminate();
  });

  it('stops a revoked socket sending commands before its close handshake finishes', async () => {
    const store = createMemoryAuthStore();
    const { app } = await meetingAuthApp({ store });
    const { meeting } = await openMeeting(app, store);
    const guest = await joinGuest(app, meeting, 'Guest');
    const tokenHash = hashToken(tokenFrom(guest.cookie));
    const port = portOf(app);

    const before = meeting.tasks.suggest({
      title: 'Prep the oven',
      context: 'Before service',
      suggestedAssignee: guest.seat,
    });
    meeting.tasks.transition(before.id, 'DISPATCHED', { assignee: guest.seat });
    const after = meeting.tasks.suggest({
      title: 'Count the float',
      context: 'Before service',
      suggestedAssignee: guest.seat,
    });
    meeting.tasks.transition(after.id, 'DISPATCHED', { assignee: guest.seat });

    const raw = await rawConnect(port, meeting.id, guest.seat, guest.cookie);
    try {
      raw.send(JSON.stringify({ type: 'CLAIM_TASK', taskId: before.id, mode: 'MANUAL' }));
      await waitFor(
        () => (meeting.tasks.get(before.id)?.status === 'CLAIMED' ? true : undefined),
        'the raw socket command',
      );

      meeting.hub.endSession?.(tokenHash);
      raw.send(JSON.stringify({ type: 'CLAIM_TASK', taskId: after.id, mode: 'MANUAL' }));
      await settle(150);
      expect(meeting.tasks.get(after.id)?.status).toBe('DISPATCHED');
    } finally {
      raw.destroy();
    }
  });

  it('does not resume dispatch after the sending session is revoked mid-command', async () => {
    const store = createMemoryAuthStore();
    const { app } = await meetingAuthApp({ store });
    const { meeting, owner } = await openMeeting(app, store);
    const tokenHash = hashToken(tokenFrom(owner.cookie));
    const screen = await connect(portOf(app), meeting.id, 'audience=screen', { cookie: owner.cookie });
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutated = false;
    meeting.hub.onCommand(async (command) => {
      if (command.type === 'SET_HOST_MODE') { entered(); await gate; }
    });
    meeting.hub.onCommand((command) => { if (command.type === 'SET_HOST_MODE') mutated = true; });
    screen.ws.send(JSON.stringify({ type: 'SET_HOST_MODE', human: true }));
    await waiting;
    meeting.hub.endSession?.(tokenHash);
    release();
    await settle(20);
    expect(mutated).toBe(false);
    screen.ws.terminate();
  });

  it('does not reset the meeting when the screen is revoked during the saved-state clear', async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let saves = 0;
    const persistence: MeetingPersistence = {
      saved: undefined,
      registerSource() {}, scheduleSave() { saves += 1; },
      async clearSaved() { entered(); await gate; },
      replaceSaved() { saves += 1; },
      async flush() {}, async close() {},
    };
    const store = createMemoryAuthStore();
    const { app } = await meetingAuthApp({
      store,
      meetingModules: realModulesWith([createMeetingModule()]),
      persistenceFor: async () => persistence,
    });
    const { meeting, owner } = await openMeeting(app, store);
    const tokenHash = hashToken(tokenFrom(owner.cookie));
    const screen = await connect(portOf(app), meeting.id, 'audience=screen', { cookie: owner.cookie });
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    const before = (await (await get(app, meetingPath(meeting, '/api/meeting/state'))).json()) as { meetingId: string };
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waiting;
    const savesBeforeRevocation = saves;
    meeting.hub.endSession?.(tokenHash);
    release();
    await settle(20);
    expect((await (await get(app, meetingPath(meeting, '/api/meeting/state'))).json()) as { meetingId: string })
      .toMatchObject({ meetingId: before.meetingId });
    expect(saves).toBeGreaterThan(savesBeforeRevocation);
    screen.ws.terminate();
  });

  it('rejects an upgrade whose session was revoked while it was authorizing', async () => {
    const store = createMemoryAuthStore();
    const baseAuth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    let didAuthorize: (() => void) | undefined;
    const authorized = new Promise<void>((resolve) => {
      didAuthorize = resolve;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = {
      ...baseAuth,
      authorize: async (
        request: Parameters<typeof baseAuth.authorize>[0],
        audience: Parameters<typeof baseAuth.authorize>[1],
        meetingId?: Parameters<typeof baseAuth.authorize>[2],
        options?: Parameters<typeof baseAuth.authorize>[3],
      ) => {
        const decision = await baseAuth.authorize(request, audience, meetingId, options);
        didAuthorize?.();
        await released;
        return decision;
      },
    } as ReturnType<typeof createAuth>;
    const { app } = await meetingAuthApp({ store, auth });
    const { meeting } = await openMeeting(app, store);
    const guest = await joinGuest(app, meeting, 'Guest');
    const tokenHash = hashToken(tokenFrom(guest.cookie));

    const pending = connect(portOf(app), meeting.id, `role=${encodeURIComponent(guest.seat)}`, {
      cookie: guest.cookie,
    });
    await authorized;
    meeting.hub.endSession?.(tokenHash);
    release?.();

    const opened = await pending;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The server opens and then closes with 4001; wait for that close before tearing down our end, or our own
    // terminate (1006) can win the race under load.
    const code = await closeWithin(opened.closed, 5_000);
    opened.ws.terminate();
    expect(code).toBe(4001);
  });

  it('requires the service token on runner routes and sockets even with sign-in off', async () => {
    const { app } = await meetingAuthApp({ serviceToken: 'runner-secret' });
    const meeting = await openRealMeeting(app);
    expect((await post(app, meetingPath(meeting, '/api/runner/meeting-memory'), [])).status).toBe(401);
    const runner = await fetch(`${base(app)}${meetingPath(meeting, '/api/runner/meeting-memory')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer runner-secret' },
      body: JSON.stringify([]),
    });
    expect(runner.status).toBe(200);

    const port = portOf(app);
    expect((await connect(port, meeting.id, 'audience=service')).ok).toBe(false);
    const service = await connect(port, meeting.id, 'audience=service', {
      authorization: 'Bearer runner-secret',
    });
    expect(service.ok).toBe(true);
    if (service.ok) service.ws.terminate();
  });

  it('allows a tokenless runner only from the direct loopback peer', async () => {
    const local = track(await createTestApp({ roomRoster: async () => [] }));
    const localMeeting = await openRealMeeting(local);
    expect((await post(local, meetingPath(localMeeting, '/api/runner/meeting-memory'), [])).status).toBe(200);
    const localSocket = await connect(portOf(local), localMeeting.id, 'audience=service');
    expect(localSocket.ok).toBe(true);
    if (localSocket.ok) localSocket.ws.terminate();

    const remote = track(await createTestApp({ devRoutes: true, roomRoster: async () => [] }));
    const remoteMeeting = await openRealMeeting(remote);
    remote.server.prependListener('connection', (peer) => {
      Object.defineProperty(peer, 'remoteAddress', { value: '203.0.113.9' });
    });
    expect((await post(remote, meetingPath(remoteMeeting, '/api/runner/meeting-memory'), [])).status).not.toBe(200);
    expect((await connect(portOf(remote), remoteMeeting.id, 'audience=service')).ok).toBe(false);
  });

  it('refuses to start when https sign-in would downgrade Mattermost to http', async () => {
    vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example');
    vi.stubEnv('MATTERMOST_URL', 'http://127.0.0.1:8083');
    const makeAuth = () =>
      createAuth({ store: createMemoryAuthStore(), offeredRoles: () => ['chef', 'cashier'] });
    const auth = makeAuth();
    await expect(createApp({ speechRecognition: 'browser', scenario: testScenario, auth})).rejects.toThrow(
      /MATTERMOST_PUBLIC_URL/,
    );
    await auth.close();

    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'http://mm.example');
    const httpAuth = makeAuth();
    await expect(
      createApp({ speechRecognition: 'browser', scenario: testScenario, auth: httpAuth}),
    ).rejects.toThrow(/MATTERMOST_PUBLIC_URL/);
    await httpAuth.close();

    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'https://mm.example');
    const httpsAuth = makeAuth();
    const https = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth: httpsAuth}),
    );
    expect(https.server.address()).not.toBeNull();

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'http://mm.example');
    const allowedAuth = makeAuth();
    const allowed = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth: allowedAuth}),
    );
    expect(allowed.server.address()).not.toBeNull();
  });
});
