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
import { createFakeLlm } from '../src/services/llm';
import { loadScenario } from '../src/core/loadScenario';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { portOf, settle, waitFor } from './helpers';
import { testScenario } from './fixtures/scenario';

const CODE = 'K7M2Q9';
const TOKEN = 'local-test-runner-token';
/** The sample workspace's Mattermost connection, so a chat card has somewhere real to go. */
const mattermostEnv = {
  MATTERMOST_URL: 'http://mattermost.test',
  MATTERMOST_TOKEN: 'secret-token',
  MATTERMOST_TEAM: 'kopitiam',
  MATTERMOST_CHANNEL: 'launch',
};

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
    agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'operations_director' }],
    seats: [
      { displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' },
      { displayName: 'Arjun', roleId: 'tech_pos_lead', kind: 'person' },
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

async function humanOnlyApp(
  speechRecognition: 'server' | 'browser' = 'browser',
): Promise<{ app: KakiApp; port: number; llm: ReturnType<typeof createFakeLlm> }> {
  const pack = await loadScenario('kopitiam');
  const llm = createFakeLlm(() => JSON.stringify({ newQuestions: [], answeredQuestionIds: [], answeredQuestions: [], newTasks: [], revisions: [] }));
  const app = await createApp({
    scenario: pack,
    actionTools: { env: mattermostEnv },
    modules: [createMeetingModule({ llm, notetakerIntervalMs: 40 })],
    roomRoster: async () => [],
    speechRecognition,
  });
  apps.push(app);
  return { app, port: portOf(app), llm };
}

async function seatTwoPeople(app: KakiApp, port: number, setup?: MeetingSetup): Promise<void> {
  const chosen = setup ?? twoPersonSetup(await loadScenario('kopitiam'));
  const put = await fetch(`http://127.0.0.1:${port}/api/setup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chosen),
  });
  expect(put.status).toBe(200);
  const opened = await fetch(`http://127.0.0.1:${port}/api/meeting/open`, { method: 'POST' });
  expect(opened.status).toBe(200);
  const first = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'room', participantName: 'Alice', participantRole: 'operations_director' }),
  });
  expect(first.status).toBe(200);
  const code = ((await first.json()) as { meetingCode: string }).meetingCode;
  const second = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'room',
      participantName: 'Ben',
      participantRole: 'tech_pos_lead',
      meetingCode: code,
    }),
  });
  expect(second.status).toBe(200);
  expect(app.session.holders()).toHaveLength(2);
}

async function humanOnlyMeeting(
  options: { speechRecognition?: 'server' | 'browser'; setup?: MeetingSetup } = {},
): Promise<{ app: KakiApp; port: number; llm: ReturnType<typeof createFakeLlm> }> {
  const { app, port, llm } = await humanOnlyApp(options.speechRecognition ?? 'browser');
  await seatTwoPeople(app, port, options.setup);
  // No service socket is opened: browser-side recognition needs no AI runner at all.
  const started = await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' });
  expect(started.status).toBe(200);
  await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
  return { app, port, llm };
}

