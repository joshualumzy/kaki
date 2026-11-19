import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword, hashToken, verifyPassword } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meetingCode';
import { testScenario } from '../fixtures/scenario';
import { createTestApp, portOf, waitFor } from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';

interface OpenSocket {
  ws: WebSocket;
}

type ConnectResult = { ok: true; ws: WebSocket } | { ok: false; status: number; error?: string };

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  if (header === null) return undefined;
  const pair = header.split(';')[0];
  return pair === undefined || pair === '' ? undefined : pair;
}

function connect(port: number, role: string, cookie?: string, authorization?: string): Promise<ConnectResult> {
  const url = `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`;
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  if (authorization !== undefined) headers.authorization = authorization;
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

describe('auth', () => {
  let app: KakiApp;
  let store: AuthStore;
  let port: number;
  let sockets: OpenSocket[];

  beforeEach(async () => {
    store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const auth = createAuth({ store, roles: ['chef', 'cashier'], meetingCode });
    app = await createTestApp({ auth, meetingCode, serviceToken: 'runner-secret' });
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

  async function signInAsHost(): Promise<string> {
    const response = await post('/api/auth/login', {
      email: HOST_EMAIL,
      password: HOST_PASSWORD,
    });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Login did not set a cookie');
    return cookie;
  }

  async function joinAs(role: string): Promise<string> {
    const response = await post('/api/join', { code: MEETING_CODE, role });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Join did not set a cookie');
    return cookie;
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
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'Not signed in', authEnabled: true });

    const logout = await post('/api/auth/logout', {}, cookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const afterLogout = await get('/api/auth/me', cookie);
    expect(afterLogout.status).toBe(401);
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

  it('validates the meeting code and role before joining', async () => {
    const noCode = await post('/api/join', { role: 'chef' });
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toEqual({ error: 'Enter the meeting code.' });

    const wrongCode = await post('/api/join', { code: 'ZZZZZZ', role: 'chef' });
    expect(wrongCode.status).toBe(403);
    expect(await wrongCode.json()).toEqual({ error: 'That meeting code is not valid.' });

    const noRole = await post('/api/join', { code: MEETING_CODE });
    expect(noRole.status).toBe(400);
    expect(await noRole.json()).toEqual({ error: 'Choose your role.' });

    const unknownRole = await post('/api/join', { code: MEETING_CODE, role: 'waiter' });
    expect(unknownRole.status).toBe(403);
    expect(await unknownRole.json()).toEqual({
      error: 'That role is not a human seat in this meeting.',
    });

    const cookie = await joinAs('chef');
    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ kind: 'participant', role: 'chef', authEnabled: true });
  });

  it('shows the meeting code to the host only', async () => {
    const anonymous = await get('/api/meeting-code');
    expect(anonymous.status).toBe(401);

    const participant = await joinAs('chef');
    const forbidden = await get('/api/meeting-code', participant);
    expect(forbidden.status).toBe(403);

    const host = await signInAsHost();
    const allowed = await get('/api/meeting-code', host);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ code: MEETING_CODE });
  });

  it('gates WebSocket upgrades by session kind and role', async () => {
    const anonymousScreen = await connect(port, 'screen');
    expect(anonymousScreen.ok).toBe(false);
    if (!anonymousScreen.ok) expect(anonymousScreen.status).toBe(401);

    const anonymousChef = await connect(port, 'chef');
    expect(anonymousChef.ok).toBe(false);
    if (!anonymousChef.ok) expect(anonymousChef.status).toBe(401);

    const host = await signInAsHost();
    const hostScreen = await connect(port, 'screen', host);
    expect(hostScreen.ok).toBe(true);
    if (hostScreen.ok) sockets.push({ ws: hostScreen.ws });

    const hostAsChef = await connect(port, 'chef', host);
    expect(hostAsChef.ok).toBe(false);
    if (!hostAsChef.ok) expect(hostAsChef.status).toBe(401);

    const chef = await joinAs('chef');
    const chefSocket = await connect(port, 'chef', chef);
    expect(chefSocket.ok).toBe(true);
    if (chefSocket.ok) sockets.push({ ws: chefSocket.ws });

    const wrongRole = await connect(port, 'cashier', chef);
    expect(wrongRole.ok).toBe(false);
    if (!wrongRole.ok) expect(wrongRole.status).toBe(401);

    const participantAsScreen = await connect(port, 'screen', chef);
    expect(participantAsScreen.ok).toBe(false);
    if (!participantAsScreen.ok) expect(participantAsScreen.status).toBe(401);
  });

  it('lets signed-in people read the lifecycle and the runner use its authenticated service channel', async () => {
    const chef = await joinAs('chef');
    const participantLifecycle = await connect(port, 'lifecycle', chef);
    expect(participantLifecycle.ok).toBe(true);
    if (participantLifecycle.ok) sockets.push({ ws: participantLifecycle.ws });

    const host = await signInAsHost();
    const hostLifecycle = await connect(port, 'lifecycle', host);
    expect(hostLifecycle.ok).toBe(true);
    if (hostLifecycle.ok) sockets.push({ ws: hostLifecycle.ws });

    const anonymousLifecycle = await connect(port, 'lifecycle');
    expect(anonymousLifecycle.ok).toBe(false);
    if (!anonymousLifecycle.ok) expect(anonymousLifecycle.status).toBe(401);

    const anonymousService = await connect(port, 'service');
    expect(anonymousService.ok).toBe(false);
    if (!anonymousService.ok) expect(anonymousService.status).toBe(401);

    const wrongToken = await connect(port, 'service', undefined, 'Bearer not-the-secret');
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) expect(wrongToken.status).toBe(401);

    const runner = await connect(port, 'service', undefined, 'Bearer runner-secret');
    expect(runner.ok).toBe(true);
    if (runner.ok) sockets.push({ ws: runner.ws });
  });

  it('lets the AI runner command only on the screen and its AI seats, never a human seat', async () => {
    await app.close();
    const scenario = {
      ...testScenario,
      roles: [...testScenario.roles, { id: 'manager', label: 'Manager' }],
      attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy' }],
      npcs: [
        { attendee: 'Cy', voice: 'test-voice', personality: 'Quiet.', agenda: 'Keep the kitchen running.', concerns: [] },
      ],
    };
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const aiAuth = createAuth({ store, roles: ['chef', 'cashier'], meetingCode });
    app = await createApp({ scenario, auth: aiAuth, meetingCode, serviceToken: 'runner-secret' });
    port = portOf(app);

    const task = app.tasks.suggest({ title: 'Approve the order', context: 'Lunch prep', suggestedAssignee: 'manager' });
    app.tasks.transition(task.id, 'DISPATCHED', { assignee: 'manager' });
    app.tasks.transition(task.id, 'CLAIMED', { mode: 'MANUAL' });
    const draft = { target: 'orders@example.com', subject: 'Order', body: 'Please confirm.' };
    app.tasks.transition(task.id, 'DRAFT_READY', { draft });

    // The runner's token may not open a human seat, even though it may drive the screen.
    const humanSeat = await connect(port, 'chef', undefined, 'Bearer runner-secret');
    expect(humanSeat.ok).toBe(false);
    if (!humanSeat.ok) expect(humanSeat.status).toBe(401);

    const runnerRole = await connect(port, 'manager', undefined, 'Bearer runner-secret');
    expect(runnerRole.ok).toBe(true);
    if (!runnerRole.ok) return;
    sockets.push({ ws: runnerRole.ws });
    const roleEvents: Array<{ type?: string }> = [];
    runnerRole.ws.on('message', (data) => roleEvents.push(JSON.parse(data.toString()) as { type?: string }));

    runnerRole.ws.send(JSON.stringify({ type: 'APPROVE_ACTION', taskId: task.id, draft }));
    await waitFor(() => (app.tasks.get(task.id)?.status === 'RUNNING' ? true : undefined), 'the runner to approve');
    expect(roleEvents.some((event) => event.type === 'COMMAND_REJECTED')).toBe(false);

    // The runner may act only for its own roles: dispatching a task is not one of its commands.
    runnerRole.ws.send(JSON.stringify({ type: 'DISPATCH_TASK', taskId: task.id, assignee: 'manager' }));
    await waitFor(
      () => (roleEvents.some((event) => event.type === 'COMMAND_REJECTED') ? true : undefined),
      'the forbidden runner command to be refused',
    );

    const runnerScreen = await connect(port, 'screen', undefined, 'Bearer runner-secret');
    expect(runnerScreen.ok).toBe(true);
    if (!runnerScreen.ok) return;
    sockets.push({ ws: runnerScreen.ws });
    const screenEvents: Array<{ type?: string }> = [];
    runnerScreen.ws.on('message', (data) => screenEvents.push(JSON.parse(data.toString()) as { type?: string }));
    runnerScreen.ws.send(JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screenEvents.some((event) => event.type === 'COMMAND_REJECTED')).toBe(false);

    // The command path is the runner's: a browser without the service token still cannot use it.
    const anonymousService = await connect(port, 'service');
    expect(anonymousService.ok).toBe(false);
    if (!anonymousService.ok) expect(anonymousService.status).toBe(401);
  });

  it('rejects an expired session cookie over HTTP and WebSocket', async () => {
    const token = `expired-${randomUUID()}`;
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'host',
      role: null,
      meetingCode: null,
      meetingId: null,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const cookie = `kaki_session=${encodeURIComponent(token)}`;
    const me = await get('/api/auth/me', cookie);
    expect(me.status).toBe(401);

    const socket = await connect(port, 'screen', cookie);
    expect(socket.ok).toBe(false);
    if (!socket.ok) expect(socket.status).toBe(401);
  });

  it('reports auth off and keeps the old open WebSocket flow when no auth is injected', async () => {
    const plain = await createTestApp();
    try {
      const plainPort = portOf(plain);
      const me = await fetch(`http://127.0.0.1:${plainPort}/api/auth/me`);
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ authEnabled: false });

      const chef = await connect(plainPort, 'chef');
      expect(chef.ok).toBe(true);
      if (chef.ok) chef.ws.terminate();
    } finally {
      await plain.close();
    }
  });
});
