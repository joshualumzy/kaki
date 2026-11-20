import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  DEFAULT_MEETING_PACE,
  defaultMeetingSetup,
  type KakiEvent,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { createFakeLlm } from '../src/llm';
import { loadScenario } from '../src/loadScenario';
import { createMeetingCodeSource } from '../src/meetingCode';
import { portOf, settle, waitFor } from './helpers';
import { testScenario } from './fixtures/scenario';

const CODE = 'K7M2Q9';
const TOKEN = 'local-test-runner-token';

type SocketResult = { ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number };

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

/** The real pack, but the owner has made the two human seats and kept the pack's roles. */
function twoPersonSetup(pack: Scenario): MeetingSetup {
  return {
    ...defaultMeetingSetup(pack),
    title: 'Opening huddle',
    agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'producer' }],
    seats: [
      { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
      { displayName: 'Arjun', roleId: 'lead_programmer', kind: 'person' },
    ],
    pace: { ...DEFAULT_MEETING_PACE },
  };
}

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

async function humanOnlyApp(): Promise<{ app: KakiApp; port: number; llm: ReturnType<typeof createFakeLlm> }> {
  const pack = await loadScenario('kopitiam');
  const llm = createFakeLlm(() => JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [] }));
  const app = await createApp({
    scenario: pack,
    modules: [createMeetingModule({ llm, notetakerIntervalMs: 40 })],
    roomRoster: async () => [],
  });
  apps.push(app);
  return { app, port: portOf(app), llm };
}

