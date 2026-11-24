import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  aiCast,
  buildMeetingInviteIcs,
  DEFAULT_MEETING_PACE,
  defaultMeetingSetup,
  isPackFreeMeeting,
  KOPITIAM_INVITE_UID,
  meetingScenarioFromSetup,
  parseScenario,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import type { CalendarSettings } from '../src/action/calendar';
import { createWikiModule } from '../src/action/wiki';
import type { CreateAppOptions } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/core/loadScenario';
import type { KakiModule } from '../src/core/modules';
import { createMemoryMeetingStore, type MeetingStore } from '../src/meeting/registry';
import { realBaseScenario } from '../src/meeting/realMeeting';
import type { MeetingRow } from '../src/meeting/types';
import { createMeetingPersistence, type MeetingPersistence } from '../src/persist/persistence';
import { MEETING_STATE_SCHEMA_VERSION, type MeetingStateStore, type StoredMeeting } from '../src/persist/state';
import {
  connectMeetingClient,
  createPracticeTestApp,
  createTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  practiceModulesWith,
  realModulesWith,
  settle,
  waitFor,
  waitForEvent,
  type TestAppWithMeeting,
  type TestClient,
} from './helpers';
import { testScenario } from './fixtures/scenario';

const packScenario: Scenario = {
  ...testScenario,
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
    { name: 'Cy', role: 'barista', displayName: 'Cy (Barista)' },
  ],
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'barista', label: 'Barista' },
  ],
  npcs: [
    { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
    { attendee: 'Bao', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
    { attendee: 'Cy', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
  ],
};

const topicScenario: Scenario = {
  ...testScenario,
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
  ],
  agenda: [
    {
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before service',
      ownerRole: 'chef',
      decision: 'Do we prep as planned?',
      briefing: [{ text: 'The fridge is full.', knownBy: [{ attendee: 'Ada', why: 'Ada checked it' }] }],
    },
    {
      title: 'Close',
      minutes: 4,
      canWait: true,
      deadline: 'today',
      ownerRole: 'cashier',
      decision: 'Who closes the till?',
      briefing: [{ text: 'The till counted short.', knownBy: [{ attendee: 'Bao', why: 'Bao counted it' }] }],
    },
  ],
};

/** A typed, pack-free setup for two real people, with no AI seat and no demo-pack topic. */
function humanOnlySetup(pack: Scenario): MeetingSetup {
  return {
    ...defaultMeetingSetup(pack),
    title: 'Floor huddle',
    agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'operations_director' }],
    seats: [
      { displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' },
      { displayName: 'Arjun', roleId: 'tech_pos_lead', kind: 'person' },
    ],
  };
}

/** The real pack's setup with the operations_director role wrongly marked as the facilitator. */
function operationsDirectorAsFacilitator(pack: Scenario): MeetingSetup {
  const setup = defaultMeetingSetup(structuredClone(pack));
  const operations_director = setup.roles.find((role) => role.id === 'operations_director');
  if (operations_director === undefined) throw new Error('Expected the operations_director role');
  operations_director.facilitator = true;
  return setup;
}

function storedMeetingWithSetup(setup: MeetingSetup, started: boolean): StoredMeeting {
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: 'saved-invalid-setup',
    phase: started ? 'running' : 'lobby',
    draft: setup,
    draftTouched: true,
    ...(started ? { sealed: setup } : {}),
    holders: [{ name: 'Wei Ling', seat: 'operations_director' }],
    meetingCode: 'ABC123',
    savedAt: '2026-01-01T00:05:00.000Z',
    ...(started ? { startedAt: '2026-01-01T00:00:00.000Z' } : {}),
    state: {
      clock: {
        started,
        ended: false,
        paused: false,
        agendaIndex: 0,
        itemElapsedSeconds: started ? 30 : 0,
        meetingElapsedSeconds: started ? 30 : 0,
      },
      notetaker: {
        pending: [],
        inFlight: [],
        recentGrounded: [],
        contextAgendaIndex: 0,
        agendaContext: [],
        openQuestions: [],
        questionCount: 0,
        status: 'ok',
        talkByItem: [],
        talkTotals: [],
        talkTotal: 0,
      },
      tasks: [],
    },
  };
}

class MemoryStore implements MeetingStateStore {
  saved: StoredMeeting | undefined;
  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }
  async save(meeting: StoredMeeting): Promise<void> {
    this.saved = meeting;
  }
  async clear(): Promise<void> {
    this.saved = undefined;
  }
}

const apps: TestAppWithMeeting[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

/** One meeting route for the app's own meeting. */
function url(app: TestAppWithMeeting, path: string): string {
  return meetingUrl(app, app.meetingId, path);
}

/** A per-visitor practice meeting: the one place the pack and its draft still drive Start. */
async function startApp(
  scenario: Scenario,
  options: Omit<CreateAppOptions, 'scenario' | 'modules'> & { modules?: KakiModule[] } = {},
): Promise<TestAppWithMeeting> {
  const { modules = [], ...rest } = options;
  const app = await createPracticeTestApp({
    speechRecognition: 'browser',
    scenario,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    practiceModules: practiceModulesWith(modules),
    ...rest,
  });
  apps.push(app);
  return app;
}

interface RealMeetingOptions {
  title: string;
  agenda?: MeetingRow['agenda'];
  meetingId?: string;
  ownerUserId?: string;
}

type RealAppOptions = Omit<
  CreateAppOptions,
  'scenario' | 'meetings' | 'persistenceFor' | 'meetingModules' | 'practiceModules' | 'modules'
> & {
  modules?: KakiModule[];
  persistence?: MeetingPersistence;
};

/** A real meeting row plus its loaded instance: team meetings, persistence and auth live here. */
async function startRealApp(
  meetings: MeetingStore,
  meeting: RealMeetingOptions,
  options: RealAppOptions = {},
): Promise<TestAppWithMeeting> {
  const { modules = [createMeetingModule({ notetakerIntervalMs: 60_000 })], persistence, ...rest } = options;
  const app = (await createTestApp({
    meetings,
    ...(persistence === undefined ? {} : { persistenceFor: async () => persistence }),
    meetingModules: realModulesWith(modules),
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...rest,
  })) as TestAppWithMeeting;
  apps.push(app);
  const meetingId =
    meeting.meetingId ??
    (
      await meetings.create({
        workspaceId: 'workspace-1',
        ownerUserId: meeting.ownerUserId ?? 'test-owner',
        title: meeting.title,
        ...(meeting.agenda === undefined ? {} : { agenda: meeting.agenda }),
      })
    ).id;
  const instance = await app.registry.get(meetingId);
  if (instance === undefined) throw new Error(`the real meeting ${meetingId} did not load`);
  return Object.assign(app, {
    id: instance.id,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
    meetingId,
  });
}

/** An app whose next `registry.get` will load (or refuse) a saved meeting; used for boot failures. */
async function startBootApp(meetings: MeetingStore, persistence: MeetingPersistence): Promise<TestAppWithMeeting> {
  const app = (await createTestApp({
    meetings,
    persistenceFor: async () => persistence,
    meetingModules: realModulesWith([]),
    roomRoster: async () => [],
  })) as TestAppWithMeeting;
  apps.push(app);
  return app;
}

function expectedRealSetup(row: MeetingRow): MeetingSetup {
  return defaultMeetingSetup(realBaseScenario(row));
}

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

function startMeeting(app: TestAppWithMeeting, cookie = app.cookie): Promise<Response> {
  return fetch(url(app, '/api/meeting/start'), {
    method: 'POST',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

async function getSetup(app: TestAppWithMeeting): Promise<MeetingSetup> {
  const response = await fetch(url(app, '/api/setup'), {
    ...(app.cookie === undefined ? {} : { headers: { cookie: app.cookie } }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { setup: MeetingSetup }).setup;
}

function putSetup(app: TestAppWithMeeting, setup: MeetingSetup): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (app.cookie !== undefined) headers.cookie = app.cookie;
  return fetch(url(app, '/api/setup'), {
    method: 'PUT',
    headers,
    body: JSON.stringify(setup),
  });
}

function startBlankSetup(app: TestAppWithMeeting): Promise<Response> {
  return fetch(url(app, '/api/setup/blank'), {
    method: 'POST',
    ...(app.cookie === undefined ? {} : { headers: { cookie: app.cookie } }),
  });
}

async function getScenario(app: TestAppWithMeeting): Promise<Scenario> {
  const response = await fetch(url(app, '/api/scenario'));
  expect(response.status).toBe(200);
  return (await response.json()) as Scenario;
}

async function meetingState(app: TestAppWithMeeting): Promise<{ meetingId: string; started: boolean; startedAt?: string }> {
  const response = await fetch(url(app, '/api/meeting/state'));
  expect(response.status).toBe(200);
  return (await response.json()) as { meetingId: string; started: boolean; startedAt?: string };
}

function cookieFrom(response: Response): string {
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (pair === '') throw new Error('The response did not set a cookie');
  return pair;
}

async function connectService(port: number, meetingId: string): Promise<{ socket: WebSocket; prepares: unknown[] }> {
  const socket = new WebSocket(meetingWsUrl(port, meetingId, 'role=service'));
  const prepares: unknown[] = [];
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId: requestMeetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || requestMeetingId === undefined) {
      return;
    }
    prepares.push(message.request);
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId: requestMeetingId }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, prepares };
}

interface PrepareRequest {
  requestId: string;
  attempt: string;
  meetingId: string;
}

async function connectHeldService(port: number, meetingId: string): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  const socket = new WebSocket(meetingWsUrl(port, meetingId, 'role=service'));
  const prepares: PrepareRequest[] = [];
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: Partial<PrepareRequest>;
    };
    const { requestId, attempt, meetingId: requestMeetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || requestMeetingId === undefined) {
      return;
    }
    prepares.push({ requestId, attempt, meetingId: requestMeetingId });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    prepares,
    reply(kind, reason) {
      const last = prepares.at(-1);
      if (last === undefined) throw new Error('No prepare request to answer');
      socket.send(
        JSON.stringify({
          kind,
          requestId: last.requestId,
          attempt: last.attempt,
          meetingId: last.meetingId,
          ...(reason === undefined ? {} : { reason }),
        }),
      );
    },
  };
}

