import { randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword, hashToken } from '../src/auth/password';
import { ensureAuthSchema } from '../src/auth/schema';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createMeetingCodeSource, type MeetingCodeSource } from '../src/meetingCode';
import { createMeetingModule } from '../src/host/meeting';
import type { KakiModule } from '../src/modules';
import type { MeetingPersistence } from '../src/persist/persistence';
import { testScenario } from './fixtures/scenario';
import { portOf, settle, waitFor } from './helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';

type ConnectResult =
  | { ok: true; ws: WebSocket; closed: Promise<number> }
  | { ok: false; status: number };

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  if (pair === undefined || pair === '') throw new Error('The response did not set a session cookie');
  return pair;
}

function tokenFrom(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
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

async function closeWithin(closed: Promise<number>, ms = 500): Promise<number | undefined> {
  return Promise.race([closed, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

/** A client frame must be masked; the raw socket never answers the server's close frame. */
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
async function rawConnect(port: number, role: string, cookie: string): Promise<RawSocket> {
  const socket = netConnect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    [
      `GET /ws?role=${encodeURIComponent(role)} HTTP/1.1`,
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

const transcriptEvent = {
  type: 'TRANSCRIPT_CHUNK',
  audience: { kind: 'all' },
  payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() },
};

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

  async function authApp({
    scenario = testScenario,
    serviceToken,
    roomRoster,
    code = MEETING_CODE,
    devRoutes = false,
    modules,
    persistence,
  }: {
    scenario?: Scenario;
    serviceToken?: string;
    roomRoster?: (roomName: string) => Promise<Array<{ name: string; role?: string }> | undefined>;
    code?: string;
    devRoutes?: boolean;
    modules?: KakiModule[];
    persistence?: MeetingPersistence;
  } = {}): Promise<{ app: KakiApp; store: AuthStore; meetingCode: MeetingCodeSource }> {
    const store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource(code);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    const app = track(
      await createApp({
        speechRecognition: 'browser',
        scenario,
        auth,
        meetingCode,
        roomRoster: roomRoster ?? (async () => []),
        devRoutes,
        modules,
        persistence,
        ...(serviceToken === undefined ? {} : { serviceToken }),
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
    return fetch(`${base(app)}${path}`, cookie === undefined ? undefined : { headers: { cookie } });
  }

  async function signInAsHost(app: KakiApp, cookie?: string): Promise<string> {
    const response = await post(
      app,
      '/api/auth/login',
      { email: HOST_EMAIL, password: HOST_PASSWORD },
      cookie,
    );
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function join(app: KakiApp, role: string): Promise<string> {
    const response = await post(app, '/api/join', { code: MEETING_CODE, role });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  it('invalidates legacy participant sessions that have no meeting generation', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    await ensureAuthSchema(pool);
    expect(
      queries.some(
        (sql) =>
          /delete\s+from\s+sessions/i.test(sql) &&
          /meeting_id\s+is\s+null/i.test(sql) &&
          /participant/i.test(sql),
      ),
    ).toBe(true);

    const { app, store } = await authApp();
    const token = `legacy-${randomBytes(8).toString('hex')}`;
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'participant',
      role: 'chef',
      meetingCode: MEETING_CODE,
      meetingId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const cookie = `kaki_session=${encodeURIComponent(token)}`;
    expect((await get(app, '/api/auth/me', cookie)).status).toBe(403);
    const socket = await connect(portOf(app), 'chef', { cookie });
    expect(socket.ok).toBe(false);
  });

  it('checks that the seat claim still belongs to the session, not just its role', async () => {
    const { app, store } = await authApp();
    const cookie = await join(app, 'chef');
    const tokenHash = hashToken(tokenFrom(cookie));

    // The session still names the role, but its claim has gone (for example, a replacement moved it).
    await store.releaseSeats({ holder: tokenHash });

    const socket = await connect(portOf(app), 'chef', { cookie });
    expect(socket.ok).toBe(false);
    if (!socket.ok) expect(socket.status).toBe(401);
  });

  it('replaces a seat session through one store step and leaves everything unchanged when it fails', async () => {
    const baseStore = createMemoryAuthStore();
    await baseStore.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    let calls = 0;
    const store = {
      ...baseStore,
      async enterSeat(input: unknown) {
        calls += 1;
        if (calls === 2) throw new Error('the store is unavailable');
        return (baseStore as unknown as { enterSeat(value: unknown): Promise<boolean> }).enterSeat(input);
      },
    } as AuthStore;
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    const app = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth, meetingCode, roomRoster: async () => [] }),
    );

    const first = await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' });
    expect(first.status).toBe(200);
    const cookie = cookieFrom(first);

    const second = await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' }, cookie);
    expect(second.status).toBe(500);

    // The original session and its claim are untouched, so nobody else can take the seat now.
    expect((await get(app, '/api/auth/me', cookie)).status).toBe(200);
    expect((await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' })).status).toBe(409);
    const socket = await connect(portOf(app), 'chef', { cookie });
    expect(socket.ok).toBe(true);
    if (socket.ok) socket.ws.terminate();
  });

  it('stops a revoked socket sending commands before its close handshake finishes', async () => {
    const { app } = await authApp();
    const cookie = await join(app, 'chef');
    const tokenHash = hashToken(tokenFrom(cookie));
    const port = portOf(app);

    const before = app.tasks.suggest({ title: 'Prep the oven', context: 'Before service', suggestedAssignee: 'chef' });
    app.tasks.transition(before.id, 'DISPATCHED', { assignee: 'chef' });
    const after = app.tasks.suggest({ title: 'Count the float', context: 'Before service', suggestedAssignee: 'chef' });
    app.tasks.transition(after.id, 'DISPATCHED', { assignee: 'chef' });

    const raw = await rawConnect(port, 'chef', cookie);
    try {
      raw.send(JSON.stringify({ type: 'CLAIM_TASK', taskId: before.id, mode: 'MANUAL' }));
      await waitFor(() => (app.tasks.get(before.id)?.status === 'CLAIMED' ? true : undefined), 'the raw socket command');

      app.hub.endSession?.(tokenHash);
      raw.send(JSON.stringify({ type: 'CLAIM_TASK', taskId: after.id, mode: 'MANUAL' }));
      await settle(150);
      expect(app.tasks.get(after.id)?.status).toBe('DISPATCHED');
    } finally {
      raw.destroy();
    }
  });

  it('does not resume dispatch after the sending session is revoked mid-command', async () => {
    const { app } = await authApp();
    const host = await signInAsHost(app);
    const screen = await connect(portOf(app), 'screen', { cookie: host });
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutated = false;
    app.hub.onCommand(async (command) => {
      if (command.type === 'SET_HOST_MODE') { entered(); await gate; }
    });
    app.hub.onCommand((command) => { if (command.type === 'SET_HOST_MODE') mutated = true; });
    screen.ws.send(JSON.stringify({ type: 'SET_HOST_MODE', human: true }));
    await waiting;
    await signInAsHost(app, host);
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
    const { app } = await authApp({ modules: [createMeetingModule()], persistence });
    const host = await signInAsHost(app);
    const screen = await connect(portOf(app), 'screen', { cookie: host });
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    const before = (await (await get(app, '/api/meeting/state')).json()) as { meetingId: string };
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waiting;
    const savesBeforeRevocation = saves;
    await signInAsHost(app, host);
    release();
    await settle(20);
    expect((await (await get(app, '/api/meeting/state')).json()) as { meetingId: string })
      .toMatchObject({ meetingId: before.meetingId });
    expect(saves).toBeGreaterThan(savesBeforeRevocation);
    screen.ws.terminate();
  });

  it('rejects an upgrade whose session was revoked while it was authorizing', async () => {
    const store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const baseAuth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
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
      ) => {
        const decision = await baseAuth.authorize(request, audience);
        didAuthorize?.();
        await released;
        return decision;
      },
    };
    const app = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth, meetingCode, roomRoster: async () => [] }),
    );
    const cookie = await join(app, 'chef');
    const tokenHash = hashToken(tokenFrom(cookie));

    const pending = connect(portOf(app), 'chef', { cookie });
    await authorized;
    app.hub.endSession?.(tokenHash);
    release?.();

    const opened = await pending;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.ws.terminate();
    expect(await closeWithin(opened.closed)).toBe(4001);
  });

  it('retires the old session and transfers its seat when a seated host signs in again', async () => {
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
    const screen = await connect(port, 'screen', { cookie: seatHost });
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;

    const again = await signInAsHost(app, seatHost);

    expect((await get(app, '/api/auth/me', seatHost)).status).toBe(401);
    expect(await closeWithin(screen.closed)).toBe(4001);

    const body = (await (await get(app, '/api/scenario', again)).json()) as Scenario;
    expect(body.roles.find((role) => role.id === 'chef')?.card?.facts).toEqual(['chef card secret']);
    expect(body.agenda[0]?.seatFacts).toEqual({ chef: 'chef seat secret' });

    // The transferred claim still blocks another person from taking the seat.
    expect((await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' })).status).toBe(409);
  });

  it('keeps the first meeting generation when phones joined before the first LiveKit admission', async () => {
    const { app } = await authApp();
    const port = portOf(app);
    const phone = await join(app, 'chef');
    const phoneSocket = await connect(port, 'chef', { cookie: phone });
    expect(phoneSocket.ok).toBe(true);

    const before = (await (await get(app, '/api/meeting/state')).json()) as { meetingId: string };
    const desktop = await post(app, '/api/livekit/token', {
      participantName: 'Ada',
      participantRole: 'cashier',
      meetingCode: MEETING_CODE,
    });
    expect(desktop.status).toBe(200);
    expect(((await (await get(app, '/api/meeting/state')).json()) as { meetingId: string }).meetingId).toBe(
      before.meetingId,
    );

    expect((await get(app, '/api/auth/me', phone)).status).toBe(200);
    expect((await post(app, '/api/join', { code: MEETING_CODE, role: 'chef' })).status).toBe(409);
    if (phoneSocket.ok) {
      await settle(100);
      expect(phoneSocket.ws.readyState).toBe(WebSocket.OPEN);
      phoneSocket.ws.terminate();
    }
  });

  it('requires the service token on runner routes and sockets even with sign-in off', async () => {
    const app = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, serviceToken: 'runner-secret', roomRoster: async () => [] }),
    );
    expect((await post(app, '/api/runner/emit', transcriptEvent)).status).toBe(401);
    const runner = await fetch(`${base(app)}/api/runner/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer runner-secret' },
      body: JSON.stringify(transcriptEvent),
    });
    expect(runner.status).toBe(200);

    const port = portOf(app);
    expect((await connect(port, 'service')).ok).toBe(false);
    const service = await connect(port, 'service', { authorization: 'Bearer runner-secret' });
    expect(service.ok).toBe(true);
    if (service.ok) service.ws.terminate();
  });

  it('allows a tokenless runner only from the direct loopback peer', async () => {
    const local = track(await createApp({ speechRecognition: 'browser', scenario: testScenario }));
    expect((await post(local, '/api/runner/emit', transcriptEvent)).status).toBe(200);
    const localSocket = await connect(portOf(local), 'service');
    expect(localSocket.ok).toBe(true);
    if (localSocket.ok) localSocket.ws.terminate();

    const remote = track(await createApp({ speechRecognition: 'browser', scenario: testScenario, devRoutes: true }));
    remote.server.prependListener('connection', (peer) => {
      Object.defineProperty(peer, 'remoteAddress', { value: '203.0.113.9' });
    });
    expect((await post(remote, '/api/runner/emit', transcriptEvent)).status).not.toBe(200);
    expect((await connect(portOf(remote), 'service')).ok).toBe(false);
  });

  it('refuses to start when https sign-in would downgrade Mattermost to http', async () => {
    vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example');
    vi.stubEnv('MATTERMOST_URL', 'http://127.0.0.1:8083');
    const makeAuth = (code: MeetingCodeSource) =>
      createAuth({ store: createMemoryAuthStore(), offeredRoles: () => ['chef', 'cashier'], meetingCode: code });

    const code = createMeetingCodeSource(MEETING_CODE);
    const auth = makeAuth(code);
    await expect(createApp({ speechRecognition: 'browser', scenario: testScenario, auth, meetingCode: code })).rejects.toThrow(
      /MATTERMOST_PUBLIC_URL/,
    );
    await auth.close();

    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'http://mm.example');
    const httpCode = createMeetingCodeSource(MEETING_CODE);
    const httpAuth = makeAuth(httpCode);
    await expect(
      createApp({ speechRecognition: 'browser', scenario: testScenario, auth: httpAuth, meetingCode: httpCode }),
    ).rejects.toThrow(/MATTERMOST_PUBLIC_URL/);
    await httpAuth.close();

    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'https://mm.example');
    const httpsCode = createMeetingCodeSource(MEETING_CODE);
    const httpsAuth = makeAuth(httpsCode);
    const https = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth: httpsAuth, meetingCode: httpsCode }),
    );
    expect(https.server.address()).not.toBeNull();

    vi.stubEnv('KAKI_ALLOW_OPEN', '1');
    vi.stubEnv('MATTERMOST_PUBLIC_URL', 'http://mm.example');
    const allowedCode = createMeetingCodeSource(MEETING_CODE);
    const allowedAuth = makeAuth(allowedCode);
    const allowed = track(
      await createApp({ speechRecognition: 'browser', scenario: testScenario, auth: allowedAuth, meetingCode: allowedCode }),
    );
    expect(allowed.server.address()).not.toBeNull();
  });
});