async function humanOnlyMeeting(): Promise<{ app: KakiApp; port: number; llm: ReturnType<typeof createFakeLlm> }> {
  const { app, port, llm } = await humanOnlyApp();
  const put = await fetch(`http://127.0.0.1:${port}/api/setup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(twoPersonSetup(await loadScenario('kopitiam'))),
  });
  expect(put.status).toBe(200);
  const first = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'room', participantName: 'Alice', participantRole: 'producer' }),
  });
  expect(first.status).toBe(200);
  const code = ((await first.json()) as { meetingCode: string }).meetingCode;
  const second = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'room',
      participantName: 'Ben',
      participantRole: 'lead_programmer',
      meetingCode: code,
    }),
  });
  expect(second.status).toBe(200);
  expect(app.session.holders()).toHaveLength(2);
  // No service socket is opened: a human-only meeting needs no AI runner at all.
  const started = await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' });
  expect(started.status).toBe(200);
  await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
  return { app, port, llm };
}

function humanLine(text: string, clientLineId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'HUMAN_LINE', text, source: 'typed', clientLineId, ...extra });
}

describe('human-only meetings record people\'s lines', () => {
  it('writes speech and typed lines with the setup seat names, feeds the notetaker, and dedupes', async () => {
    const { port, llm } = await humanOnlyMeeting();
    const screen = await connect(port, 'screen');
    const producer = await connect(port, 'producer');
    const programmer = await connect(port, 'lead_programmer');
    if (!screen.ok || !producer.ok || !programmer.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, producer.ws, programmer.ws);

    producer.ws.send(humanLine('I checked the front counter this morning.', 'line-1'));
    // A spoofed speaker field must never decide who said it.
    programmer.ws.send(
      JSON.stringify({
        type: 'HUMAN_LINE',
        text: 'The laptop campers bought one kopi each.',
        source: 'speech',
        clientLineId: 'line-2',
        speaker: 'Sam',
      }),
    );
    // A retry with the same id is the same line, not a second one.
    producer.ws.send(humanLine('The queue was out the door.', 'line-3'));
    producer.ws.send(humanLine('The queue was out the door.', 'line-3'));

    await waitFor(
      () => screen.messages.filter((event) => event.type === 'TRANSCRIPT_CHUNK').length >= 3 ? true : undefined,
      'three transcript lines',
    );
    await settle(50);
    const lines = screen.messages.filter(
      (event): event is Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }> =>
        event.type === 'TRANSCRIPT_CHUNK',
    );
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => [line.payload.speaker, line.payload.text])).toEqual(
      expect.arrayContaining([
        ['Wei Ling', 'I checked the front counter this morning.'],
        ['Arjun', 'The laptop campers bought one kopi each.'],
        ['Wei Ling', 'The queue was out the door.'],
      ]),
    );

    await waitFor(
      () =>
        llm.calls.some((messages) =>
          messages.some(
            (message) =>
              message.content.includes('I checked the front counter this morning.') &&
              message.content.includes('The laptop campers bought one kopi each.'),
          ),
        )
          ? true
          : undefined,
      'the notetaker to receive both people\'s lines',
    );
  });

  it('refuses human lines in the lobby and after the meeting has ended', async () => {
    const { app, port } = await humanOnlyApp();
    const pack = await loadScenario('kopitiam');
    const put = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(twoPersonSetup(pack)),
    });
    expect(put.status).toBe(200);
    const first = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'room', participantName: 'Alice', participantRole: 'producer' }),
    });
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomName: 'room',
        participantName: 'Ben',
        participantRole: 'lead_programmer',
        meetingCode: code,
      }),
    });
    const producer = await connect(port, 'producer');
    if (!producer.ok) throw new Error('producer socket did not open');
    sockets.push(producer.ws);

    producer.ws.send(humanLine('Too early.', 'lobby-line'));
    const lobby = await waitFor(
      () => producer.messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'a lobby rejection',
    );
    expect(lobby).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: 'The meeting is not running' } });

    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const screen = await connect(port, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the meeting to end');

    producer.ws.send(humanLine('Too late.', 'ended-line'));
    const ended = await waitFor(
      () => producer.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'an ended rejection',
    );
    expect(ended).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: 'The meeting is not running' } });
  });
});

describe('human lines are not held for a human-only meeting but are held with an AI cast', () => {
  it('dispatches a human-only task and holds an AI meeting task until its topic settles', async () => {
    // Human-only: the same suggestion is released by the normal non-held rule.
    const human = await humanOnlyMeeting();
    const humanTask = human.app.tasks.suggest({
      title: 'Post the opening checklist',
      context: 'The room agreed on the opening checklist.',
      suggestedAssignee: 'producer',
      actionKind: 'mattermost_post',
      agendaItemTitle: 'Opening checklist',
    });
    expect(human.app.tasks.get(humanTask.id)?.status).toBe('DISPATCHED');

    // With an AI cast, the Director owns TOPIC_SETTLED, so the card stays held until it arrives.
    const pack = await loadScenario('kopitiam');
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createApp({
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => [],
    });
    apps.push(app);
    const port = portOf(app);
    const service = await connect(port, 'service');
    if (!service.ok) throw new Error('service socket did not open');
    sockets.push(service.ws);
    service.ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        kind?: string;
        request?: { requestId?: string; attempt?: string; meetingId?: string };
      };
      const { requestId, attempt, meetingId } = message.request ?? {};
      if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) return;
      service.ws.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
    });
    const joined = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'room', participantName: 'Booth Playtest', participantRole: 'lead_programmer' }),
    });
    const joinedBody = await joined.json().catch(() => undefined);
    expect(joined.status, JSON.stringify(joinedBody)).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the AI meeting to run');

    const aiTask = app.tasks.suggest({
      title: 'Send the breakfast seat sign',
      context: 'The room agreed on the seat crunch.',
      suggestedAssignee: 'lead_programmer',
      actionKind: 'mattermost_post',
      agendaItemTitle: pack.agenda[2]!.title,
    });
    expect(app.tasks.get(aiTask.id)?.status).toBe('SUGGESTED');
    await settle(30);
    expect(app.tasks.get(aiTask.id)?.status).toBe('SUGGESTED');
    app.hub.publish({
      type: 'TOPIC_SETTLED',
      audience: { kind: 'screen' },
      payload: { title: pack.agenda[2]!.title },
    });
    expect(app.tasks.get(aiTask.id)?.status).toBe('DISPATCHED');
  });
});

describe('human-line security with sign-in on', () => {
  async function authOnApp(): Promise<{
    app: KakiApp;
    port: number;
    clock: ReturnType<typeof createAgendaClock>;
    setPeople(people: Array<{ name: string }>): void;
  }> {
    const store: AuthStore = createMemoryAuthStore();
    await store.createUser({ email: 'host@example.com', passwordHash: await hashPassword('host-password') });
    const meetingCode = createMeetingCodeSource(CODE);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
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

  it('refuses anonymous sockets, another seat, another meeting, and lines outside a running meeting', async () => {
    const { app, port, setPeople } = await authOnApp();
    const host = cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
    const chef = cookieFrom(await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room', participantName: 'Ada', participantRole: 'chef', meetingCode: CODE,
    }));
    const cashier = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'cashier' }));
    setPeople([{ name: 'Ada' }, { name: 'Bao' }]);

    expect((await connect(port, 'chef')).ok).toBe(false);
    expect((await connect(port, 'chef', cashier)).ok).toBe(false);

    const phone = await connect(port, 'chef', chef);
    if (!phone.ok) throw new Error('chef socket did not open');
    sockets.push(phone.ws);
    phone.ws.send(humanLine('Before Start.', 'auth-lobby'));
    await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'the lobby refusal',
    );

    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, 'screen', host);
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    phone.ws.send(humanLine('The till is short.', 'auth-line', { speaker: 'Sam' }));
    const accepted = await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'The till is short.'),
      'the seated line',
    );
    expect(accepted).toMatchObject({ payload: { speaker: 'Ada' } });

    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the auth meeting to end');
    phone.ws.send(humanLine('After End.', 'auth-ended'));
    await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'the ended refusal',
    );

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitFor(() => (app.session.phase() === 'lobby' ? true : undefined), 'the reset');
    expect((await connect(port, 'chef', chef)).ok).toBe(false);
  });

  it('accepts a recognised line through the service route and refuses a guest session', async () => {
    const { app, port, setPeople } = await authOnApp();
    const host = cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
    const chef = cookieFrom(await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room', participantName: 'Ada', participantRole: 'chef', meetingCode: CODE,
    }));
    setPeople([{ name: 'Ada' }]);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, 'screen', host);
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    const line = {
      seat: 'chef',
      text: 'This was recognised by the server.',
      source: 'speech',
      clientLineId: 'service-line',
    };
    const accepted = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(line),
    });
    expect(accepted.status).toBe(200);
    const transcript = await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === line.text),
      'the service transcript line',
    );
    expect(transcript).toMatchObject({ payload: { speaker: 'Ada' } });

    const refused = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: chef },
      body: JSON.stringify({ ...line, clientLineId: 'guest-line' }),
    });
    expect(refused.status).toBe(401);
  });
});
