import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import type { MeetingPauseControl } from '../src/host';
import { createMeetingModule } from '../src/host/meeting';
import { createMeetingCodeSource } from '../src/meetingCode';
import { testScenario } from './fixtures/scenario';
import { portOf, settle, waitFor } from './helpers';

const CODE = 'K7M2Q9';
const TOKEN = 'local-test-runner-token';

type SocketResult = { ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number };

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie');
  return value;
}

function connect(port: number, role: string, cookie?: string): Promise<SocketResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`, { headers });
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ok: true, ws, messages }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once('error', () => resolve({ ok: false, status: 0 }));
  });
}

function pauseControl(clock: ReturnType<typeof createAgendaClock>): MeetingPauseControl {
  return {
    paused: () => {
      const snapshot = clock.snapshot();
      return snapshot.started ? snapshot.paused === true : undefined;
    },
    kind: () => clock.snapshot().pauseKind,
    pause: (kind) => clock.pause(kind),
    resume: () => clock.resume(),
  };
}

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

async function authOnApp(
  store: AuthStore,
): Promise<{
  app: KakiApp;
  port: number;
  clock: ReturnType<typeof createAgendaClock>;
  setPeople(people: Array<{ name: string }>): void;
}> {
  await store.createUser({ email: 'host@example.com', passwordHash: await hashPassword('host-password') });
  const meetingCode = createMeetingCodeSource(CODE);
  const auth = createAuth({ store, roles: ['chef', 'cashier'], meetingCode });
  const clock = createAgendaClock({ agenda: testScenario.agenda });
  let people: Array<{ name: string }> = [];
  const app = await createApp({
    scenario: testScenario,
    auth,
    meetingCode,
    serviceToken: TOKEN,
    modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
    roomRoster: async () => people,
    rejoinGraceMs: 60_000,
    rejoinPollMs: 20,
    emptyRoomPauseMs: 20,
    meetingAgendaIndex: () => (clock.snapshot().started ? clock.snapshot().agendaIndex : undefined),
    meetingPaused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
    meetingPause: pauseControl(clock),
  });
  apps.push(app);
  return { app, port: portOf(app), clock, setPeople: (next) => { people = next; } };
}

async function request(port: number, path: string, method = 'GET', body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function loginHost(port: number): Promise<string> {
  return cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
}

async function joinByCode(port: number, role: string): Promise<string> {
  const response = await request(port, '/api/livekit/token', 'POST', {
    roomName: 'room',
    participantName: 'Ada',
    participantRole: role,
    meetingCode: CODE,
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function runnerState(port: number): Promise<{ paused: boolean; pauseKind?: 'empty-room' | 'person' }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/runner/meeting-state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { paused: boolean; pauseKind?: 'empty-room' | 'person' };
}

describe('a person pauses the meeting over their own hub socket', () => {
  it('lets a seated person pause and resume, and publishes the record and runner snapshot', async () => {
    const store = createMemoryAuthStore();
    const { app, port, clock, setPeople } = await authOnApp(store);
    const chef = await joinByCode(port, 'chef');
    setPeople([{ name: 'Ada' }]);
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const phone = await connect(port, 'chef', chef);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    const screen = await connect(port, 'screen', host);
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    sockets.push(screen.ws);

    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(
      () => (clock.snapshot().paused === true && clock.snapshot().pauseKind === 'person' ? true : undefined),
      'the person pause',
    );
    const pausedRecord = await waitFor(
      () => screen.messages.find((event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.paused === true),
      'the paused record',
    );
    expect(pausedRecord).toMatchObject({ payload: { paused: true, pauseKind: 'person' } });
    expect((await runnerState(port)).pauseKind).toBe('person');

    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the person resume');
    await waitFor(
      () =>
        screen.messages.some((event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.paused !== true)
          ? true
          : undefined,
      'the resumed record',
    );
    expect((await runnerState(port)).paused).toBe(false);
  });

  it('keeps a person\'s pause across their hub socket reconnecting', async () => {
    const store = createMemoryAuthStore();
    const { app, port, clock, setPeople } = await authOnApp(store);
    const chef = await joinByCode(port, 'chef');
    setPeople([{ name: 'Ada' }]);
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const first = await connect(port, 'chef', chef);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => (clock.snapshot().pauseKind === 'person' ? true : undefined), 'the person pause');
    // The hub socket drops (a phone changing networks); the server owns the pause, so it survives.
    first.ws.close();
    await settle(30);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });
    expect((await runnerState(port)).paused).toBe(true);

    const back = await connect(port, 'chef', chef);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    sockets.push(back.ws);
    await settle(30);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });
    back.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the resume');
  });

  it('keeps a person\'s Stop when an empty-room pause is holding', async () => {
    const store = createMemoryAuthStore();
    const { app, port, clock } = await authOnApp(store);
    const chef = await joinByCode(port, 'chef');
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const phone = await connect(port, 'chef', chef);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    await waitFor(() => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined), 'the empty-room pause');

    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => (clock.snapshot().pauseKind === 'person' ? true : undefined), 'the Stop to own the pause');
    await settle(40);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });
  });

  it('refuses an anonymous socket', async () => {
    const store = createMemoryAuthStore();
    const { app, port, clock } = await authOnApp(store);
    expect((await connect(port, 'chef')).ok).toBe(false);
    expect((await connect(port, 'screen')).ok).toBe(false);
    expect(clock.snapshot().paused).toBeFalsy();
    expect(app.session.phase()).toBe('lobby');
  });

  it('refuses a socket for another seat and a seat from the previous meeting', async () => {
    const store = createMemoryAuthStore();
    const { app, port, clock, setPeople } = await authOnApp(store);
    const chef = await joinByCode(port, 'chef');
    const host = await loginHost(port);
    const cashierResponse = await request(port, '/api/join', 'POST', { code: CODE, role: 'cashier' });
    expect(cashierResponse.status).toBe(200);
    const cashier = cookieFrom(cashierResponse);
    setPeople([{ name: 'Ada' }, { name: 'Bao' }]);

    // A session that holds the cashier seat may not drive the chef socket.
    expect((await connect(port, 'chef', cashier)).ok).toBe(false);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    // The host works the shared screen; the meeting's own phone can pause.
    const phone = await connect(port, 'chef', chef);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    const screen = await connect(port, 'screen', host);
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitFor(() => (app.session.phase() === 'lobby' ? true : undefined), 'the reset');

    // The old seat belongs to the previous meeting; its cookie can no longer open the role.
    expect((await connect(port, 'chef', chef)).ok).toBe(false);
    await settle(40);
    expect(clock.snapshot().paused).toBeFalsy();
  });

  it('refuses a role socket that does not hold a seat, even with auth off', async () => {
    const clock = createAgendaClock({ agenda: testScenario.agenda });
    let people: Array<{ name: string }> = [];
    const app = await createApp({
      scenario: testScenario,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      meetingPaused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
      meetingPause: pauseControl(clock),
    });
    apps.push(app);
    const port = portOf(app);
    expect((await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room',
      participantName: 'Ada',
      participantRole: 'chef',
    })).status).toBe(200);
    people = [{ name: 'Ada' }];
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const phone = await connect(port, 'chef');
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    app.session.pruneHolders();
    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => phone.messages.find((event) => event.type === 'COMMAND_REJECTED'), 'a rejection');
    expect(clock.snapshot().paused).toBeFalsy();

    app.session.addHolder({ name: 'Ada', seat: 'chef' });
    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => (clock.snapshot().paused === true ? true : undefined), 'the seated person to pause');
  });
});
