import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword, hashToken, verifyPassword } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createTestApp, meetingUrl, openRealMeeting, portOf, waitFor, type TestMeeting } from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';

interface OpenSocket {
  ws: WebSocket;
}

type ConnectResult = { ok: true; ws: WebSocket } | { ok: false; status: number; error?: string };

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  if (header === null) return undefined;
  const pair = header.split(';')[0];
  return pair === undefined || pair === '' ? undefined : pair;
}

function connect(
  port: number,
  meetingId: string,
  query: string,
  options: { cookie?: string; authorization?: string } = {},
): Promise<ConnectResult> {
  const url = `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meetingId)}&${query}`;
  const headers: Record<string, string> = {};
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

    ws.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 0, error: error.message });
    });
  });
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

describe('auth', () => {
  let app: KakiApp;
  let store: AuthStore;
  let port: number;
  let sockets: OpenSocket[];

  beforeEach(async () => {
    store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createTestApp({ auth, serviceToken: 'runner-secret' });
    port = portOf(app);
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.ws.terminate();
    await app.close();
  });

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(
      `http://127.0.0.1:${port}${path}`,
      cookie === undefined ? undefined : { headers: { cookie } },
    );
  }

  /** Open a real meeting as its signed-in owner; every host route is now open to this cookie. */
  async function openMeeting(): Promise<{ meeting: TestMeeting; owner: SignedIn }> {
    const owner = await signInGoogle(store, 'Ada');
    const meeting = await openRealMeeting(app, { ownerUserId: owner.user.id, title: 'Weekly planning' });
    const opened = await post(meetingUrl(app, meeting.id, '/api/meeting/open').replace(`http://127.0.0.1:${port}`, ''), {}, owner.cookie);
    expect(opened.status).toBe(200);
    return { meeting, owner };
  }

  /** A guest joins the meeting's link, then takes a seat through the token route. */
  async function joinGuest(meeting: TestMeeting, name: string): Promise<string> {
    const joined = await post(meetingUrl(app, meeting.id, '/join').replace(`http://127.0.0.1:${port}`, ''), { name });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    if (guest === undefined) throw new Error('Join did not set a cookie');
    const seated = await post(
      meetingUrl(app, meeting.id, '/api/livekit/token').replace(`http://127.0.0.1:${port}`, ''),
      { participantName: name },
      guest,
    );
    expect(seated.status).toBe(200);
    const seat = cookieFrom(seated);
    if (seat === undefined) throw new Error('Taking a seat did not set a cookie');
    return seat;
  }

  function pathFor(meeting: TestMeeting, path: string): string {
    return meetingUrl(app, meeting.id, path).replace(`http://127.0.0.1:${port}`, '');
  }

  it('hashes passwords with a random salt and verifies them', async () => {
    const first = await hashPassword('hunter2');
    const second = await hashPassword('hunter2');

    expect(first).not.toBe(second);
    expect(first).not.toContain('hunter2');
    expect(await verifyPassword('hunter2', first)).toBe(true);
    expect(await verifyPassword('hunter3', first)).toBe(false);
    expect(await verifyPassword('hunter2', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('hunter2', `${first}00`)).toBe(false);
  });

  it('validates the login form and never reveals whether the email exists', async () => {
    const emptyEmail = await post('/api/auth/login', { email: '', password: 'x' });
    expect(emptyEmail.status).toBe(400);
    expect(await emptyEmail.json()).toEqual({ error: 'Enter your email address.' });

    const badEmail = await post('/api/auth/login', { email: 'nope', password: 'x' });
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toEqual({ error: 'Enter a valid email address.' });

    const emptyPassword = await post('/api/auth/login', { email: HOST_EMAIL, password: '' });
    expect(emptyPassword.status).toBe(400);
    expect(await emptyPassword.json()).toEqual({ error: 'Enter your password.' });

    const unknown = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: HOST_PASSWORD,
    });
    const wrong = await post('/api/auth/login', { email: HOST_EMAIL, password: 'wrong' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await unknown.json();
    const wrongBody = await wrong.json();
    expect(unknownBody).toEqual(wrongBody);
    expect(wrongBody).toEqual({ error: 'Email or password is incorrect.' });
  });

  it('signs a host in, remembers them and clears the session on logout', async () => {
    const login = await post('/api/auth/login', { email: HOST_EMAIL, password: HOST_PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('kaki_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=43200');
    expect(setCookie).not.toContain('Secure');

    const cookie = cookieFrom(login);
    if (cookie === undefined) throw new Error('Login did not set a cookie');

    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: 'host', authEnabled: true });

    const anonymous = await get('/api/auth/me');
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ authEnabled: true, kind: null });

    const logout = await post('/api/auth/logout', {}, cookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const afterLogout = await get('/api/auth/me', cookie);
    expect(afterLogout.status).toBe(200);
    expect(await afterLogout.json()).toEqual({ authEnabled: true, kind: null });
  });

  it('rate-limits five login failures per minute per address and email', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post('/api/auth/login', {
        email: 'limited@example.com',
        password: 'wrong',
      });
      expect(response.status).toBe(401);
    }

    const limited = await post('/api/auth/login', {
      email: 'limited@example.com',
      password: 'wrong',
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: 'Too many sign-in attempts. Wait a minute and try again.',
    });

    const otherEmail = await post('/api/auth/login', {
      email: 'free@example.com',
      password: 'wrong',
    });
    expect(otherEmail.status).toBe(401);
  });

  it('shows the meeting code to the host only', async () => {
    const { meeting, owner } = await openMeeting();

    const anonymous = await get(pathFor(meeting, '/api/meeting-code'));
    expect(anonymous.status).toBe(401);

    const guest = await joinGuest(meeting, 'Guest');
    const forbidden = await get(pathFor(meeting, '/api/meeting-code'), guest);
    expect(forbidden.status).toBe(403);

    const allowed = await get(pathFor(meeting, '/api/meeting-code'), owner.cookie);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ code: meeting.instance.meetingCode() });
  });

  it('gates WebSocket upgrades by session kind and role', async () => {
    const anonymousScreen = await connect(port, 'not-a-meeting', 'audience=screen');
    // An unknown meeting is refused before any WebSocket exists.
    expect(anonymousScreen.ok).toBe(false);
    if (!anonymousScreen.ok) expect(anonymousScreen.status).toBe(404);

    const { meeting, owner } = await openMeeting();

    const anonymousScreenKnown = await connect(port, meeting.id, 'audience=screen');
    expect(anonymousScreenKnown.ok).toBe(false);
    if (!anonymousScreenKnown.ok) expect(anonymousScreenKnown.status).toBe(401);

    const anonymousSeat = await connect(port, meeting.id, 'role=chef');
    expect(anonymousSeat.ok).toBe(false);
    if (!anonymousSeat.ok) expect(anonymousSeat.status).toBe(401);

    const hostScreen = await connect(port, meeting.id, 'audience=screen', { cookie: owner.cookie });
    expect(hostScreen.ok).toBe(true);
    if (hostScreen.ok) sockets.push({ ws: hostScreen.ws });

    const hostAsChef = await connect(port, meeting.id, 'role=chef', { cookie: owner.cookie });
    expect(hostAsChef.ok).toBe(false);
    if (!hostAsChef.ok) expect(hostAsChef.status).toBe(401);

    const seat = await joinGuest(meeting, 'Ada');
    const guestSeat = await connect(port, meeting.id, 'role=everyone', { cookie: seat });
    expect(guestSeat.ok).toBe(false);
    if (!guestSeat.ok) expect(guestSeat.status).toBe(401);

    // The seat the person actually holds is the only one they may follow.
    const holder = meeting.instance.session.holders()[0];
    expect(holder).toBeDefined();
    const seatFeed = await connect(port, meeting.id, `role=${encodeURIComponent(holder!.seat)}`, { cookie: seat });
    expect(seatFeed.ok).toBe(true);
    if (seatFeed.ok) sockets.push({ ws: seatFeed.ws });

    // A guest never reads the owner's screen.
    const participantAsScreen = await connect(port, meeting.id, 'audience=screen', { cookie: seat });
    expect(participantAsScreen.ok).toBe(false);
    if (!participantAsScreen.ok) expect(participantAsScreen.status).toBe(401);

    const participant = await connect(port, meeting.id, 'audience=participant', { cookie: seat });
    expect(participant.ok).toBe(true);
    if (participant.ok) sockets.push({ ws: participant.ws });
  });

  it('gives a participant a read-only projection that cannot command the meeting', async () => {
    const { meeting } = await openMeeting();
    const seat = await joinGuest(meeting, 'Ada');
    const holder = meeting.instance.session.holders()[0]!;

    const participant = await connect(port, meeting.id, 'audience=participant', { cookie: seat });
    expect(participant.ok).toBe(true);
    if (!participant.ok) return;
    sockets.push({ ws: participant.ws });

    const rejected: string[] = [];
    participant.ws.on('message', (data) => {
      const event = JSON.parse(data.toString()) as {
        type?: string;
        payload?: { reason?: string };
      };
      if (event.type === 'COMMAND_REJECTED' && event.payload?.reason !== undefined) {
        rejected.push(event.payload.reason);
      }
    });

    participant.ws.send(JSON.stringify({ type: 'DISPATCH_TASK', taskId: 'not-a-task', assignee: holder.seat }));
    const reason = await waitFor(() => rejected[0], 'participant command rejection');
    expect(reason).toMatch(/Only the shared screen can do that/);
  });

  it('lets signed-in people read the lifecycle and the runner use its authenticated service channel', async () => {
    const { meeting, owner } = await openMeeting();
    const seat = await joinGuest(meeting, 'Ada');

    const participantLifecycle = await connect(port, meeting.id, 'audience=lifecycle', { cookie: seat });
    expect(participantLifecycle.ok).toBe(true);
    if (participantLifecycle.ok) sockets.push({ ws: participantLifecycle.ws });

    const hostLifecycle = await connect(port, meeting.id, 'audience=lifecycle', { cookie: owner.cookie });
    expect(hostLifecycle.ok).toBe(true);
    if (hostLifecycle.ok) sockets.push({ ws: hostLifecycle.ws });

    const anonymousLifecycle = await connect(port, meeting.id, 'audience=lifecycle');
    expect(anonymousLifecycle.ok).toBe(false);
    if (!anonymousLifecycle.ok) expect(anonymousLifecycle.status).toBe(401);

    const anonymousService = await connect(port, meeting.id, 'audience=service');
    expect(anonymousService.ok).toBe(false);
    if (!anonymousService.ok) expect(anonymousService.status).toBe(401);

    const wrongToken = await connect(port, meeting.id, 'audience=service', {
      authorization: 'Bearer not-the-secret',
    });
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) expect(wrongToken.status).toBe(401);

    const runner = await connect(port, meeting.id, 'audience=service', {
      authorization: 'Bearer runner-secret',
    });
    expect(runner.ok).toBe(true);
    if (runner.ok) sockets.push({ ws: runner.ws });
  });

  it('lets the runner drive the screen but never take a human seat', async () => {
    const { meeting } = await openMeeting();
    await joinGuest(meeting, 'Ada');
    const holder = meeting.instance.session.holders()[0]!;

    // The runner's token may not open a human seat, even though it may drive the screen.
    const humanSeat = await connect(port, meeting.id, `role=${encodeURIComponent(holder.seat)}`, {
      authorization: 'Bearer runner-secret',
    });
    expect(humanSeat.ok).toBe(false);
    if (!humanSeat.ok) expect(humanSeat.status).toBe(401);

    const runnerScreen = await connect(port, meeting.id, 'audience=screen', {
      authorization: 'Bearer runner-secret',
    });
    expect(runnerScreen.ok).toBe(true);
    if (!runnerScreen.ok) return;
    sockets.push({ ws: runnerScreen.ws });
    const screenEvents: Array<{ type?: string }> = [];
    runnerScreen.ws.on('message', (data) => screenEvents.push(JSON.parse(data.toString()) as { type?: string }));
    runnerScreen.ws.send(JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screenEvents.some((event) => event.type === 'COMMAND_REJECTED')).toBe(false);

    // The service channel still requires the token: a browser cannot use it.
    const anonymousService = await connect(port, meeting.id, 'audience=service');
    expect(anonymousService.ok).toBe(false);
    if (!anonymousService.ok) expect(anonymousService.status).toBe(401);
  });

  it('rejects an expired session cookie over HTTP and WebSocket', async () => {
    const { meeting } = await openMeeting();
    const user = await store.createGoogleUser({
      googleSub: randomUUID(),
      name: 'Expired',
      email: `${randomUUID()}@example.com`,
    });
    const token = `expired-${randomUUID()}`;
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: 'Expired',
      userId: user.id,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const cookie = `kaki_session=${encodeURIComponent(token)}`;
    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authEnabled: true, kind: null });

    const socket = await connect(port, meeting.id, 'audience=screen', { cookie });
    expect(socket.ok).toBe(false);
    if (!socket.ok) expect(socket.status).toBe(401);
  });

  it('reports auth off and keeps the open WebSocket flow when no auth is injected', async () => {
    const plain = await createTestApp();
    try {
      const plainPort = portOf(plain);
      const meeting = await openRealMeeting(plain);
      const me = await fetch(`http://127.0.0.1:${plainPort}/api/auth/me`);
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ authEnabled: false });

      const screen = await connect(plainPort, meeting.id, 'audience=screen');
      expect(screen.ok).toBe(true);
      if (screen.ok) screen.ws.terminate();
    } finally {
      await plain.close();
    }
  });
});

