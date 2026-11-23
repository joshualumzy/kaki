import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import type { KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import type { MeetingPauseControl } from '../src/host';
import { createMeetingModule } from '../src/host/meeting';
import type { MeetingRow } from '../src/meeting/types';
import { testScenario } from './fixtures/scenario';
import {
  createTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  type TestAppWithMeeting,
} from './helpers';

const TOKEN = 'local-test-runner-token';

type SocketResult = { ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number };

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie');
  return value;
}

function connect(app: TestAppWithMeeting, query: string, cookie?: string): Promise<SocketResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const ws = new WebSocket(meetingWsUrl(portOf(app), app.meetingId, query), { headers });
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

async function request(
  app: TestAppWithMeeting,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(meetingUrl(app, app.meetingId, path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface AuthSetup {
  app: TestAppWithMeeting;
  clock: ReturnType<typeof createAgendaClock>;
  setPeople(people: Array<{ name: string }>): void;
  ownerCookie: string;
}

/** A signed-in product account; a real meeting's owner is an account, not a password host. */
async function signInGoogle(store: AuthStore, name: string): Promise<{ userId: string; cookie: string }> {
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
  return { userId: user.id, cookie: `kaki_session=${token}` };
}

async function authOnApp(
  store: AuthStore,
  options: { people?: Array<{ name: string }> } = {},
): Promise<AuthSetup> {
  const owner = await signInGoogle(store, 'Ada Owner');
  const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
  const clock = createAgendaClock({ agenda: testScenario.agenda });
  let people: Array<{ name: string }> = options.people ?? [];
  const app = (await createTestApp({
    speechRecognition: 'browser',
    scenario: testScenario,
    auth,
    serviceToken: TOKEN,
    meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })], {
      meetingAgendaIndex: () => (clock.snapshot().started ? clock.snapshot().agendaIndex : undefined),
      meetingPaused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
      meetingPause: pauseControl(clock),
    }),
    roomRoster: async () => people,
    rejoinGraceMs: 60_000,
    rejoinPollMs: 20,
    emptyRoomPauseMs: 20,
  })) as TestAppWithMeeting;
  apps.push(app);
  const row: MeetingRow = await app.registry.create({
    workspaceId: 'workspace-1',
    ownerUserId: owner.userId,
    title: 'Lunch service',
    agenda: testScenario.agenda.map((item) => ({
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: 'everyone',
    })),
  });
  const instance = await app.registry.get(row.id);
  if (instance === undefined) throw new Error(`the real meeting ${row.id} did not load`);
  Object.assign(app, {
    id: instance.id,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
    meetingId: row.id,
  });
  return {
    app,
    clock,
    setPeople: (next) => {
      people = next;
    },
    ownerCookie: owner.cookie,
  };
}