function serviceSocket(port: number, stt: 'server' | 'browser' = 'server'): Promise<SocketResult> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service&stt=${stt}`);
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

function humanLine(text: string, clientLineId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'HUMAN_LINE', text, source: 'typed', clientLineId, ...extra });
}

describe('human-only meetings record people\'s lines', () => {
  it('writes speech and typed lines with the admitted person\'s name, sets the seat as role metadata, feeds the notetaker, and dedupes', async () => {
    const { port, llm } = await humanOnlyMeeting();
    const screen = await connect(port, 'screen');
    const operations_director = await connect(port, 'operations_director');
    const programmer = await connect(port, 'tech_pos_lead');
    if (!screen.ok || !operations_director.ok || !programmer.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, operations_director.ws, programmer.ws);

    operations_director.ws.send(humanLine('I checked the front counter this morning.', 'line-1'));
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
    operations_director.ws.send(humanLine('The queue was out the door.', 'line-3'));
    operations_director.ws.send(humanLine('The queue was out the door.', 'line-3'));

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
    expect(lines.map((line) => [line.payload.speaker, line.payload.speakerRole, line.payload.text])).toEqual(
      expect.arrayContaining([
        ['Alice', 'operations_director', 'I checked the front counter this morning.'],
        ['Ben', 'tech_pos_lead', 'The laptop campers bought one kopi each.'],
        ['Alice', 'operations_director', 'The queue was out the door.'],
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

  it('refuses human lines in the lobby and after the meeting has ended, and logs the refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, port } = await humanOnlyApp();
    const pack = await loadScenario('kopitiam');
    const put = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(twoPersonSetup(pack)),
    });
    expect(put.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const first = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'room', participantName: 'Alice', participantRole: 'operations_director' }),
    });
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomName: 'room',
        participantName: 'Ben',
        participantRole: 'tech_pos_lead',
        meetingCode: code,
      }),
    });
    const operations_director = await connect(port, 'operations_director');
    if (!operations_director.ok) throw new Error('operations_director socket did not open');
    sockets.push(operations_director.ws);

    operations_director.ws.send(humanLine('Too early.', 'lobby-line'));
    const lobby = await waitFor(
      () => operations_director.messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'a lobby rejection',
    );
    expect(lobby).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: 'The meeting is not running' } });
    expect(
      warn.mock.calls.some(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('refused HUMAN_LINE') &&
          message.includes('The meeting is not running'),
      ),
    ).toBe(true);

    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const screen = await connect(port, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the meeting to end');

    operations_director.ws.send(humanLine('Too late.', 'ended-line'));
    const ended = await waitFor(
      () => operations_director.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'an ended rejection',
    );
    expect(ended).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: 'The meeting is not running' } });
  });
});

describe('a renamed person seat keeps its role', () => {
  it('writes the admitted name with the seat role, so talk time and the notetaker still know who spoke', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = twoPersonSetup(pack);
    setup.seats = setup.seats.map((seat) =>
      seat.roleId === 'operations_director' ? { ...seat, displayName: 'Alice Tan' } : seat,
    );
    const { port, llm } = await humanOnlyMeeting({ setup });
    const screen = await connect(port, 'screen');
    const operations_director = await connect(port, 'operations_director');
    if (!screen.ok || !operations_director.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, operations_director.ws);

    operations_director.ws.send(humanLine('I checked the front counter this morning.', 'renamed-line'));
    const line = await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK'),
      'the renamed seat transcript line',
    );
    expect(line).toMatchObject({
      payload: { speaker: 'Alice', speakerRole: 'operations_director', text: 'I checked the front counter this morning.' },
    });

    const record = await waitFor(
      () =>
        screen.messages.find(
          (event) =>
            event.type === 'MEETING_RECORD_UPDATED' &&
            (event.payload.speakerTalkSeconds.operations_director ?? 0) >= 1,
        ),
      'talk time for the renamed seat',
    );
    expect(record).toMatchObject({ payload: { speakerTalkSeconds: { operations_director: expect.any(Number) } } });

    const operationsDirectorLabel = pack.roles.find((role) => role.id === 'operations_director')?.label;
    expect(operationsDirectorLabel).toBeDefined();
    await waitFor(
      () =>
        llm.calls.some((messages) =>
          messages.some((message) => message.content.includes(`Alice (${operationsDirectorLabel})`)),
        )
          ? true
          : undefined,
      'the notetaker line to carry the role',
    );
  });
});

describe('a practice room matches speech by the name identity its token issues', () => {
  it('accepts a server-recognised practice line under its display name', async () => {
    const { port } = await humanOnlyMeeting();
    const screen = await connect(port, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);
    const meetingId = ((await (await fetch(`http://127.0.0.1:${port}/api/meeting/state`)).json()) as { meetingId: string })
      .meetingId;
    const text = 'The practice line still lands.';
    const response = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        meetingId,
        participantIdentity: 'Alice',
        seat: 'operations_director',
        text,
        source: 'speech',
        clientLineId: 'practice-speech',
      }),
    });
    expect(response.status).toBe(200);
    const chunk = await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === text),
      'the practice speech line',
    );
    expect(chunk).toMatchObject({ payload: { speaker: 'Alice', speakerRole: 'operations_director' } });
  });
});

describe('speech recording needs the runner when recognition is server-side', () => {
  it('refuses Start in a human-only meeting with no runner, with a clear reason', async () => {
    const { app, port } = await humanOnlyApp('server');
    await seatTwoPeople(app, port);
    const refused = await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error?: string }).error).toMatch(/Speech recording isn't ready/);
    expect(app.session.phase()).toBe('lobby');
  });

  it('opens with a server-side runner and says so when that runner drops mid-meeting', async () => {
    const { app, port } = await humanOnlyApp('server');
    const service = await serviceSocket(port);
    if (!service.ok) throw new Error('service socket did not open');
    sockets.push(service.ws);
    await seatTwoPeople(app, port);
    const screen = await connect(port, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    const started = await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' });
    expect(started.status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    await waitFor(
      () => screen.messages.find((event) => event.type === 'SPEECH_RECORDING' && event.payload.recording === true),
      'the recording-on notice',
    );

    service.ws.close();
    await waitFor(
      () => screen.messages.find((event) => event.type === 'SPEECH_RECORDING' && event.payload.recording === false),
      'the recording-off notice when the runner drops',
    );
  });
});