/** One visitor joins their own practice meeting. */
function join(app: TestAppWithMeeting, participantName: string, participantRole: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (app.cookie !== undefined) headers.cookie = app.cookie;
  return fetch(url(app, '/api/livekit/token'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'practice', participantName, participantRole }),
  });
}

/** A person joins a real meeting under their own name, no role and no code. */
function joinReal(app: TestAppWithMeeting, participantName: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(url(app, '/api/livekit/token'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ participantName }),
  });
}

/** A guest takes a real meeting's seat; the join route hands out the guest cookie first. */
async function joinGuest(
  app: TestAppWithMeeting,
  name: string,
): Promise<{ cookie: string; seat: string }> {
  const base = `http://127.0.0.1:${portOf(app)}`;
  const joined = await fetch(`${base}/api/meetings/${app.meetingId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(joined.status).toBe(200);
  const cookie = cookieFrom(joined);
  const seated = await joinReal(app, name, cookie);
  expect(seated.status).toBe(200);
  const seat = ((await seated.json()) as { participantRole: string }).participantRole;
  return { cookie, seat };
}

/** A role socket that may carry a signed-in owner's cookie. */
async function connectRole(
  port: number,
  meetingId: string,
  role: string,
  cookie?: string,
): Promise<TestClient> {
  const ws = new WebSocket(
    meetingWsUrl(port, meetingId, `role=${encodeURIComponent(role)}`),
    cookie === undefined ? undefined : { headers: { cookie } },
  );
  const messages: TestClient['messages'] = [];
  sockets.push(ws);
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as TestClient['messages'][number]);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, close: () => ws.close() };
}

/** The shared screen of a real meeting, which needs the owner's cookie when sign-in is on. */
async function connectScreen(app: TestAppWithMeeting, cookie?: string): Promise<TestClient> {
  const ws = new WebSocket(
    meetingWsUrl(portOf(app), app.meetingId, 'audience=screen'),
    cookie === undefined ? undefined : { headers: { cookie } },
  );
  const messages: TestClient['messages'] = [];
  sockets.push(ws);
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as TestClient['messages'][number]);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, close: () => ws.close() };
}

async function endRealMeeting(app: TestAppWithMeeting): Promise<void> {
  const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');
  screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
  await waitForEvent(
    screen,
    (event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.ended === true,
    'the meeting to end',
  );
  screen.close();
}

function agendaShape(scenario: Scenario): Array<{ title: string; minutes: number; ownerRole: string }> {
  return scenario.agenda.map(({ title, minutes, ownerRole }) => ({ title, minutes, ownerRole }));
}

describe('Start applies the validated setup', () => {
  it('rejects an invalid draft with 422 before asking the runner or changing anything', async () => {
    const corrupt: KakiModule = {
      name: 'corrupt-draft',
      start(context) {
        const setup = context.meetingDetails?.().draft;
        if (setup !== undefined) setup.agenda[0]!.minutes = 0;
      },
    };
    const app = await startApp(packScenario, { modules: [corrupt] });
    const { prepares } = await connectService(portOf(app), app.meetingId);
    const before = await getScenario(app);

    const response = await startMeeting(app);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string }> };
    expect(body.error).toMatch(/setup is not valid/i);
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'agenda[0].minutes' }));
    await settle(50);
    expect(prepares).toHaveLength(0);
    expect((await getScenario(app)).agenda).toEqual(before.agenda);
    const state = (await (await fetch(url(app, '/api/meeting/state'))).json()) as {
      started: boolean;
    };
    expect(state.started).toBe(false);
  });

  it('uses the setup minutes for the TIMEOUT cue', async () => {
    let nowMs = 0;
    const clock = createAgendaClock({ agenda: testScenario.agenda, now: () => nowMs });
    const app = await startApp(testScenario, {
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
    });
    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');
    const setup = await getSetup(app);
    setup.agenda[0]!.minutes = 1;
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Cook', 'chef')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (clock.snapshot().started ? true : undefined), 'the clock to start');

    nowMs = 59_000;
    clock.tick();
    await settle(20);
    expect(
      screen.messages.filter((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'TIMEOUT'),
    ).toHaveLength(0);

    nowMs = 60_000;
    clock.tick();
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'TIMEOUT',
      'the timeout cue',
    );
    screen.close();
  });

  it('keeps each topic briefing and decision when the agenda is reordered', async () => {
    const scenario = structuredClone(topicScenario);
    const closeBriefing = scenario.agenda[1]!.briefing;
    const prepBriefing = scenario.agenda[0]!.briefing;
    const app = await startApp(scenario);
    const setup = await getSetup(app);
    setup.agenda = [setup.agenda[1]!, setup.agenda[0]!];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Cook', 'chef')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.agenda.map((item) => item.title)).toEqual(['Close', 'Prep']);
    expect(active.agenda[0]).toMatchObject({
      title: 'Close',
      decision: 'Who closes the till?',
      briefing: closeBriefing,
    });
    expect(active.agenda[1]).toMatchObject({
      title: 'Prep',
      decision: 'Do we prep as planned?',
      briefing: prepBriefing,
    });
  });

  it('turns an unknown setup title into a plain item with sensible required fields', async () => {
    const app = await startApp(topicScenario);
    const setup = await getSetup(app);
    setup.agenda.push({ id: 'agenda-3', title: 'A new topic', minutes: 3, ownerRoleId: 'cashier' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Cook', 'chef')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const plain = (await getScenario(app)).agenda[2];
    expect(plain).toEqual({
      title: 'A new topic',
      minutes: 3,
      canWait: true,
      deadline: 'today',
      ownerRole: 'cashier',
    });
  });

  it('excludes a pack seat switched to a person from the active AI cast', async () => {
    const pack = structuredClone(packScenario);
    const setup = defaultMeetingSetup(pack);
    const ada = setup.seats.find((seat) => seat.displayName === 'Ada');
    const bao = setup.seats.find((seat) => seat.displayName === 'Bao');
    expect(bao?.kind).toBe('ai');
    if (ada === undefined || bao === undefined) throw new Error('Expected Ada and Bao seats');
    // Keep exactly one person, as the setup contract requires when AI stand-ins are present.
    ada.kind = 'ai';
    ada.npcProfileId = 'Ada';
    bao.kind = 'person';
    delete bao.npcProfileId;
    // The practice meeting's admission reads its pack; the same edited plan as its pack keeps the
    // one person seat joinable while still proving the switched seat left the AI cast.
    const app = await startApp(meetingScenarioFromSetup(pack, setup));
    await connectService(portOf(app), app.meetingId);
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'cashier')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.npcs?.map((npc) => npc.attendee)).toEqual(['Ada', 'Cy']);
  });

  it("starts the default Kopitiam setup as today's meeting", async () => {
    const scenario = await loadScenario('kopitiam');
    // A snapshot that the app and Start may both mutate; the expectations compare against this.
    const pack = structuredClone(scenario);
    const app = await startApp(scenario);
    await connectService(portOf(app), app.meetingId);
    const setup = await getSetup(app);
    expect(setup).toEqual(defaultMeetingSetup(pack));
    expect(setup.pace).toEqual(DEFAULT_MEETING_PACE);

    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);
    const shaped = structuredClone(await getScenario(app));
    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(agendaShape(active)).toEqual(agendaShape(shaped));
    expect(active.meetingTitle).toBe(pack.meetingTitle);
    const roleShape = (roles: Scenario['roles']) =>
      roles.map(({ id, label, facilitator }) => ({ id, label, facilitator: facilitator === true }));
    expect(roleShape(active.roles)).toEqual(roleShape(pack.roles));
    expect(active.npcs?.map((npc) => npc.attendee)).toEqual(aiCast(pack, 'Arjun').map((npc) => npc.attendee));
  });

  it('restores the sealed setup and its agenda after a restart', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [
        { title: 'Prep', minutes: 2 },
        { title: 'After the break', minutes: 3 },
      ],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Cook')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    await firstPersistence.flush();

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const restoredSetup = await getSetup(restored);
    expect(restoredSetup.agenda.map(({ title, minutes }) => ({ title, minutes }))).toEqual([
      { title: 'Prep', minutes: 2 },
      { title: 'After the break', minutes: 3 },
    ]);
    const active = await getScenario(restored);
    expect(active.agenda.map(({ title, minutes }) => ({ title, minutes }))).toEqual([
      { title: 'Prep', minutes: 2 },
      { title: 'After the break', minutes: 3 },
    ]);
    expect((await meetingState(restored)).started).toBe(true);
  });

  it('keeps the two-topic agenda admission shuffled when Start runs an untouched draft', async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app), app.meetingId);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);

    const chosen = structuredClone(await getScenario(app));
    expect(chosen.agenda).toHaveLength(2);

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(chosen));
  });

  it('keeps KAKI_AGENDA_PICK when Start runs an untouched draft', async () => {
    const previous = process.env.KAKI_AGENDA_PICK;
    process.env.KAKI_AGENDA_PICK = '0,1';
    try {
      const scenario = await loadScenario('kopitiam');
      const app = await startApp(scenario);
      await connectService(portOf(app), app.meetingId);
      expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);

      const picked = scenario.agenda.slice(0, 2);
      expect((await getScenario(app)).agenda.map((item) => item.title)).toEqual(
        picked.map((item) => item.title),
      );

      expect((await startMeeting(app)).status).toBe(200);
      expect((await getScenario(app)).agenda.map((item) => item.title)).toEqual(
        picked.map((item) => item.title),
      );
    } finally {
      if (previous === undefined) delete process.env.KAKI_AGENDA_PICK;
      else process.env.KAKI_AGENDA_PICK = previous;
    }
  });

  it('starts an untouched demo when the two-topic pick leaves links to topics it dropped', async () => {
    const previous = process.env.KAKI_AGENDA_PICK;
    process.env.KAKI_AGENDA_PICK = '0,4';
    try {
      const scenario = await loadScenario('kopitiam');
      const app = await startApp(scenario);
      await connectService(portOf(app), app.meetingId);
      expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);
      const picked = (await getScenario(app)).agenda.map((item) => item.title);
      expect(picked).toEqual([
        'One counter staff short for the opening rush',
        'Delivery app commission squeeze',
      ]);

      expect((await startMeeting(app)).status).toBe(200);
      const active = await getScenario(app);
      expect(active.agenda.map((item) => item.title)).toEqual(picked);
      expect(() => parseScenario(structuredClone(active))).not.toThrow();
      expect(
        active.agenda.every((item) => (item.links ?? []).every((link) => picked.includes(link.with))),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KAKI_AGENDA_PICK;
      else process.env.KAKI_AGENDA_PICK = previous;
    }
  });

  it('keeps the visitor-shaped lobby agenda across a restart, so Start seals the same topics', async () => {
    const scenario = await loadScenario('kopitiam');
    const chosen = scenario.agenda.slice(0, 2).map(({ title, minutes }) => ({ title, minutes }));
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: scenario.meetingTitle,
      agenda: chosen,
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Booth Playtest')).status).toBe(200);
    const lobby = structuredClone(await getScenario(first));
    expect(lobby.agenda).toHaveLength(2);
    await firstPersistence.flush();
    expect(store.saved?.lobbyAgenda).toEqual(lobby.agenda.map((item) => item.title));

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const restoredView = await getScenario(restored);
    expect(restoredView.agenda.map((item) => item.title)).toEqual(lobby.agenda.map((item) => item.title));
    expect((await getSetup(restored)).title).toBe(scenario.meetingTitle);

    expect((await startMeeting(restored)).status).toBe(200);
    const running = await getScenario(restored);
    expect(running.agenda.map((item) => item.title)).toEqual(lobby.agenda.map((item) => item.title));
  });

  it('saves a Start in flight as the shaped lobby, so a restart keeps the agenda it was sealing', async () => {
    const scenario = await loadScenario('kopitiam');
    const chosen = scenario.agenda.slice(0, 2).map(({ title, minutes }) => ({ title, minutes }));
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: scenario.meetingTitle,
      agenda: chosen,
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Booth Playtest')).status).toBe(200);
    const lobby = structuredClone(await getScenario(first));
    expect(lobby.agenda).toHaveLength(2);

    // A Start is in flight: the session is starting while people may still see the lobby.
    first.session.beginStart(first.session.active(), await getSetup(first));
    first.hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'screen' },
      payload: { speaker: 'Booth', text: 'A line while starting.', timestamp: new Date().toISOString() },
    });
    first.instance.persistence?.scheduleSave();
    await settle(20);
    await firstPersistence.flush();
    const whileStarting = structuredClone(store.saved);
    expect(whileStarting?.phase).toBe('lobby');
    expect(whileStarting?.lobbyAgenda).toEqual(lobby.agenda.map((item) => item.title));

    first.session.abortStart('restart while starting');
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({
          store: new MemoryStore(),
          saved: whileStarting,
          log: () => undefined,
        }),
      },
    );
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(
      lobby.agenda.map((item) => item.title),
    );

    expect((await startMeeting(restored)).status).toBe(200);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(
      lobby.agenda.map((item) => item.title),
    );
  });

  it('starts an owner-edited setup whose linked topics were narrowed', async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app), app.meetingId);
    const setup = await getSetup(app);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    if (weiLing === undefined) throw new Error('Expected the Wei Ling seat');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    setup.agenda = [
      {
        id: 'agenda-1',
        title: 'One counter staff short for the opening rush',
        minutes: 5,
        ownerRoleId: 'operations_director',
      },
      { id: 'agenda-2', title: 'Delivery app commission squeeze', minutes: 4, ownerRoleId: 'marketing_lead' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.agenda.map((item) => item.title)).toEqual([
      'One counter staff short for the opening rush',
      'Delivery app commission squeeze',
    ]);
    expect(
      active.agenda.every((item) =>
        (item.links ?? []).every((link) => active.agenda.some((candidate) => candidate.title === link.with)),
      ),
    ).toBe(true);
    expect(() => parseScenario(structuredClone(active))).not.toThrow();
  });

  it('makes the admitted person the one human and keeps their colleague AI-voiced', async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app), app.meetingId);
    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    const voiced = active.npcs?.map((npc) => npc.attendee) ?? [];
    expect(voiced).toContain('Wei Ling');
    expect(voiced).not.toContain('Arjun');
    expect((await getSetup(app)).seats).toContainEqual(
      expect.objectContaining({ displayName: 'Arjun', kind: 'person' }),
    );
  });

  it('refuses setup writes while Start is waiting for the runner and seals the original draft', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario);
    const service = await connectHeldService(portOf(app), app.meetingId);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');

    const draft = await getSetup(app);
    draft.title = 'Changed while starting';
    draft.agenda[0]!.minutes = 99;
    const blocked = await putSetup(app, draft);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: "The meeting is starting; setup can't change now.",
    });

    service.reply('ready');
    expect((await starting).status).toBe(200);
    const active = await getScenario(app);
    expect(active.agenda[0]!.minutes).not.toBe(99);
    expect((await getSetup(app)).title).not.toBe('Changed while starting');
  });

  it('leaves the pack it was running when Start fails', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario);

    const before = structuredClone(await getScenario(app));
    const draft = await getSetup(app);
    draft.title = 'A different meeting';
    draft.roles = draft.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    draft.agenda.push({ id: 'agenda-4', title: 'A custom topic', minutes: 3, ownerRoleId: 'barista' });
    expect((await putSetup(app, draft)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(503);
    const after = await getScenario(app);
    // A failed Start never applies the draft: the meeting is still the pack it was in the lobby,
    // with its own agenda, roles and cast, and the draft is left for the owner to retry.
    expect(agendaShape(after)).toEqual(agendaShape(before));
    expect(after.roles.map(({ id, label, facilitator }) => ({ id, label, facilitator: facilitator === true }))).toEqual(
      before.roles.map(({ id, label, facilitator }) => ({ id, label, facilitator: facilitator === true })),
    );
    expect(after.npcs?.map((npc) => npc.attendee)).toEqual(before.npcs?.map((npc) => npc.attendee));
    expect((await getSetup(app)).title).toBe('A different meeting');
  });

  it('restores a custom agenda after the meeting ended and holds it for review', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [
        { title: 'Prep', minutes: 5 },
        { title: 'Close', minutes: 4 },
        { title: 'A custom close', minutes: 3 },
      ],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Cook')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);
    expect(firstState.started).toBe(true);

    await endRealMeeting(first);
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const reopened = await meetingState(restored);
    expect(reopened.meetingId).toBe(firstState.meetingId);
    expect(reopened.started).toBe(false);
    // The restart restores the ended meeting as it really is: still under review, with the plan
    // it ran. Start cannot open the next meeting until the owner releases this one.
    expect(restored.session.phase()).toBe('ended');
    expect(restored.session.reviewingEndedTeamMeeting()).toBe(true);
    expect(restored.session.active().agenda.map((item) => item.title)).toEqual([
      'Prep',
      'Close',
      'A custom close',
    ]);
    expect((await startMeeting(restored)).status).toBe(409);

    const closed = await fetch(url(restored, '/api/meeting/close'), {
      method: 'POST',
    });
    expect(closed.status).toBe(200);
    expect(restored.session.phase()).toBe('lobby');
    expect(restored.session.reviewingEndedTeamMeeting()).toBe(false);
  });

  it('restores the pack agenda, roles and cast on reset after a custom agenda', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app), app.meetingId);
    const original = structuredClone(await getScenario(app));

    const setup = await getSetup(app);
    setup.roles = setup.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    setup.agenda.push({ id: 'agenda-4', title: 'A custom topic', minutes: 3, ownerRoleId: 'barista' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    expect((await getScenario(app)).agenda.map((item) => item.title)).toContain('A custom topic');

    // A practice meeting's screen cannot drive the room, so reset through the same session reset.
    app.session.reset();

    const after = await getScenario(app);
    expect(agendaShape(after)).toEqual(agendaShape(original));
    expect(after.roles).toEqual(original.roles);
    expect(after.npcs).toEqual(original.npcs);
    // A practice reset keeps the visitor's own draft; it never leaks into the meeting now running.
    expect(await getSetup(app)).toEqual(setup);
  });

  it('applies a new setup role and publishes a scenario the runner can parse', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario);
    await connectService(portOf(app), app.meetingId);
    const setup = await getSetup(app);
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.agenda.push({ id: 'agenda-4', title: 'Runner handover', minutes: 3, ownerRoleId: 'runner' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.roles).toContainEqual(
      expect.objectContaining({ id: 'runner', label: 'Runner', facilitator: false }),
    );
    const parsed = parseScenario(structuredClone(active));
    expect(parsed.agenda.find((item) => item.title === 'Runner handover')?.ownerRole).toBe('runner');
  });

  it('refuses Start when nobody has joined', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    const response = await startMeeting(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Join the meeting before pressing Start.' });
    expect((await meetingState(app)).started).toBe(false);
  });

  it('keeps a PUT title, roles and agenda through the first join and Start', async () => {
    const app = await startApp(structuredClone(topicScenario));
    const setup = await getSetup(app);
    setup.title = 'Friday prep';
    setup.roles = setup.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    setup.agenda = [
      { id: 'agenda-1', title: 'Close', minutes: 2, ownerRoleId: 'cashier' },
      { id: 'agenda-2', title: 'Prep', minutes: 3, ownerRoleId: 'chef' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    expect((await join(app, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);

    const active = await getScenario(app);
    expect(active.meetingTitle).toBe('Friday prep');
    expect(active.roles[0]?.label).toBe('Head Chef');
    expect(active.agenda.map(({ title, minutes, ownerRole }) => ({ title, minutes, ownerRole }))).toEqual([
      { title: 'Close', minutes: 2, ownerRole: 'cashier' },
      { title: 'Prep', minutes: 3, ownerRole: 'chef' },
    ]);
    expect((await getSetup(app)).title).toBe('Friday prep');
  });

  it('keeps an unconsumed edited draft across a restart before anyone joins', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Restart prep',
      agenda: [{ title: 'Close', minutes: 2 }],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    const edited = await getSetup(first);
    edited.title = 'Restart prep';
    edited.roles = edited.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    edited.agenda = [{ id: 'agenda-1', title: 'Close', minutes: 2, ownerRoleId: edited.roles[0]!.id }];
    expect((await putSetup(first, edited)).status).toBe(200);
    await firstPersistence.flush();
    expect(store.saved?.startedAt).toBeUndefined();

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    expect(await getSetup(restored)).toEqual(edited);
    expect((await joinReal(restored, 'Cook')).status).toBe(200);
    expect((await startMeeting(restored)).status).toBe(200);
    const active = await getScenario(restored);
    expect(active.meetingTitle).toBe('Restart prep');
    expect(active.agenda.map((item) => item.title)).toEqual(['Close']);
    // The draft that survived the restart is still the next meeting's setup.
    expect(restored.session.draft().roles[0]?.label).toBe('Head Chef');
  });

  it('reshapes the two-topic agenda after New meeting and after an ended meeting resets', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const app = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app), app.meetingId);
    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);
    expect((await getScenario(app)).agenda).toHaveLength(2);

    // New meeting and an ended meeting both reset through the same session reset.
    app.session.reset();
    // A reset forgets its holders, so the person joins the new meeting before Start.
    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);
    const afterNew = structuredClone(await getScenario(app));
    expect(afterNew.agenda).toHaveLength(2);
    expect(afterNew.agenda.every((item) => pack.agenda.some((packItem) => packItem.title === item.title))).toBe(true);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(afterNew));

    // An ended meeting's silent END is the same session reset.
    app.session.reset();
    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);
    const afterEnd = structuredClone(await getScenario(app));
    expect(afterEnd.agenda).toHaveLength(2);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(afterEnd));
  });

  it('offers only the person seats an edited draft names', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = defaultMeetingSetup(pack);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    arjun.kind = 'ai';
    arjun.npcProfileId = 'Arjun';
    const scenario = meetingScenarioFromSetup(pack, setup);
    const app = await startApp(scenario);

    expect((await getScenario(app)).joinSeats).toEqual(['operations_director']);
    const refused = await join(app, 'Guest', 'tech_pos_lead');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/not a human seat/);
    expect((await join(app, 'Guest', 'operations_director')).status).toBe(200);
  });

  it('still refuses a visitor named like a character after another person took that seat', async () => {
    const app = await startApp(await loadScenario('kopitiam'), { admissionReservationMs: 0 });
    await connectService(portOf(app), app.meetingId);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    expect((await getSetup(app)).seats).toContainEqual(
      expect.objectContaining({ displayName: 'Wei Ling', kind: 'person' }),
    );

    const refused = await join(app, 'Wei Ling', 'operations_director');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toMatch(/AI attendee/);
  });

  it('leaves the pack agenda and its excluded pairs when Start fails', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const app = await startApp(scenario);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);
    const before = structuredClone(await getScenario(app));

    const pair = pack.excludedPairs?.[0];
    if (pair === undefined) throw new Error('The Kopitiam scenario needs an excluded pair');
    const first = pack.agenda.find((item) => item.title === pair[0]);
    const second = pack.agenda.find((item) => item.title === pair[1]);
    if (first === undefined || second === undefined) throw new Error('The excluded pair must name agenda items');
    const setup = await getSetup(app);
    setup.agenda = [
      { id: 'agenda-1', title: first.title, minutes: first.minutes, ownerRoleId: first.ownerRole },
      { id: 'agenda-2', title: second.title, minutes: second.minutes, ownerRoleId: second.ownerRole },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(503);
    const after = await getScenario(app);
    // A failed Start never applies the narrowed draft: the room stays on the pack it was showing,
    // with the same agenda and the same excluded pairs.
    expect(agendaShape(after)).toEqual(agendaShape(before));
    expect(after.roles.map(({ id, label }) => ({ id, label }))).toEqual(
      before.roles.map(({ id, label }) => ({ id, label })),
    );
    expect(after.npcs?.map((npc) => npc.attendee)).toEqual(before.npcs?.map((npc) => npc.attendee));
    expect(after.excludedPairs).toEqual(before.excludedPairs);
  });

  it('seats two people under their own names, with no third person in the meeting', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    expect((await putSetup(app, humanOnlySetup(pack))).status).toBe(200);
    expect((await getScenario(app)).joinSeats).toEqual(['operations_director', 'tech_pos_lead']);

    const first = await joinReal(app, 'Alice');
    expect(first.status).toBe(200);
    const firstSeat = ((await first.json()) as { participantRole: string }).participantRole;
    const second = await joinReal(app, 'Ben');
    expect(second.status).toBe(200);
    const secondSeat = ((await second.json()) as { participantRole: string }).participantRole;
    expect(firstSeat).not.toBe(secondSeat);

    // The lobby shows the owner's plan, while the people who joined are the meeting's holders.
    expect(app.session.holders().map((holder) => holder.name.toLowerCase())).toEqual(['alice', 'ben']);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.attendees.map((attendee) => attendee.name.toLowerCase())).toEqual(['alice', 'ben']);
    expect(active.roles.map((role) => role.id)).toEqual(expect.arrayContaining([firstSeat, secondSeat]));
  });

  it('keeps an AI meeting to one person when its setup names two person seats', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = defaultMeetingSetup(pack);
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (arjun === undefined) throw new Error('Expected Arjun’s seat');
    arjun.kind = 'person';
    delete arjun.npcProfileId;
    expect(setup.seats.filter((seat) => seat.kind === 'ai').length).toBeGreaterThan(0);
    // A legacy or derived setup can name two people while the pack's AI stand-ins are still present.
    const scenario = meetingScenarioFromSetup(pack, setup);
    expect(scenario.joinSeats).toEqual(['operations_director', 'tech_pos_lead']);
    const app = await startApp(scenario);

    const first = await join(app, 'Alice', 'operations_director');
    expect(first.status).toBe(200);
    const second = await join(app, 'Ben', 'tech_pos_lead');
    expect([403, 409]).toContain(second.status);
    expect(((await second.json()) as { error: string }).error).toMatch(
      /Practice access|Meetings with AI stand-ins take one person|seat is taken/i,
    );
  });

  it('admits a renamed person role by its id and shows the new label', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Lunch service readiness',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    const setup = await getSetup(app);
    expect(pack.roles.some((role) => role.id === 'operations_director')).toBe(true);
    setup.roles = [
      { id: 'operations_director', label: 'Floor Lead', facilitator: false },
      { id: 'tech_pos_lead', label: 'Tech & POS Lead', facilitator: false },
    ];
    setup.seats = [{ displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' }];
    setup.agenda = [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'operations_director' }];
    expect((await putSetup(app, setup)).status).toBe(200);

    // The offered seat keeps its canonical id, and the lobby shows the owner's label.
    const offered = await getScenario(app);
    expect(offered.joinSeats).toEqual(['operations_director']);
    expect(offered.roles.find((role) => role.id === 'operations_director')?.label).toBe('Floor Lead');

    expect((await joinReal(app, 'Booth Playtest')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    // The owner's renamed role stays in the next-draft setup; the running meeting seats its people.
    expect(app.session.draft().roles.find((role) => role.id === 'operations_director')?.label).toBe('Floor Lead');
  });

  it('offers and seats a role added in setup', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    const setup = humanOnlySetup(pack);
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' },
      { displayName: 'Runner One', roleId: 'runner', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    const offered = await getScenario(app);
    expect(offered.joinSeats).toEqual(['operations_director', 'runner']);
    expect(offered.roles.find((role) => role.id === 'runner')?.label).toBe('Runner');

    const first = await joinReal(app, 'Alice');
    expect(first.status).toBe(200);
    const firstSeat = ((await first.json()) as { participantRole: string }).participantRole;
    const second = await joinReal(app, 'Bob');
    expect(second.status).toBe(200);
    const secondSeat = ((await second.json()) as { participantRole: string }).participantRole;
    expect(firstSeat).not.toBe(secondSeat);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.roles.find((role) => role.id === secondSeat)?.label).toBe('Bob');
    expect(active.roles.map((role) => role.id)).toEqual(expect.arrayContaining([firstSeat, secondSeat]));
  });

  it('seats people in setup roles that the demo pack has never heard of', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    const setup = humanOnlySetup(pack);
    setup.roles.push(
      { id: 'ops_lead', label: 'Ops Lead', facilitator: false },
      { id: 'floor_lead', label: 'Floor Lead', facilitator: false },
    );
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'ops_lead', kind: 'person' },
      { displayName: 'Arjun', roleId: 'floor_lead', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    expect((await getScenario(app)).joinSeats).toEqual(['ops_lead', 'floor_lead']);
    const first = await joinReal(app, 'Alice');
    expect(first.status).toBe(200);
    const firstSeat = ((await first.json()) as { participantRole: string }).participantRole;
    expect((await joinReal(app, 'Bob')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    // A real meeting seats each person under their own id, never a pack role.
    expect(active.roles.map((role) => role.id)).toContain(firstSeat);
    expect(active.roles.map((role) => role.id)).not.toContain('operations_director');
  });

  it('refuses an unknown role id with the ids this meeting offers', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    const refused = await join(app, 'Guest', 'astronaut');
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('"astronaut" is not a human seat');
    expect(body.error).toContain('operations_director (Operations Director)');
    expect(body.error).toContain('tech_pos_lead (Tech & POS Lead)');
  });

  it('refuses a role label where a role id is required', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    const refused = await join(app, 'Guest', 'Marketing Lead');
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('"Marketing Lead" is not a human seat');
    expect(body.error).toContain('marketing_lead (Marketing Lead)');
  });

  it('starts a pack-free human-only meeting with no AI runner connected', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    expect((await putSetup(app, humanOnlySetup(pack))).status).toBe(200);
    expect((await joinReal(app, 'Alice')).status).toBe(200);
    expect((await joinReal(app, 'Ben')).status).toBe(200);

    const started = await startMeeting(app);
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual(expect.objectContaining({ started: true }));
    expect((await getScenario(app)).npcs ?? []).toEqual([]);
  });

  it('keeps the owner pace and a present agenda owner in the real meeting seal and scenario', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    expect((await joinReal(app, 'Alice')).status).toBe(200);
    expect((await joinReal(app, 'Ben')).status).toBe(200);
    const alice = app.session.holders().find((holder) => holder.displayName === 'Alice');
    if (alice === undefined) throw new Error('Alice did not join');
    const setup = humanOnlySetup(pack);
    setup.roles.push({ id: alice.seat, label: 'Alice', facilitator: false });
    setup.pace = { quietCheckAfter: 90, comingUpBefore: 45 };
    setup.agenda = [
      { id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: alice.seat },
    ];
    setup.seats = [
      { displayName: 'Alice', roleId: alice.seat, kind: 'person' },
      { displayName: 'Ben', roleId: 'tech_pos_lead', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);

    const sealed = app.session.sealed();
    expect(sealed?.pace).toEqual(setup.pace);
    expect(sealed?.agenda[0]?.ownerRoleId).toBe(alice?.seat);
    expect((await getScenario(app)).agenda[0]?.ownerRole).toBe(alice?.seat);
  });

  it('keeps the sealed agenda owner through a late joiner roster refresh', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor huddle',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });
    expect((await joinReal(app, 'Alice')).status).toBe(200);
    expect((await joinReal(app, 'Ben')).status).toBe(200);
    const alice = app.session.holders().find((holder) => holder.displayName === 'Alice');
    if (alice === undefined) throw new Error('Alice did not join');
    const setup = humanOnlySetup(pack);
    setup.roles.push({ id: alice.seat, label: 'Alice', facilitator: false });
    setup.agenda = [
      { id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: alice.seat },
    ];
    setup.seats = [
      { displayName: 'Alice', roleId: alice.seat, kind: 'person' },
      { displayName: 'Ben', roleId: 'tech_pos_lead', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);

    // A person who joins after Start refreshes the roster: the owner must survive, and the late
    // joiner must get their own plain seat, with no AI attendee appearing.
    expect((await joinReal(app, 'Cy')).status).toBe(200);
    const afterJoin = await getScenario(app);
    const cy = app.session.holders().find((holder) => holder.name.toLowerCase() === 'cy');
    expect(cy).toBeDefined();
    expect(afterJoin.agenda[0]?.ownerRole).toBe(alice?.seat);
    expect(afterJoin.roles.some((role) => role.id === cy?.seat)).toBe(true);
    expect(afterJoin.attendees.some((attendee) => attendee.name === 'Cy')).toBe(true);
    expect(afterJoin.npcs ?? []).toEqual([]);
  });

  it('starts a team meeting filled in from a blank plan, with no demo-pack facts', async () => {
    const pack = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(meetings, {
      title: 'Floor planning',
      agenda: [{ title: 'Opening checklist', minutes: 5 }],
    });

    const blankResponse = await startBlankSetup(app);
    expect(blankResponse.status).toBe(200);
    const blank = ((await blankResponse.json()) as { setup: MeetingSetup }).setup;
    expect(blank).toEqual({
      title: '',
      agenda: [],
      roles: [],
      seats: [],
      pace: DEFAULT_MEETING_PACE,
      source: {
        title: 'typed',
        agenda: 'typed',
        roles: 'typed',
        seats: 'typed',
        pace: 'typed',
      },
    });
    expect(await getSetup(app)).toEqual(blank);

    const filled: MeetingSetup = {
      ...blank,
      title: 'Floor planning',
      roles: [{ id: 'chair', label: 'Chair', facilitator: true }],
      agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'chair' }],
      seats: [{ displayName: 'Alice', roleId: 'chair', kind: 'person' }],
    };
    expect((await putSetup(app, filled)).status).toBe(200);
    expect(isPackFreeMeeting(filled, pack)).toBe(true);

    // The lobby shows the pack-free plan the owner typed, including its one person seat.
    const lobby = await getScenario(app);
    expect(lobby.meetingTitle).toBe('Floor planning');
    expect(lobby.joinSeats).toEqual(['chair']);
    expect(lobby.situation).toBeUndefined();
    expect(lobby.npcs ?? []).toEqual([]);

    expect((await joinReal(app, 'Alice')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.npcs ?? []).toEqual([]);
    expect(active.meetingTitle).toBe('Floor planning');
    expect(active.agenda.map((item) => item.title)).toEqual(['Opening checklist']);
  });

  it('serves an opened pack-free draft lobby to the owner and the public without the demo story', async () => {
    const pack = await loadScenario('kopitiam');
    const store = createMemoryAuthStore();
    const owner = await signInGoogle(store, 'Ada Owner');
    const auth = createAuth({ store});
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(
      meetings,
      {
        ownerUserId: owner.userId,
        title: 'Lunch service readiness',
        agenda: [{ title: 'Prep', minutes: 5 }],
      },
      { auth },
    );

    const getScenarioAs = async (as: 'owner' | 'public'): Promise<Scenario> => {
      const response = await fetch(url(app, '/api/scenario'), as === 'owner' ? { headers: { cookie: owner.cookie } } : undefined);
      expect(response.status).toBe(200);
      return (await response.json()) as Scenario;
    };

    // A real meeting's untouched lobby is its own plan, never the demo pack's story.
    const initial = await getScenarioAs('owner');
    expect(initial.meetingTitle).toBe('Lunch service readiness');
    expect(initial.situation).toBeUndefined();

    const setup: MeetingSetup = {
      title: 'Floor huddle',
      organisation: 'Harbour Bakery',
      agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'chair' }],
      roles: [
        { id: 'chair', label: 'Chair', facilitator: true },
        { id: 'scribe', label: 'Scribe', facilitator: false },
      ],
      seats: [
        { displayName: 'Alice', roleId: 'chair', kind: 'person' },
        { displayName: 'Ben', roleId: 'scribe', kind: 'person' },
      ],
      pace: DEFAULT_MEETING_PACE,
      source: { title: 'typed', agenda: 'typed', roles: 'typed', seats: 'typed', pace: 'typed' },
    };
    expect(isPackFreeMeeting(setup, pack)).toBe(true);
    const saved = await fetch(url(app, '/api/setup'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify(setup),
    });
    expect(saved.status).toBe(200);

    const checkDraftView = (view: Scenario): void => {
      expect(view.meetingTitle).toBe('Floor huddle');
      expect(view.organisation).toBe('Harbour Bakery');
      expect(view.situation).toBeUndefined();
      expect(view.background).toBeUndefined();
      expect(view.npcs ?? []).toEqual([]);
      expect(view.attendees.map((attendee) => attendee.name)).toEqual(['Alice', 'Ben']);
    };

    // Before Start the owner sees the meeting Start will seal, not the pack it came from.
    checkDraftView(await getScenarioAs('owner'));

    // The plan the owner opens is frozen for the public, and it is the same pack-free meeting.
    const opened = await fetch(url(app, '/api/meeting/open'), { method: 'POST', headers: { cookie: owner.cookie } });
    expect(opened.status).toBe(200);
    checkDraftView(await getScenarioAs('owner'));
    checkDraftView(await getScenarioAs('public'));
  });

  it('ends a blank-plan meeting with minutes for the chair and only present people quiet', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const query = JSON.parse(String(init?.body)).query as string;
      const data = query.includes('Login')
        ? { authentication: { login: { jwt: 'jwt', responseResult: { succeeded: true } } } }
        : { pages: { create: { responseResult: { succeeded: true } } } };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const authStore = createMemoryAuthStore();
    const owner = await signInGoogle(authStore, 'Alice');
    const auth = createAuth({ store: authStore, offeredRoles: () => []});
    const meetings = createMemoryMeetingStore();
    const app = await startRealApp(
      meetings,
      {
        ownerUserId: owner.userId,
        title: 'Floor planning',
        agenda: [{ title: 'Opening checklist', minutes: 5 }],
      },
      {
        auth,
        modules: [
          createMeetingModule({ notetakerIntervalMs: 20 }),
          createWikiModule({
            wiki: { url: 'http://wiki.test', email: 'a@b.test', password: 'pw' },
            fetchImpl,
            minutesDelayMs: 10,
            today: () => '2026-11-20',
          }),
        ],
      },
    );

    // The owner holds the facilitator's chair; the guest is the one other person present.
    const ownerJoin = await joinReal(app, 'Alice', owner.cookie);
    expect(ownerJoin.status).toBe(200);
    // Taking a seat retires the account's old session and hands back the host's seat session.
    const ownerCookie = cookieFrom(ownerJoin);
    const ownerSeat = ((await ownerJoin.json()) as { participantRole: string }).participantRole;
    const guest = await joinGuest(app, 'Ben');
    expect((await startMeeting(app, ownerCookie)).status).toBe(200);

    const screen = await connectScreen(app, ownerCookie);
    // The chair talks for over a minute, so the notetaker has enough to judge who was quiet.
    app.hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'screen' },
      payload: {
        speaker: 'Alice',
        text: Array.from({ length: 160 }, () => 'word').join(' '),
        timestamp: new Date().toISOString(),
      },
    });
    const record = await waitForEvent(
      screen,
      (event) =>
        event.type === 'MEETING_RECORD_UPDATED' && (event.payload.quietRoles?.length ?? 0) > 0,
      'a record that names who was quiet',
    );
    if (record.type !== 'MEETING_RECORD_UPDATED') throw new Error('expected a meeting record');
    const quietRoles = record.payload.quietRoles ?? [];
    // Only the person in the room is quiet; the chair is not, and nobody absent is counted.
    expect(quietRoles).toContain(guest.seat);
    expect(quietRoles).not.toContain(ownerSeat);
    expect(quietRoles).not.toEqual(expect.arrayContaining(['chef', 'cashier', 'barista']));

    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.ended === true,
      'the meeting to end',
    );
    const minutes = await waitFor(
      () => app.tasks.list().find((task) => task.purpose === 'meeting_minutes'),
      'the minutes card',
    );
    expect(minutes.assignee).toBe(ownerSeat);
    expect(minutes.suggestedAssignee).toBe(ownerSeat);
    expect(minutes.status).toBe('DRAFT_READY');

    // The chair is the one role that can approve the card, and does.
    const chair = await connectRole(portOf(app), app.meetingId, ownerSeat, ownerCookie);
    chair.ws.send(
      JSON.stringify({ type: 'APPROVE_ACTION', taskId: minutes.id, draft: minutes.draft }),
    );
    const done = await waitFor(
      () => (app.tasks.get(minutes.id)?.status === 'COMPLETED' ? app.tasks.get(minutes.id) : undefined),
      'the chair to approve the minutes',
    );
    expect(done?.artifactUrl).toBe('http://wiki.test/en/meetings/2026-11-20-floor-planning-meeting-minutes');
    screen.close();
    chair.close();
  });

  it('imports the Kopitiam template with person seats for a team meeting', async () => {
    const pack = await loadScenario('kopitiam');
    const calendar: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };
    const invite = buildMeetingInviteIcs(
      {
        uid: KOPITIAM_INVITE_UID,
        title: 'Kopitiam launch',
        agenda: [{ title: 'Launch checklist', minutes: 5, owner: 'Wei Ling' }],
        people: ['Wei Ling', 'Mei'],
      },
      { start: '2026-11-11 07:30', end: '2026-11-11 08:00' },
    );
    const app = await startApp(pack, {
      calendar,
      calendarFetch: vi.fn<typeof fetch>(async () => new Response(invite)),
    });

    const response = await fetch(url(app, '/api/setup/import-calendar'), {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const setup = ((await response.json()) as { setup: MeetingSetup }).setup;
    expect(setup.seats.map((seat) => seat.displayName)).toEqual(['Wei Ling', 'Mei']);
    expect(setup.seats.every((seat) => seat.kind === 'person')).toBe(true);
    expect(setup.seats.some((seat) => seat.npcProfileId !== undefined)).toBe(false);
  });

  it('keeps a saved blank plan readable after a restart', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [{ title: 'Prep', minutes: 5 }],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await startBlankSetup(first)).status).toBe(200);
    await firstPersistence.flush();

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const setup = await getSetup(restored);
    expect(setup.title).toBe('');
    expect(setup.agenda).toEqual([]);
    expect(setup.roles).toEqual([]);
    expect(setup.seats).toEqual([]);
    expect((await getScenario(restored)).joinSeats).toEqual([]);
  });

  it('treats an edited draft a meeting ended with as consumed after a restart', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Team playtest',
      agenda: [{ title: 'Prep', minutes: 5 }],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    const setup = await getSetup(first);
    setup.title = 'Edited before end';
    setup.agenda = [{ id: 'agenda-1', title: 'Edited topic', minutes: 5, ownerRoleId: setup.roles[0]!.id }];
    expect((await putSetup(first, setup)).status).toBe(200);
    expect((await joinReal(first, 'First Visitor')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);

    await endRealMeeting(first);
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const expected = expectedRealSetup(row);
    expect(await getSetup(restored)).toEqual(expected);
    // An ended real meeting is under review: the owner closes and reopens it for the next person.
    expect((await fetch(url(restored, '/api/meeting/close'), { method: 'POST' })).status).toBe(200);
    expect((await fetch(url(restored, '/api/meeting/open'), { method: 'POST' })).status).toBe(200);
    expect((await joinReal(restored, 'Second Visitor')).status).toBe(200);
  });

  it('keeps the ended meeting saved intact when the owner edits the next draft', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [{ title: 'Custom A', minutes: 3 }],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Cook')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    await endRealMeeting(first);

    const next = await getSetup(first);
    next.agenda = [{ id: 'agenda-1', title: 'Custom B', minutes: 3, ownerRoleId: next.roles[0]!.id }];
    expect((await putSetup(first, next)).status).toBe(200);
    await firstPersistence.flush();

    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.sealed?.agenda.map((item) => item.title)).toEqual(['Custom A']);
    expect((await getSetup(first)).agenda.map((item) => item.title)).toEqual(['Custom B']);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const restoredState = await meetingState(restored);
    expect(restoredState.meetingId).toBe(firstState.meetingId);
    expect(restoredState.started).toBe(false);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(['Custom A']);
    // The ended meeting is consumed, but the draft edited after END is the next meeting's setup.
    expect((await getSetup(restored)).agenda.map((item) => item.title)).toEqual(['Custom B']);
  });

  it('keeps the ended meeting saved intact when a new setup replaces the next draft', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [{ title: 'Custom A', minutes: 3 }],
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Cook')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    await endRealMeeting(first);

    const next = await getSetup(first);
    next.title = 'Calendar B';
    next.agenda = [{ id: 'agenda-1', title: 'Calendar B', minutes: 5, ownerRoleId: next.roles[0]!.id }];
    expect((await putSetup(first, next)).status).toBe(200);
    await firstPersistence.flush();

    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.sealed?.agenda.map((item) => item.title)).toEqual(['Custom A']);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    const restoredState = await meetingState(restored);
    expect(restoredState.meetingId).toBe(firstState.meetingId);
    expect(restoredState.started).toBe(false);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(['Custom A']);
  });

  it('forgets a departed seat holder once the grace ends, so Start asks someone to join', async () => {
    const pack = await loadScenario('kopitiam');
    // Let the join's seat reservation expire first: a live reservation keeps the holder on purpose.
    const app = await startApp(pack, { rejoinGraceMs: 20, rejoinPollMs: 5, admissionReservationMs: 20 });
    expect((await join(app, 'Departed', 'tech_pos_lead')).status).toBe(200);
    // The room poll sees the empty room and the short grace runs out; the holder is pruned.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const setup = humanOnlySetup(pack);
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'operations_director', kind: 'person' },
      { displayName: 'Mei', roleId: 'menu_store_lead', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    const response = await startMeeting(app);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Join the meeting before pressing Start/i);
  });

  it('lets a new visitor take any human seat after an untouched demo ends and the server restarts', async () => {
    const scenario = await loadScenario('kopitiam');
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: scenario.meetingTitle,
      agenda: scenario.agenda.slice(0, 2).map(({ title, minutes }) => ({ title, minutes })),
    });
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      { persistence: firstPersistence },
    );
    expect((await joinReal(first, 'Booth Playtest')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    await endRealMeeting(first);
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.draftTouched).toBe(false);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startRealApp(
      meetings,
      { meetingId: row.id, title: row.title, agenda: row.agenda },
      {
        persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      },
    );
    expect((await meetingState(restored)).meetingId).toBe(firstState.meetingId);
    const next = await getScenario(restored);
    // A real lobby names no owner-set seats, so the next person may take their own plain seat.
    expect(next.joinSeats).toEqual([]);
    expect(next.npcs ?? []).toEqual([]);
    // The owner releases the ended meeting and reopens the room, then the next person joins.
    expect((await fetch(url(restored, '/api/meeting/close'), { method: 'POST' })).status).toBe(200);
    expect((await fetch(url(restored, '/api/meeting/open'), { method: 'POST' })).status).toBe(200);
    expect((await joinReal(restored, 'Second Visitor')).status).toBe(200);
  });

  it('returns an edited draft to untouched after Start and end, so the next visitor takes any human seat', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Team playtest',
      agenda: [{ title: 'Prep', minutes: 5 }],
    });
    const app = await startRealApp(meetings, {
      meetingId: row.id,
      title: row.title,
      agenda: row.agenda,
    });
    const setup = await getSetup(app);
    setup.title = 'Edited before end';
    setup.agenda = [{ id: 'agenda-1', title: 'Edited topic', minutes: 5, ownerRoleId: setup.roles[0]!.id }];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await joinReal(app, 'First Visitor')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);

    await endRealMeeting(app);

    // The owner releases the ended meeting and reopens the room; its edited draft is consumed with it.
    expect((await fetch(url(app, '/api/meeting/close'), { method: 'POST' })).status).toBe(200);
    expect((await fetch(url(app, '/api/meeting/open'), { method: 'POST' })).status).toBe(200);
    expect((await getScenario(app)).joinSeats).toEqual([]);
    expect((await joinReal(app, 'Second Visitor')).status).toBe(200);
    expect(await getSetup(app)).toEqual(expectedRealSetup(row));
    expect((await getScenario(app)).joinSeats).toEqual([]);
  });

  it('keeps a returning seat holder in their seat within the grace of a running edited meeting', async () => {
    const app = await startApp(await loadScenario('kopitiam'), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app), app.meetingId);
    const setup = await getSetup(app);
    setup.title = 'Friday huddle';
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const meetingId = (await meetingState(app)).meetingId;

    const back = await join(app, 'Booth Playtest', 'operations_director');
    expect(back.status).toBe(200);
    expect(((await back.json()) as { resumed?: boolean }).resumed).toBe(true);
    expect((await meetingState(app)).meetingId).toBe(meetingId);
  });

  it('refuses Start when a joined person is not a person seat in the setup being sealed', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    expect((await join(app, 'Booth Playtest', 'tech_pos_lead')).status).toBe(200);
    const setup = await getSetup(app);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    arjun.kind = 'ai';
    arjun.npcProfileId = 'Arjun';
    expect((await putSetup(app, setup)).status).toBe(200);

    const response = await startMeeting(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This meeting's setup has no place for Tech & POS Lead; the owner set the seats.",
    });
    expect((await meetingState(app)).started).toBe(false);
  });

  it('refuses a setup whose facilitator cannot share a briefing, naming the role and topic', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await startApp(pack);
    const setup = await getSetup(app);
    const operationsDirectorIndex = setup.roles.findIndex((role) => role.id === 'operations_director');
    if (operationsDirectorIndex < 0) throw new Error('Expected the operations_director role');
    setup.roles[operationsDirectorIndex]!.facilitator = true;

    const response = await putSetup(app, setup);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string; message: string }> };
    expect(body.errors?.some((problem) => problem.field === `roles[${operationsDirectorIndex}].facilitator`)).toBe(true);
    expect(
      body.errors?.some(
        (problem) =>
          /Wei Ling/.test(problem.message) &&
          /Operations Director/.test(problem.message) &&
          /One counter staff short/.test(problem.message),
      ),
    ).toBe(true);
    expect((await getSetup(app)).roles[operationsDirectorIndex]!.facilitator).toBe(false);
  });

  it('refuses Start with a saved invalid setup as 422 rather than a server error', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = operationsDirectorAsFacilitator(pack);
    const app = await startApp(pack);
    // The saved draft is the same value a restart would restore; Start validates it before touching
    // the meeting, so the failure is the field-specific 422 and never a server error.
    app.session.setDraft(setup);
    expect((await join(app, 'Booth Playtest', 'operations_director')).status).toBe(200);

    const response = await startMeeting(app);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string; message: string }> };
    expect(body.errors?.some((problem) => /facilitator/.test(problem.field) || /facilitator/.test(problem.message))).toBe(true);
    expect(app.session.phase()).toBe('lobby');
    expect((await meetingState(app)).started).toBe(false);
  });

  it('refuses to boot a saved meeting whose clock points at a missing agenda item', async () => {
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: 'Test meeting',
      agenda: [{ title: 'Prep', minutes: 5 }],
    });
    const saved = storedMeetingWithSetup(expectedRealSetup(row), true);
    saved.state.clock.agendaIndex = 99;
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, saved, log: () => undefined });
    const app = await startBootApp(meetings, persistence);

    await expect(app.registry.get(row.id)).rejects.toThrow(
      /Saved meeting is unreadable \(its clock points at an agenda item that is not saved\)\. Run `npm run meeting:reset -- <meetingId>` to discard it\./,
    );
  });

  it('gives the friendly message for a malformed saved setup', async () => {
    const valid = defaultMeetingSetup(testScenario);
    const saved = {
      schemaVersion: MEETING_STATE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      setup: { ...valid, roles: [null] },
      meetingCode: 'ABC123',
      seats: [],
      state: {
        meetingId: 'saved-meeting',
        agenda: ['Prep'],
        clock: {
          started: true,
          ended: false,
          paused: false,
          agendaIndex: 0,
          itemElapsedSeconds: 0,
          meetingElapsedSeconds: 0,
        },
        notetaker: {},
        tasks: [],
      },
    } as unknown as StoredMeeting;
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({ workspaceId: 'workspace-1', ownerUserId: 'test-owner', title: 'Test meeting' });
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, saved, log: () => undefined });
    const app = await startBootApp(meetings, persistence);
    await expect(app.registry.get(row.id)).rejects.toThrow(
      /Saved meeting is unreadable \(its draft setup is invalid/,
    );
  });
});
