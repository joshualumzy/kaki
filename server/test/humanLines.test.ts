import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { type KakiEvent } from '@kaki/shared';
import { createAuth } from '../src/auth/module';
import { hashPassword, hashToken } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { createFakeLlm } from '../src/services/llm';
import { loadScenario } from '../src/core/loadScenario';
import { SAMPLE_WORKSPACE_ID } from '../src/workspace/constants';
import {
  createPracticeTestApp,
  createRealTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  practiceModulesWith,
  realModulesWith,
  settle,
  waitFor,
  type TestAppWithMeeting,
} from './helpers';
import { testScenario } from './fixtures/scenario';

const TOKEN = 'local-test-runner-token';
/** The sample workspace's Mattermost connection, so a chat card has somewhere real to go. */
const mattermostEnv = {
  MATTERMOST_URL: 'http://mattermost.test',
  MATTERMOST_TOKEN: 'secret-token',
  MATTERMOST_TEAM: 'kopitiam',
  MATTERMOST_CHANNEL: 'launch',
};

type SocketResult = { ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number };

const apps: TestAppWithMeeting[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie');
  return value;
}

async function requestUrl(
  url: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function openMeeting(app: TestAppWithMeeting, cookie?: string): Promise<Response> {
  return requestUrl(meetingUrl(app, app.meetingId, '/api/meeting/open'), 'POST', undefined, cookie);
}

function startMeeting(app: TestAppWithMeeting, cookie?: string): Promise<Response> {
  return requestUrl(meetingUrl(app, app.meetingId, '/api/meeting/start'), 'POST', undefined, cookie);
}

function connect(
  port: number,
  meetingId: string,
  role: string,
  cookie?: string,
): Promise<SocketResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const ws = new WebSocket(meetingWsUrl(port, meetingId, `role=${encodeURIComponent(role)}`), { headers });
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

/** Join a sign-in-off real meeting under a typed name; there is no code or role picker. */
async function joinOpenSeat(
  app: TestAppWithMeeting,
  name: string,
): Promise<{ seat: string; cookie?: string }> {
  const joined = await requestUrl(
    meetingUrl(app, app.meetingId, '/api/livekit/token'),
    'POST',
    { participantName: name },
  );
  expect(joined.status).toBe(200);
  const body = (await joined.json()) as { participantRole: string };
  const cookie = joined.headers.get('set-cookie')?.split(';')[0];
  return { seat: body.participantRole, ...(cookie === undefined ? {} : { cookie }) };
}

/** Guest join then take a seat, returning the rotated seat cookie and its seat id. */
async function guestSeat(
  app: TestAppWithMeeting,
  name: string,
): Promise<{ seat: string; cookie: string }> {
  const joined = await requestUrl(meetingUrl(app, app.meetingId, '/join'), 'POST', { name });
  expect(joined.status).toBe(200);
  const guest = cookieFrom(joined);
  const seated = await requestUrl(
    meetingUrl(app, app.meetingId, '/api/livekit/token'),
    'POST',
    { participantName: name },
    guest,
  );
  expect(seated.status).toBe(200);
  const body = (await seated.json()) as { participantRole: string };
  return { seat: body.participantRole, cookie: cookieFrom(seated) };
}

async function humanOnlyApp(
  speechRecognition: 'server' | 'browser' = 'browser',
): Promise<{ app: TestAppWithMeeting; port: number; llm: ReturnType<typeof createFakeLlm> }> {
  const llm = createFakeLlm(() =>
    JSON.stringify({ newQuestions: [], answeredQuestionIds: [], answeredQuestions: [], newTasks: [], revisions: [] }),
  );
  const app = await createRealTestApp(
    {
      actionTools: { env: mattermostEnv },
      meetingModules: realModulesWith([createMeetingModule({ llm, notetakerIntervalMs: 40 })]),
      roomRoster: async () => [],
      speechRecognition,
    },
    {
      workspaceId: SAMPLE_WORKSPACE_ID,
      title: 'Opening huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    },
  );
  apps.push(app);
  return { app, port: portOf(app), llm };
}

async function openAndSeatTwoPeople(
  app: TestAppWithMeeting,
): Promise<{ aliceSeat: string; benSeat: string }> {
  expect((await openMeeting(app)).status).toBe(200);
  const alice = await joinOpenSeat(app, 'Alice');
  const ben = await joinOpenSeat(app, 'Ben');
  expect(app.session.holders()).toHaveLength(2);
  return { aliceSeat: alice.seat, benSeat: ben.seat };
}

async function humanOnlyMeeting(
  options: { speechRecognition?: 'server' | 'browser' } = {},
): Promise<{
  app: TestAppWithMeeting;
  port: number;
  llm: ReturnType<typeof createFakeLlm>;
  aliceSeat: string;
  benSeat: string;
}> {
  const { app, port, llm } = await humanOnlyApp(options.speechRecognition ?? 'browser');
  const { aliceSeat, benSeat } = await openAndSeatTwoPeople(app);
  // No service socket is opened: browser-side recognition needs no AI runner at all.
  const started = await startMeeting(app);
  expect(started.status).toBe(200);
  await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
  return { app, port, llm, aliceSeat, benSeat };
}

function serviceSocket(port: number, meetingId: string, stt: 'server' | 'browser' = 'server'): Promise<SocketResult> {
  const ws = new WebSocket(meetingWsUrl(port, meetingId, `role=service&stt=${stt}`));
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
  return JSON.stringify({ type: 'HUMAN_LINE', text, clientLineId, ...extra });
}

describe('human-only meetings record people\'s lines', () => {
  it('writes speech lines with the admitted person\'s name, sets the seat as role metadata, feeds the notetaker, and dedupes', async () => {
    const { app, port, llm, aliceSeat, benSeat } = await humanOnlyMeeting();
    const screen = await connect(port, app.meetingId, 'screen');
    const alice = await connect(port, app.meetingId, aliceSeat);
    const ben = await connect(port, app.meetingId, benSeat);
    if (!screen.ok || !alice.ok || !ben.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, alice.ws, ben.ws);

    alice.ws.send(humanLine('I checked the front counter this morning.', 'line-1'));
    // A spoofed speaker field must never decide who said it.
    ben.ws.send(
      JSON.stringify({
        type: 'HUMAN_LINE',
        text: 'The laptop campers bought one kopi each.',
        clientLineId: 'line-2',
        speaker: 'Sam',
      }),
    );
    // A retry with the same id is the same line, not a second one.
    alice.ws.send(humanLine('The queue was out the door.', 'line-3'));
    alice.ws.send(humanLine('The queue was out the door.', 'line-3'));

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
        ['Alice', aliceSeat, 'I checked the front counter this morning.'],
        ['Ben', benSeat, 'The laptop campers bought one kopi each.'],
        ['Alice', aliceSeat, 'The queue was out the door.'],
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
    const { aliceSeat } = await openAndSeatTwoPeople(app);
    const alice = await connect(port, app.meetingId, aliceSeat);
    if (!alice.ok) throw new Error('alice socket did not open');
    sockets.push(alice.ws);

    alice.ws.send(humanLine('Too early.', 'lobby-line'));
    const lobby = await waitFor(
      () => alice.messages.find((event) => event.type === 'COMMAND_REJECTED'),
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

    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    const screen = await connect(port, app.meetingId, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the meeting to end');

    alice.ws.send(humanLine('Too late.', 'ended-line'));
    const ended = await waitFor(
      () => alice.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'an ended rejection',
    );
    expect(ended).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: 'The meeting is not running' } });
  });
});

describe('a person\'s own seat keeps their name and role', () => {
  it('writes the admitted name with their seat, so talk time and the notetaker still know who spoke', async () => {
    const { app, port, llm, aliceSeat } = await humanOnlyMeeting();
    const screen = await connect(port, app.meetingId, 'screen');
    const alice = await connect(port, app.meetingId, aliceSeat);
    if (!screen.ok || !alice.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, alice.ws);

    alice.ws.send(humanLine('I checked the front counter this morning.', 'renamed-line'));
    const line = await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK'),
      'the seat transcript line',
    );
    expect(line).toMatchObject({
      payload: { speaker: 'Alice', speakerRole: aliceSeat, text: 'I checked the front counter this morning.' },
    });

    const record = await waitFor(
      () =>
        screen.messages.find(
          (event) =>
            event.type === 'MEETING_RECORD_UPDATED' &&
            (event.payload.speakerTalkSeconds[aliceSeat] ?? 0) >= 1,
        ),
      'talk time for the seat',
    );
    expect(record).toMatchObject({ payload: { speakerTalkSeconds: { [aliceSeat]: expect.any(Number) } } });

    const seatLabel = app.session.active().roles.find((role) => role.id === aliceSeat)?.label;
    expect(seatLabel).toBeDefined();
    await waitFor(
      () =>
        llm.calls.some((messages) =>
          messages.some((message) => message.content.includes(`Alice (${seatLabel})`)),
        )
          ? true
          : undefined,
      'the notetaker line to carry the role',
    );
  });
});