describe('legacy meeting code join', () => {
  let app: KakiApp;
  let store: AuthStore;
  let port: number;

  beforeEach(async () => {
    store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createTestApp({ auth, meetingCode, serviceToken: 'runner-secret' });
    port = portOf(app);
  });

  afterEach(async () => {
    await app.close();
  });

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(
      `http://127.0.0.1:${port}${path}`,
      cookie === undefined ? undefined : { headers: { cookie } },
    );
  }

  async function signInAsHost(): Promise<string> {
    const response = await post('/api/auth/login', { email: HOST_EMAIL, password: HOST_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Login did not set a cookie');
    return cookie;
  }

  async function joinAs(role: string): Promise<string> {
    const response = await post('/api/join', { code: 'K7M2Q9', role });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Join did not set a cookie');
    return cookie;
  }

  it('validates the meeting code and role before joining', async () => {
    const host = await signInAsHost();
    expect((await post('/api/meeting/open', {}, host)).status).toBe(200);
    const noCode = await post('/api/join', { role: 'chef' });
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toEqual({ error: 'Enter the meeting code.' });

    const wrongCode = await post('/api/join', { code: 'ZZZZZZ', role: 'chef' });
    expect(wrongCode.status).toBe(403);
    expect(await wrongCode.json()).toEqual({ error: 'That meeting code is not valid.' });

    const noRole = await post('/api/join', { code: 'K7M2Q9' });
    expect(noRole.status).toBe(400);
    expect(await noRole.json()).toEqual({ error: 'Choose your role.' });

    const unknownRole = await post('/api/join', { code: 'K7M2Q9', role: 'waiter' });
    expect(unknownRole.status).toBe(403);
    expect(await unknownRole.json()).toEqual({
      error: 'That role is not a human seat in this meeting.',
    });

    const cookie = await joinAs('chef');
    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: 'participant', role: 'chef', authEnabled: true });
  });
});
