import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { joinSeatRoles, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { loadScenario } from '../src/loadScenario';
import { createMeetingCodeSource } from '../src/meetingCode';
import { portOf, waitFor } from './helpers';

const CODE = 'K7M2Q9';
const TOKEN = 'local-test-runner-token';
const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'host-password';
const pack: Scenario = await loadScenario('kopitiam');

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

async function request(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function practiceJoin(port: number, name: string, role = 'producer'): Promise<Response> {
  return request(port, '/api/livekit/token', 'POST', {
    participantName: name,
    participantRole: role,
    kind: 'practice',
  });
}

/** The AI runner the practice meeting needs before Start can commit. */
function connectService(port: number, authorization?: string): Promise<void> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=service`,
    authorization === undefined ? undefined : { headers: { authorization } },
  );
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
      return;
    }
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

async function openModeApp(options: {
  roomRoster?: () => Promise<Array<{ name: string }>>;
  rejoinGraceMs?: number;
  admissionReservationMs?: number;
} = {}): Promise<{ app: KakiApp; port: number }> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    roomRoster: options.roomRoster ?? (async () => []),
    meetingCode: createMeetingCodeSource(CODE),
    rejoinGraceMs: options.rejoinGraceMs ?? 60_000,
    rejoinPollMs: 20,
    ...(options.admissionReservationMs === undefined
      ? {}
      : { admissionReservationMs: options.admissionReservationMs }),
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function authModeApp(): Promise<{ app: KakiApp; port: number }> {
  const store = createMemoryAuthStore();
  await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
  const meetingCode = createMeetingCodeSource(CODE);
  const auth = createAuth({
    store,
    offeredRoles: () => joinSeatRoles(pack).map((role) => role.id),
    meetingCode,
  });
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    auth,
    meetingCode,
    serviceToken: TOKEN,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    startAckTimeoutMs: 2_000,
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function loginHost(port: number): Promise<string> {
  return cookieFrom(
    await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
  );
}

describe('meeting kind in auth mode', () => {
  it('lets a practice visitor join without a code and start, and keeps the owner out until it ends', async () => {
    const { app, port } = await authModeApp();
    await connectService(port, `Bearer ${TOKEN}`);

    const joined = await practiceJoin(port, 'Alice');
    expect(joined.status).toBe(200);
    const practiceCookie = cookieFrom(joined);
    expect(practiceCookie.startsWith('kaki_practice=')).toBe(true);
    expect(((await joined.json()) as { started: boolean }).started).toBe(false);
    expect(app.session.kind()).toBe('practice');

    // The practice meeting takes one person.
    const second = await practiceJoin(port, 'Ben', 'game_designer');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/full/);

    const host = await loginHost(port);

    // The owner cannot open the team meeting over a practice meeting.
    const blockedOpen = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(blockedOpen.status).toBe(409);
    expect(await blockedOpen.json()).toMatchObject({ practiceInProgress: true });

    // The practice capability opens nothing else: no setup read/write, no tools, no owner route.
    expect((await request(port, '/api/setup', 'GET', undefined, practiceCookie)).status).toBe(401);
    expect((await request(port, '/api/setup/tools', 'GET', undefined, practiceCookie)).status).toBe(403);
    expect((await request(port, '/api/setup', 'PUT', {}, practiceCookie)).status).toBe(403);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, practiceCookie)).status).toBe(403);

    // It may start its own practice meeting.
    const started = await request(port, '/api/meeting/start', 'POST', undefined, practiceCookie);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ started: true });
    expect(app.session.phase()).toBe('running');

    const state = await request(port, '/api/meeting/state');
    expect(await state.json()).toMatchObject({ started: true, kind: 'practice' });

    const stillBlocked = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(stillBlocked.status).toBe(409);
    expect(await stillBlocked.json()).toMatchObject({ practiceInProgress: true });

    // End the practice meeting: it becomes a clean lobby with no kind.
    const ended = await request(port, '/api/meeting/end-practice', 'POST', undefined, host);
    expect(ended.status).toBe(200);
    expect(app.session.kind()).toBeUndefined();
    expect((await request(port, '/api/meeting/state').then((response) => response.json())) as {
      kind?: string;
    }).not.toHaveProperty('kind');

    // Now the owner opens the real meeting.
    const opened = await request(port, '/api/meeting/open', 'POST', undefined, host);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ kind: 'real', phase: 'lobby' });

    // A participant needs the meeting code.
    const noCode = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'producer',
    });
    expect(noCode.status).toBe(403);
    expect(await noCode.json()).toMatchObject({ needsCode: true });
    const withCode = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'producer',
      meetingCode: CODE,
    });
    expect(withCode.status).toBe(200);
    expect(app.session.kind()).toBe('real');

    // The old practice cookie cannot start the real meeting.
    const stale = await request(port, '/api/meeting/start', 'POST', undefined, practiceCookie);
    expect(stale.status).toBe(401);
  });
});

describe('meeting kind in open mode', () => {
  it('refuses practice while a real meeting is open and leaves the real path unchanged', async () => {
    const { app, port } = await openModeApp();

    const opened = await request(port, '/api/meeting/open', 'POST');
    expect(opened.status).toBe(200);
    expect(app.session.kind()).toBe('real');

    const refused = await practiceJoin(port, 'Alice');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      realInProgress: true,
      error: 'A team meeting is in progress right now. Try practice again later.',
    });

    // A real participant still joins the open meeting exactly as before (first arrival, no code).
    const realJoin = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'producer',
      kind: 'real',
    });
    expect(realJoin.status).toBe(200);
    expect(app.session.kind()).toBe('real');
  });

  it('keeps the legacy plain join working and records it as a real meeting', async () => {
    const { app, port } = await openModeApp();

    const legacy = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'producer',
    });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { started: boolean }).started).toBe(false);
    expect(app.session.kind()).toBe('real');
  });

  it('frees a practice meeting once its visitor leaves, and the next practice visitor gets a fresh one', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await openModeApp({
      roomRoster: async () => people,
      rejoinGraceMs: 40,
      admissionReservationMs: 0,
    });
    await connectService(port);

    const first = await practiceJoin(port, 'Alice');
    expect(first.status).toBe(200);
    people = [{ name: 'Alice' }];
    const started = await request(port, '/api/meeting/start', 'POST');
    expect(started.status).toBe(200);
    expect(app.session.phase()).toBe('running');

    // Alice leaves. The existing empty-room grace prunes her and abandons the meeting.
    people = [];
    await waitFor(() => (app.session.abandoned() ? true : undefined), 'the empty-room grace to end');
    expect(app.session.holders()).toHaveLength(0);

    const second = await practiceJoin(port, 'Ben');
    expect(second.status).toBe(200);
    expect(app.session.kind()).toBe('practice');
    expect(app.session.holders()).toHaveLength(1);
    expect(app.session.holders()[0]?.name).toBe('ben');
    expect(app.session.phase()).toBe('lobby');
  });

  it('clears the kind when a practice meeting is ended', async () => {
    const { app, port } = await openModeApp();

    expect((await practiceJoin(port, 'Alice')).status).toBe(200);
    expect(app.session.kind()).toBe('practice');

    const ended = await request(port, '/api/meeting/end-practice', 'POST');
    expect(ended.status).toBe(200);
    expect(app.session.kind()).toBeUndefined();
    expect(app.session.phase()).toBe('lobby');
    expect(app.session.holders()).toHaveLength(0);

    // With no practice meeting left, there is nothing to end.
    expect((await request(port, '/api/meeting/end-practice', 'POST')).status).toBe(409);
  });
});