describe('human lines are bounded, rate limited and deduped per seat', () => {
  it('refuses typed and speech lines beyond their caps with a clear reason', async () => {
    const { port } = await humanOnlyMeeting();
    const operations_director = await connect(port, 'operations_director');
    if (!operations_director.ok) throw new Error('operations_director socket did not open');
    sockets.push(operations_director.ws);

    operations_director.ws.send(humanLine('x'.repeat(501), 'too-long-typed'));
    const typed = await waitFor(
      () => operations_director.messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'the long typed line refusal',
    );
    expect(typed).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: expect.stringMatching(/too long/i) } });

    operations_director.ws.send(
      JSON.stringify({
        type: 'HUMAN_LINE',
        text: 'y'.repeat(2_001),
        source: 'speech',
        clientLineId: 'too-long-speech',
      }),
    );
    await waitFor(
      () =>
        operations_director.messages.filter(
          (event) => event.type === 'COMMAND_REJECTED' && /too long/i.test(event.payload.reason),
        ).length >= 2
          ? true
          : undefined,
      'the long speech line refusal',
    );
  });

  it('refuses a burst from one seat while another seat keeps its own dedupe memory', async () => {
    const { port } = await humanOnlyMeeting();
    const screen = await connect(port, 'screen');
    const operations_director = await connect(port, 'operations_director');
    const programmer = await connect(port, 'tech_pos_lead');
    if (!screen.ok || !operations_director.ok || !programmer.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, operations_director.ws, programmer.ws);

    operations_director.ws.send(humanLine('A line from the operations_director.', 'shared-id'));
    programmer.ws.send(humanLine('A line from the programmer.', 'shared-id'));
    await waitFor(
      () => screen.messages.filter((event) => event.type === 'TRANSCRIPT_CHUNK').length >= 2 ? true : undefined,
      'both seats to use the same line id',
    );

    for (let index = 0; index < 6; index += 1) {
      operations_director.ws.send(humanLine(`Burst line ${index}.`, `burst-${index}`));
    }
    const refused = await waitFor(
      () =>
        operations_director.messages.find(
          (event) => event.type === 'COMMAND_REJECTED' && /Too many lines/i.test(event.payload.reason),
        ),
      'the per-seat rate-limit refusal',
    );
    expect(refused).toMatchObject({ payload: { commandType: 'HUMAN_LINE' } });
  });
});