describe('a practice room matches speech by the name identity its token issues', () => {
  it('accepts a server-recognised practice line under its display name', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await createPracticeTestApp({
      scenario: pack,
      speechRecognition: 'browser',
      roomRoster: async () => [],
    });
    apps.push(app);
    const port = portOf(app);
    const screen = await connect(port, app.meetingId, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    // A practice meeting starts with its AI colleagues, so the runner answers the prepare handshake.
    const service = await connect(port, app.meetingId, 'service');
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

    const joined = await requestUrl(
      meetingUrl(app, app.meetingId, '/api/livekit/token'),
      'POST',
      { participantName: 'Alice', participantRole: 'operations_director', kind: 'practice' },
      app.cookie,
    );
    expect(joined.status).toBe(200);
    expect((await startMeeting(app, app.cookie)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the practice meeting to run');

    const text = 'The practice line still lands.';
    const response = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        meetingId: app.meetingId,
        participantIdentity: 'Alice',
        seat: 'operations_director',
        text,
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
    const { app } = await humanOnlyApp('server');
    await openAndSeatTwoPeople(app);
    const refused = await startMeeting(app);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error?: string }).error).toMatch(/Speech recording isn't ready/);
    expect(app.session.phase()).toBe('lobby');
  });

  it('opens with a server-side runner and says so when that runner drops mid-meeting', async () => {
    const { app, port } = await humanOnlyApp('server');
    const service = await serviceSocket(port, app.meetingId);
    if (!service.ok) throw new Error('service socket did not open');
    sockets.push(service.ws);
    await openAndSeatTwoPeople(app);
    const screen = await connect(port, app.meetingId, 'screen');
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    const started = await startMeeting(app);
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
  it('refuses a speech line beyond its cap with a clear reason', async () => {
    const { app, port, aliceSeat } = await humanOnlyMeeting();
    const alice = await connect(port, app.meetingId, aliceSeat);
    if (!alice.ok) throw new Error('alice socket did not open');
    sockets.push(alice.ws);

    alice.ws.send(
      JSON.stringify({
        type: 'HUMAN_LINE',
        text: 'y'.repeat(2_001),
        clientLineId: 'too-long-speech',
      }),
    );
    const refusal = await waitFor(
      () => alice.messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'the long speech line refusal',
    );
    expect(refusal).toMatchObject({ payload: { commandType: 'HUMAN_LINE', reason: expect.stringMatching(/too long/i) } });
  });

  it('refuses a burst from one seat while another seat keeps its own dedupe memory', async () => {
    const { app, port, aliceSeat, benSeat } = await humanOnlyMeeting();
    const screen = await connect(port, app.meetingId, 'screen');
    const alice = await connect(port, app.meetingId, aliceSeat);
    const ben = await connect(port, app.meetingId, benSeat);
    if (!screen.ok || !alice.ok || !ben.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, alice.ws, ben.ws);

    alice.ws.send(humanLine('A line from Alice.', 'shared-id'));
    ben.ws.send(humanLine('A line from Ben.', 'shared-id'));
    await waitFor(
      () => screen.messages.filter((event) => event.type === 'TRANSCRIPT_CHUNK').length >= 2 ? true : undefined,
      'both seats to use the same line id',
    );

    for (let index = 0; index < 6; index += 1) {
      alice.ws.send(humanLine(`Burst line ${index}.`, `burst-${index}`));
    }
    const refused = await waitFor(
      () =>
        alice.messages.find(
          (event) => event.type === 'COMMAND_REJECTED' && /Too many lines/i.test(event.payload.reason),
        ),
      'the per-seat rate-limit refusal',
    );
    expect(refused).toMatchObject({ payload: { commandType: 'HUMAN_LINE' } });
  });
});

describe('human lines are not held for a human-only meeting but are held with an AI cast', () => {
  it('dispatches a human-only task and holds a practice AI task until its topic settles', async () => {
    // Human-only: the same suggestion is released by the normal non-held rule.
    const human = await createRealTestApp(
      {
        actionTools: { env: mattermostEnv },
        meetingModules: realModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
        roomRoster: async () => [],
        speechRecognition: 'browser',
      },
      {
        workspaceId: SAMPLE_WORKSPACE_ID,
        title: 'Weekly planning',
        agenda: [{ title: 'Opening checklist', minutes: 5 }],
      },
    );
    apps.push(human);
    expect((await openMeeting(human)).status).toBe(200);
    const alice = await joinOpenSeat(human, 'Alice');
    expect((await startMeeting(human)).status).toBe(200);
    await waitFor(() => (human.session.phase() === 'running' ? true : undefined), 'the human meeting to run');
    const humanTask = human.tasks.suggest({
      title: 'Post the opening checklist',
      context: 'The room agreed on the opening checklist.',
      suggestedAssignee: alice.seat,
      actionKind: 'mattermost_post',
      agendaItemTitle: 'Opening checklist',
    });
    await waitFor(
      () => (human.tasks.get(humanTask.id)?.status === 'DISPATCHED' ? true : undefined),
      'the human-only card to dispatch',
    );

    // With an AI cast, the Director owns TOPIC_SETTLED, so the card stays held until it arrives.
    const pack = await loadScenario('kopitiam');
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createPracticeTestApp({
      scenario: pack,
      actionTools: { env: mattermostEnv },
      practiceModules: practiceModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })]),
      roomRoster: async () => [],
      speechRecognition: 'browser',
    });
    apps.push(app);
    const port = portOf(app);
    const service = await connect(port, app.meetingId, 'service');
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
    const joined = await requestUrl(
      meetingUrl(app, app.meetingId, '/api/livekit/token'),
      'POST',
      { participantName: 'Booth Playtest', participantRole: 'tech_pos_lead', kind: 'practice' },
      app.cookie,
    );
    expect(joined.status).toBe(200);
    expect((await startMeeting(app, app.cookie)).status).toBe(200);
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
    app: TestAppWithMeeting;
    port: number;
    host: string;
    setPeople(people: Array<{ name: string }>): void;
  }> {
    const store: AuthStore = createMemoryAuthStore();
    const user = await store.createUser({ email: 'host@example.com', passwordHash: await hashPassword('host-password') });
    await store.updateUserProfile({ id: user.id, name: 'Ada', email: user.email });
    // A real meeting's owner is a signed-in product user, not the legacy password host.
    const token = randomUUID();
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: 'Ada',
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const host = `kaki_session=${token}`;
    const auth = createAuth({ store});
    const clock = createAgendaClock({ agenda: testScenario.agenda });
    let people: Array<{ name: string }> = [];
    const app = await createRealTestApp(
      {
        auth,
        serviceToken: TOKEN,
        meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })]),
        roomRoster: async () => people,
        rejoinGraceMs: 60_000,
        rejoinPollMs: 20,
        emptyRoomPauseMs: 20,
        speechRecognition: 'browser',
      },
      {
        title: 'Weekly planning',
        agenda: testScenario.agenda.map(({ title, minutes }) => ({ title, minutes })),
        ownerUserId: user.id,
      },
    );
    apps.push(app);
    return { app, port: portOf(app), host, setPeople: (next) => { people = next; } };
  }

  it('refuses anonymous sockets, another seat, another meeting, and lines outside a running meeting', async () => {
    const { app, port, host, setPeople } = await authOnApp();
    expect((await openMeeting(app, host)).status).toBe(200);
    const ada = await guestSeat(app, 'Ada');
    const bao = await guestSeat(app, 'Bao');
    setPeople([{ name: 'Ada' }, { name: 'Bao' }]);

    expect((await connect(port, app.meetingId, ada.seat)).ok).toBe(false);
    expect((await connect(port, app.meetingId, ada.seat, bao.cookie)).ok).toBe(false);

    const phone = await connect(port, app.meetingId, ada.seat, ada.cookie);
    if (!phone.ok) throw new Error('seat socket did not open');
    sockets.push(phone.ws);
    phone.ws.send(humanLine('Before Start.', 'auth-lobby'));
    await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && event.payload.reason === 'The meeting is not running'),
      'the lobby refusal',
    );

    expect((await startMeeting(app, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, app.meetingId, 'screen', host);
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
    expect((await connect(port, app.meetingId, ada.seat, ada.cookie)).ok).toBe(false);
  });

  it('refuses a held line tagged with another meeting or another seat', async () => {
    const { app, port, host, setPeople } = await authOnApp();
    expect((await openMeeting(app, host)).status).toBe(200);
    const ada = await guestSeat(app, 'Ada');
    setPeople([{ name: 'Ada' }]);
    expect((await startMeeting(app, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, app.meetingId, 'screen', host);
    const phone = await connect(port, app.meetingId, ada.seat, ada.cookie);
    if (!screen.ok || !phone.ok) throw new Error('sockets did not open');
    sockets.push(screen.ws, phone.ws);

    phone.ws.send(humanLine('This belongs to an old meeting.', 'held-old-meeting', { meetingId: 'an-old-meeting' }));
    const wrongMeeting = await waitFor(
      () => phone.messages.find((event) => event.type === 'COMMAND_REJECTED' && /different meeting/i.test(event.payload.reason)),
      'the old-meeting refusal',
    );
    expect(wrongMeeting).toMatchObject({ payload: { commandType: 'HUMAN_LINE' } });

    phone.ws.send(humanLine('Only this seat may speak here.', 'held-wrong-seat', { seat: 'everyone' }));
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
            event.payload.text === 'Only this seat may speak here.'),
      ),
    ).toBe(false);
  });

  it('records a signed-in host\'s own line when the host takes a seat', async () => {
    const { app, port, host, setPeople } = await authOnApp();
    expect((await openMeeting(app, host)).status).toBe(200);
    // The owner joins their own seat: the host session now also carries that seat.
    const joined = await requestUrl(
      meetingUrl(app, app.meetingId, '/api/livekit/token'),
      'POST',
      { participantName: 'Ada' },
      host,
    );
    expect(joined.status).toBe(200);
    const hostSeatCookie = cookieFrom(joined);
    const hostSeat = ((await joined.json()) as { participantRole: string }).participantRole;
    setPeople([{ name: 'Ada' }]);
    expect((await startMeeting(app, hostSeatCookie)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');

    const seat = await connect(port, app.meetingId, hostSeat, hostSeatCookie);
    const screen = await connect(port, app.meetingId, 'screen', hostSeatCookie);
    if (!seat.ok || !screen.ok) throw new Error('host sockets did not open');
    sockets.push(seat.ws, screen.ws);

    seat.ws.send(humanLine('I will confirm the stock count before lunch.', 'host-seat-line'));
    const accepted = await waitFor(
      () => screen.messages.find(
        (event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'I will confirm the stock count before lunch.',
      ),
      'the host seat line',
    );
    expect(accepted).toMatchObject({ payload: { speaker: 'Ada', speakerRole: hostSeat } });
  });

  it('accepts a recognised line through the service route and refuses a guest session', async () => {
    const { app, port, host, setPeople } = await authOnApp();
    expect((await openMeeting(app, host)).status).toBe(200);
    const ada = await guestSeat(app, 'Ada');
    setPeople([{ name: 'Ada' }]);
    expect((await startMeeting(app, host)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the auth meeting to run');
    const screen = await connect(port, app.meetingId, 'screen', host);
    if (!screen.ok) throw new Error('screen socket did not open');
    sockets.push(screen.ws);

    const line = {
      meetingId: app.meetingId,
      participantIdentity: 'Ada',
      seat: ada.seat,
      text: 'This was recognised by the server.',
      clientLineId: 'service-line',
    };
    const accepted = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
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

    const wrongSeat = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, seat: 'another-seat', clientLineId: 'service-wrong-seat' }),
    });
    expect(wrongSeat.status).toBe(409);
    expect(((await wrongSeat.json()) as { error?: string }).error).toMatch(/no longer holds that seat/i);

    const unknownPerson = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, participantIdentity: 'Mallory', clientLineId: 'service-unknown' }),
    });
    expect(unknownPerson.status).toBe(409);
    expect(((await unknownPerson.json()) as { error?: string }).error).toMatch(/no longer seated/i);

    const oldMeeting = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...line, meetingId: 'an-old-meeting', clientLineId: 'service-old' }),
    });
    expect(oldMeeting.status).toBe(409);
    expect(((await oldMeeting.json()) as { error?: string }).error).toMatch(/different meeting/i);

    const refused = await fetch(meetingUrl(app, app.meetingId, '/api/runner/human-line'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ada.cookie },
      body: JSON.stringify({ ...line, clientLineId: 'guest-line' }),
    });
    expect(refused.status).toBe(401);
  });
});