async function joinGuest(app: TestAppWithMeeting, name: string): Promise<string> {
  const response = await request(app, '/join', 'POST', { name });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function enterRoom(app: TestAppWithMeeting, name: string, cookie: string): Promise<{ cookie: string; seat: string }> {
  const response = await request(app, '/api/livekit/token', 'POST', { participantName: name }, cookie);
  expect(response.status).toBe(200);
  const holder = app.session.holders().find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (holder === undefined) throw new Error(`${name} did not take a seat`);
  return { cookie: cookieFrom(response), seat: holder.seat };
}

async function runnerState(app: TestAppWithMeeting): Promise<{ paused: boolean; pauseKind?: 'empty-room' | 'person' }> {
  const response = await fetch(meetingUrl(app, app.meetingId, '/api/runner/meeting-state'), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { paused: boolean; pauseKind?: 'empty-room' | 'person' };
}

async function joinBySeat(app: TestAppWithMeeting, name: string): Promise<{ cookie: string; seat: string }> {
  return enterRoom(app, name, await joinGuest(app, name));
}

describe('a person pauses the meeting over their own hub socket', () => {
  it('lets a seated person pause and resume, and publishes the record and runner snapshot', async () => {
    const store = createMemoryAuthStore();
    const { app, clock, setPeople, ownerCookie: host } = await authOnApp(store);
    const ada = await joinBySeat(app, 'Ada');
    setPeople([{ name: 'Ada' }]);
    expect((await request(app, '/api/meeting/start', 'POST', undefined, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const phone = await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    const screen = await connect(app, 'audience=screen', host);
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
    expect((await runnerState(app)).pauseKind).toBe('person');

    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the person resume');
    await waitFor(
      () =>
        screen.messages.some((event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.paused !== true)
          ? true
          : undefined,
      'the resumed record',
    );
    expect((await runnerState(app)).paused).toBe(false);
  });

  it('keeps a person\'s pause across their hub socket reconnecting', async () => {
    const store = createMemoryAuthStore();
    const { app, clock, setPeople, ownerCookie: host } = await authOnApp(store);
    const ada = await joinBySeat(app, 'Ada');
    setPeople([{ name: 'Ada' }]);
    expect((await request(app, '/api/meeting/start', 'POST', undefined, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const first = await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => (clock.snapshot().pauseKind === 'person' ? true : undefined), 'the person pause');
    // The hub socket drops (a phone changing networks); the server owns the pause, so it survives.
    first.ws.close();
    await settle(30);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });
    expect((await runnerState(app)).paused).toBe(true);

    const back = await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie);
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
    const { app, clock, ownerCookie: host } = await authOnApp(store);
    const ada = await joinBySeat(app, 'Ada');
    expect((await request(app, '/api/meeting/start', 'POST', undefined, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const phone = await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie);
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
    const { app, clock } = await authOnApp(store);
    expect((await connect(app, 'role=chef')).ok).toBe(false);
    expect((await connect(app, 'audience=screen')).ok).toBe(false);
    expect(clock.snapshot().paused).toBeFalsy();
    expect(app.session.phase()).toBe('lobby');
  });

  it('refuses a socket for another seat and a seat from the previous meeting', async () => {
    const store = createMemoryAuthStore();
    const { app, clock, setPeople, ownerCookie: host } = await authOnApp(store);
    const ada = await joinBySeat(app, 'Ada');
    const bao = await joinBySeat(app, 'Bao');
    setPeople([{ name: 'Ada' }, { name: 'Bao' }]);

    // A session that holds Bao's seat may not drive Ada's socket.
    expect((await connect(app, `role=${encodeURIComponent(ada.seat)}`, bao.cookie)).ok).toBe(false);
    expect((await request(app, '/api/meeting/start', 'POST', undefined, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    // The host works the shared screen; the meeting's own phone can pause.
    const phone = await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    const screen = await connect(app, 'audience=screen', host);
    expect(screen.ok).toBe(true);
    if (!screen.ok) return;
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitFor(() => (app.session.phase() === 'lobby' ? true : undefined), 'the reset');

    // The old seat belongs to the previous meeting; its session can no longer open the role.
    expect((await connect(app, `role=${encodeURIComponent(ada.seat)}`, ada.cookie)).ok).toBe(false);
    await settle(40);
    expect(clock.snapshot().paused).toBeFalsy();
  });

  it('refuses a role socket that does not hold a seat, even with auth off', async () => {
    const clock = createAgendaClock({ agenda: testScenario.agenda });
    const app = (await createTestApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })], {
        meetingPaused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
        meetingPause: pauseControl(clock),
      }),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    })) as TestAppWithMeeting;
    apps.push(app);
    const row = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Lunch service',
      agenda: testScenario.agenda.map((item) => ({
        title: item.title,
        minutes: item.minutes,
        ownerRoleId: 'everyone',
      })),
    });
    const instance = await app.registry.get(row.id);
    if (instance === undefined) throw new Error(`the real meeting ${row.id} did not load`);
    Object.assign(app, {
      id: instance.id,
      instance,
      hub: instance.hub,
      tasks: instance.tasks,
      session: instance.session,
      memory: instance.memory,
      roomName: instance.roomName,
      meetingId: row.id,
    });

    expect((await request(app, '/api/livekit/token', 'POST', { participantName: 'Ada' })).status).toBe(200);
    const seat = app.session.holders()[0]?.seat;
    if (seat === undefined) throw new Error('Ada did not take a seat');
    expect((await request(app, '/api/meeting/start', 'POST')).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const phone = await connect(app, `role=${encodeURIComponent(seat)}`);
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    sockets.push(phone.ws);
    app.session.pruneHolders();
    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => phone.messages.find((event) => event.type === 'COMMAND_REJECTED'), 'a rejection');
    expect(clock.snapshot().paused).toBeFalsy();

    app.session.addHolder({ name: 'Ada', seat });
    phone.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => (clock.snapshot().paused === true ? true : undefined), 'the seated person to pause');
  });
});