describe('human lines are not held for a human-only meeting but are held with an AI cast', () => {
  it('dispatches a human-only task and holds an AI meeting task until its topic settles', async () => {
    // Human-only: the same suggestion is released by the normal non-held rule.
    const human = await humanOnlyMeeting();
    const humanTask = human.app.tasks.suggest({
      title: 'Post the opening checklist',
      context: 'The room agreed on the opening checklist.',
      suggestedAssignee: 'operations_director',
      actionKind: 'mattermost_post',
      agendaItemTitle: 'Opening checklist',
    });
    await waitFor(
      () => (human.app.tasks.get(humanTask.id)?.status === 'DISPATCHED' ? true : undefined),
      'the human-only card to dispatch',
    );

    // With an AI cast, the Director owns TOPIC_SETTLED, so the card stays held until it arrives.
    const pack = await loadScenario('kopitiam');
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createApp({
      scenario: pack,
      actionTools: { env: mattermostEnv },
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
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const joined = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'room', participantName: 'Booth Playtest', participantRole: 'tech_pos_lead' }),
    });
    const joinedBody = await joined.json().catch(() => undefined);
    expect(joined.status, JSON.stringify(joinedBody)).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the AI meeting to run');

    const aiTask = app.tasks.suggest({
      title: 'Send the breakfast seat sign',
      context: 'The room agreed on the seat crunch.',
      suggestedAssignee: 'tech_pos_lead',
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
    await waitFor(
      () => (app.tasks.get(aiTask.id)?.status === 'DISPATCHED' ? true : undefined),
      'the settled AI card to dispatch',
    );
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
      speechRecognition: 'browser',
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
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
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

  it('refuses a held line tagged with another meeting or another seat', async () => {
    const { app, port, setPeople } = await authOnApp();
    const host = cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const chef = cookieFrom(await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room', participantName: 'Ada', participantRole: 'chef', meetingCode: CODE,
    }));
    setPeople([{ name: 'Ada' }]);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, 'screen', host);
    const phone = await connect(port, 'chef', chef);
    if (!screen.ok || !phone.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, phone.ws);

    phone.ws.send(humanLine('This belongs to an old meeting.', 'held-old-meeting', { meetingId: 'an-old-meeting' }));
    const wrongMeeting = await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && /different meeting/i.test(event.payload.reason)),
      'the old-meeting refusal',
    );
    expect(wrongMeeting).toMatchObject({ payload: { commandType: 'HUMAN_LINE' } });

    phone.ws.send(humanLine('The chef cannot speak as the cashier.', 'held-wrong-seat', { seat: 'cashier' }));
    await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && /different seat/i.test(event.payload.reason)),
      'the wrong-seat refusal',
    );

    await settle(50);
    expect(
      screen.messages.some(
        (event) =>
          event.type === 'TRANSCRIPT_CHUNK' &&
          (event.payload.text === 'This belongs to an old meeting.' ||
            event.payload.text === 'The chef cannot speak as the cashier.'),
      ),
    ).toBe(false);
  });

  it('records a signed-in host\'s own line when the host takes a seat', async () => {
    const { app, port, setPeople } = await authOnApp();
    const host = cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    // The owner joins their own seat: the host session now also carries that seat.
    const joined = await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room', participantName: 'Ada', participantRole: 'chef',
    }, host);
    expect(joined.status).toBe(200);
    const hostSeat = cookieFrom(joined);
    setPeople([{ name: 'Ada' }]);
    expect((await request(port, '/api/meeting/start', 'POST', {}, hostSeat)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');

    const seat = await connect(port, 'chef', hostSeat);
    const screen = await connect(port, 'screen', hostSeat);
    if (!seat.ok || !screen.ok) throw new Error('host sockets did not open');
    sockets.push(seat.ws, screen.ws);

    seat.ws.send(humanLine('I will confirm the stock count before lunch.', 'host-seat-line'));
    const accepted = await waitFor(
      () => screen.messages.find(
        (event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'I will confirm the stock count before lunch.',
      ),
      'the host seat line',
    );
    expect(accepted).toMatchObject({ payload: { speaker: 'Ada', speakerRole: 'chef' } });
  });

  it('accepts a recognised line through the service route and refuses a guest session', async () => {
    const { app, port, setPeople } = await authOnApp();
    const host = cookieFrom(await request(port, '/api/auth/login', 'POST', { email: 'host@example.com', password: 'host-password' }));
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const chef = cookieFrom(await request(port, '/api/livekit/token', 'POST', {
      roomName: 'room', participantName: 'Ada', participantRole: 'chef', meetingCode: CODE,
    }));
    setPeople([{ name: 'Ada' }]);
    expect((await request(port, '/api/meeting/start', 'POST', {}, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, 'screen', host);
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    const meetingId = ((await (await fetch(`http://127.0.0.1:${port}/api/meeting/state`)).json()) as { meetingId: string })
      .meetingId;
    const line = {
      meetingId,
      participantIdentity: 'Ada',
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

    const wrongSeat = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, seat: 'cashier', clientLineId: 'service-wrong-seat' }),
    });
    expect(wrongSeat.status).toBe(409);
    expect(((await wrongSeat.json()) as { error?: string }).error).toMatch(/no longer holds that seat/i);

    const unknownPerson = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, participantIdentity: 'Mallory', clientLineId: 'service-unknown' }),
    });
    expect(unknownPerson.status).toBe(409);
    expect(((await unknownPerson.json()) as { error?: string }).error).toMatch(/no longer seated/i);

    const oldMeeting = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, meetingId: 'an-old-meeting', clientLineId: 'service-old' }),
    });
    expect(oldMeeting.status).toBe(409);
    expect(((await oldMeeting.json()) as { error?: string }).error).toMatch(/different meeting/i);

    const refused = await fetch(`http://127.0.0.1:${port}/api/runner/human-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: chef },
      body: JSON.stringify({ ...line, clientLineId: 'guest-line' }),
    });
    expect(refused.status).toBe(401);
  });
});
