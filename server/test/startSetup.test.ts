import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  aiCast,
  buildMeetingInviteIcs,
  DEFAULT_MEETING_PACE,
  defaultMeetingSetup,
  humanRoles,
  isPackFreeMeeting,
  KOPITIAM_INVITE_UID,
  meetingScenarioFromSetup,
  parseScenario,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import type { CalendarSettings } from '../src/action/calendar';
import { createWikiModule } from '../src/action/wiki';
import { createApp, type CreateAppOptions, type KakiApp } from '../src/app';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/loadScenario';
import type { KakiModule } from '../src/modules';
import { createMeetingPersistence } from '../src/persist/persistence';
import { MEETING_STATE_SCHEMA_VERSION, type MeetingStateStore, type StoredMeeting } from '../src/persist/state';
import { connectClient, portOf, settle, waitFor, waitForEvent } from './helpers';
import { testScenario } from './fixtures/scenario';

const packScenario: Scenario = {
  ...testScenario,
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
    { name: 'Cy', role: 'barista', zoomDisplayName: 'Cy (Barista)' },
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
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
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
    agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'producer' }],
    seats: [
      { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
      { displayName: 'Arjun', roleId: 'lead_programmer', kind: 'person' },
    ],
  };
}

/** The real pack's setup with the producer role wrongly marked as the facilitator. */
function producerAsFacilitator(pack: Scenario): MeetingSetup {
  const setup = defaultMeetingSetup(structuredClone(pack));
  const producer = setup.roles.find((role) => role.id === 'producer');
  if (producer === undefined) throw new Error('Expected the producer role');
  producer.facilitator = true;
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
    holders: [{ name: 'Wei Ling', seat: 'producer' }],
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

/** A fresh copy every time: Start mutates the active scenario, so tests must not share one. */
function freshTopicScenario(): Scenario {
  const scenario = structuredClone(topicScenario);
  return {
    ...scenario,
    agenda: scenario.agenda.filter((item) => item.title === 'Prep' || item.title === 'Close'),
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

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

async function startApp(scenario: Scenario, options: Omit<CreateAppOptions, 'scenario'> = {}): Promise<KakiApp> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...options,
  });
  apps.push(app);
  return app;
}

function startMeeting(app: KakiApp): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/start`, { method: 'POST' });
}

async function getSetup(app: KakiApp): Promise<MeetingSetup> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/setup`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { setup: MeetingSetup }).setup;
}

function putSetup(app: KakiApp, setup: MeetingSetup): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/setup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
}

function startBlankSetup(app: KakiApp): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/setup/blank`, { method: 'POST' });
}

async function getScenario(app: KakiApp): Promise<Scenario> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/scenario`);
  expect(response.status).toBe(200);
  return (await response.json()) as Scenario;
}

async function meetingState(app: KakiApp): Promise<{ meetingId: string; started: boolean; startedAt?: string }> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`);
  expect(response.status).toBe(200);
  return (await response.json()) as { meetingId: string; started: boolean; startedAt?: string };
}

async function connectService(port: number): Promise<{ socket: WebSocket; prepares: unknown[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`);
  const prepares: unknown[] = [];
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
    prepares.push(message.request);
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
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

async function connectHeldService(port: number): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`);
  const prepares: PrepareRequest[] = [];
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: Partial<PrepareRequest>;
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
      return;
    }
    prepares.push({ requestId, attempt, meetingId });
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

async function join(app: KakiApp, participantName: string, participantRole: string): Promise<Response> {
  await fetch(`http://localhost:${portOf(app)}/api/meeting/open`, { method: 'POST' });
  return fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName, participantRole }),
  });
}

async function joinWithCode(
  app: KakiApp,
  participantName: string,
  participantRole: string,
  meetingCode: string,
): Promise<Response> {
  await fetch(`http://localhost:${portOf(app)}/api/meeting/open`, { method: 'POST' });
  return fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName, participantRole, meetingCode }),
  });
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
    const { prepares } = await connectService(portOf(app));
    const before = await getScenario(app);

    const response = await startMeeting(app);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string }> };
    expect(body.error).toMatch(/setup is not valid/i);
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'agenda[0].minutes' }));
    await settle(50);
    expect(prepares).toHaveLength(0);
    expect((await getScenario(app)).agenda).toEqual(before.agenda);
    const state = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
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
    const screen = await connectClient(portOf(app), 'screen');
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
    const app = await startApp(structuredClone(packScenario));
    await connectService(portOf(app));
    const setup = await getSetup(app);
    const ada = setup.seats.find((seat) => seat.displayName === 'Ada');
    const bao = setup.seats.find((seat) => seat.displayName === 'Bao');
    expect(bao?.kind).toBe('ai');
    if (ada === undefined || bao === undefined) throw new Error('Expected Ada and Bao seats');
    // Keep exactly one person, as the setup contract requires when AI stand-ins are present.
    ada.kind = 'ai';
    ada.npcProfileId = 'Ada';
    bao.kind = 'person';
    delete bao.npcProfileId;
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'cashier')).status).toBe(200);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.npcs?.map((npc) => npc.attendee)).toEqual(['Ada', 'Cy']);
  });

  it("starts the default Kopitiam setup as today's meeting", async () => {
    const scenario = await loadScenario('kopitiam');
    // A snapshot that createApp and Start may both mutate; the expectations compare against this.
    const pack = structuredClone(scenario);
    const app = await startApp(scenario);
    await connectService(portOf(app));
    const setup = await getSetup(app);
    expect(setup).toEqual(defaultMeetingSetup(pack));
    expect(setup.pace).toEqual(DEFAULT_MEETING_PACE);

    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
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
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(testScenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence,
    });
    const setup = await getSetup(app);
    setup.agenda[0]!.minutes = 2;
    setup.agenda.push({ id: 'agenda-2', title: 'After the break', minutes: 3, ownerRoleId: 'cashier' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    await persistence.flush();

    const restoredStore = store;
    const restored = await startApp(testScenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store: restoredStore, saved: restoredStore.saved, log: () => undefined }),
    });
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
    const state = (await (await fetch(`http://127.0.0.1:${portOf(restored)}/api/meeting/state`)).json()) as {
      started: boolean;
    };
    expect(state.started).toBe(true);
  });

  it('keeps the two-topic agenda admission shuffled when Start runs an untouched draft', async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app));
    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);

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
      await connectService(portOf(app));
      expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);

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
      await connectService(portOf(app));
      expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);
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
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    expect((await join(first, 'Booth Playtest', 'producer')).status).toBe(200);
    const chosen = structuredClone(await getScenario(first));
    expect(chosen.agenda).toHaveLength(2);
    await firstPersistence.flush();
    expect(store.saved?.lobbyAgenda).toEqual(chosen.agenda.map((item) => item.title));

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(await loadScenario('kopitiam'), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    const restoredView = await getScenario(restored);
    expect(restoredView.agenda.map((item) => item.title)).toEqual(chosen.agenda.map((item) => item.title));
    expect((await getSetup(restored)).title).toBe(defaultMeetingSetup(structuredClone(scenario)).title);

    await connectService(portOf(restored));
    expect((await startMeeting(restored)).status).toBe(200);
    const running = await getScenario(restored);
    expect(running.agenda.map((item) => item.title)).toEqual(chosen.agenda.map((item) => item.title));
  });

  it('saves a Start in flight as the shaped lobby, so a restart keeps the agenda it was sealing', async () => {
    const scenario = await loadScenario('kopitiam');
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    const service = await connectHeldService(portOf(first));
    expect((await join(first, 'Booth Playtest', 'producer')).status).toBe(200);
    const chosen = structuredClone(await getScenario(first));
    expect(chosen.agenda).toHaveLength(2);

    const starting = startMeeting(first);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    // Any saved event while the Start is in flight must persist the lobby shape, never running.
    first.hub.publish({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'screen' },
      payload: { speaker: 'Booth', text: 'A line while starting.', timestamp: new Date().toISOString() },
    });
    await settle(20);
    await firstPersistence.flush();
    const whileStarting = structuredClone(store.saved);
    expect(whileStarting?.phase).toBe('lobby');
    expect(whileStarting?.lobbyAgenda).toEqual(chosen.agenda.map((item) => item.title));

    service.reply('failed', 'restart while starting');
    expect((await starting).status).toBe(503);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restoredStore = new MemoryStore();
    const restored = await startApp(await loadScenario('kopitiam'), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({
        store: restoredStore,
        saved: whileStarting,
        log: () => undefined,
      }),
    });
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(
      chosen.agenda.map((item) => item.title),
    );

    await connectService(portOf(restored));
    expect((await startMeeting(restored)).status).toBe(200);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(
      chosen.agenda.map((item) => item.title),
    );
  });

  it('starts an owner-edited setup whose linked topics were narrowed', async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app));
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
        ownerRoleId: 'producer',
      },
      { id: 'agenda-2', title: 'Delivery app commission squeeze', minutes: 4, ownerRoleId: 'marketing_lead' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);

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
    await connectService(portOf(app));
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);

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
    const service = await connectHeldService(portOf(app));
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

  it('puts the agenda, roles and cast back exactly as they were when Start fails', async () => {
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
    // The lobby shows the saved draft: its own agenda, renamed roles and seats. The failed Start
    // applied nothing to the running meeting, so the cast is still the pack's.
    expect(agendaShape(after)).toEqual(
      draft.agenda.map(({ title, minutes, ownerRoleId }) => ({ title, minutes, ownerRole: ownerRoleId })),
    );
    expect(after.roles.map(({ id, label, facilitator }) => ({ id, label, facilitator: facilitator === true }))).toEqual(
      draft.roles.map(({ id, label, facilitator }) => ({ id, label, facilitator })),
    );
    expect(after.npcs).toEqual(before.npcs);
    expect((await getSetup(app)).title).toBe('A different meeting');
  });

  it('restores a custom agenda after the meeting ended and really reopens it', async () => {
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    const setup = await getSetup(first);
    setup.agenda.push({ id: 'agenda-3', title: 'A custom close', minutes: 3, ownerRoleId: 'cashier' });
    expect((await putSetup(first, setup)).status).toBe(200);
    expect((await join(first, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);
    expect(firstState.started).toBe(true);

    const screen = await connectClient(portOf(first), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    const reopened = await meetingState(restored);
    expect(reopened.meetingId).toBe(firstState.meetingId);
    expect(reopened.started).toBe(false);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual([
      'Prep',
      'Close',
      'A custom close',
    ]);
    expect((await startMeeting(restored)).status).toBe(200);
    const running = await meetingState(restored);
    expect(running.started).toBe(true);
    expect(running.meetingId).toBe(firstState.meetingId);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual([
      'Prep',
      'Close',
      'A custom close',
    ]);
  });

  it('restores the pack agenda, roles, cast and default draft on reset after a custom agenda', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app));
    const original = structuredClone(await getScenario(app));
    const defaultDraft = defaultMeetingSetup(original);

    const setup = await getSetup(app);
    setup.roles = setup.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    setup.agenda.push({ id: 'agenda-4', title: 'A custom topic', minutes: 3, ownerRoleId: 'barista' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    expect((await getScenario(app)).agenda.map((item) => item.title)).toContain('A custom topic');

    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset');
    screen.close();

    const after = await getScenario(app);
    expect(agendaShape(after)).toEqual(agendaShape(original));
    expect(after.roles).toEqual(original.roles);
    expect(after.npcs).toEqual(original.npcs);
    expect(await getSetup(app)).toEqual(defaultDraft);
  });

  it('applies a new setup role and publishes a scenario the runner can parse', async () => {
    const scenario = structuredClone(packScenario);
    scenario.npcs![0]!.playable = true;
    const app = await startApp(scenario);
    await connectService(portOf(app));
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
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    const edited = await getSetup(first);
    edited.title = 'Restart prep';
    edited.roles = edited.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role));
    edited.agenda = [{ id: 'agenda-1', title: 'Close', minutes: 2, ownerRoleId: 'cashier' }];
    expect((await putSetup(first, edited)).status).toBe(200);
    await firstPersistence.flush();
    expect(store.saved?.startedAt).toBeUndefined();

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    expect(await getSetup(restored)).toEqual(edited);
    expect((await join(restored, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(restored)).status).toBe(200);
    const active = await getScenario(restored);
    expect(active.meetingTitle).toBe('Restart prep');
    expect(active.roles[0]?.label).toBe('Head Chef');
    expect(active.agenda.map((item) => item.title)).toEqual(['Close']);
  });

  it('reshapes the two-topic agenda after New meeting and after an ended meeting resets', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const app = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app));
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
    const screen = await connectClient(portOf(app), 'screen');
    expect((await getScenario(app)).agenda).toHaveLength(2);

    screen.messages.length = 0;
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the New meeting reset');
    // A reset forgets its holders, so the person joins the new meeting before Start.
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
    const afterNew = structuredClone(await getScenario(app));
    expect(afterNew.agenda).toHaveLength(2);
    expect(afterNew.agenda.every((item) => pack.agenda.some((packItem) => packItem.title === item.title))).toBe(true);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(afterNew));

    screen.messages.length = 0;
    screen.ws.send(JSON.stringify({ type: 'END_MEETING', silent: true }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset after the end');
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
    const afterEnd = structuredClone(await getScenario(app));
    expect(afterEnd.agenda).toHaveLength(2);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(afterEnd));
    screen.close();
  });

  it('admits only the person seats an edited draft names', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    const setup = await getSetup(app);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    arjun.kind = 'ai';
    arjun.npcProfileId = 'Arjun';
    expect((await putSetup(app, setup)).status).toBe(200);

    expect((await getScenario(app)).joinSeats).toEqual(['producer']);
    const refused = await join(app, 'Guest', 'lead_programmer');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "This meeting's setup has no place for Tech & POS Lead; the owner set the seats.",
    });
    expect((await join(app, 'Guest', 'producer')).status).toBe(200);
  });

  it('still refuses a visitor named like a character after another person took that seat', async () => {
    const app = await startApp(await loadScenario('kopitiam'), { admissionReservationMs: 0 });
    await connectService(portOf(app));
    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    expect((await getSetup(app)).seats).toContainEqual(
      expect.objectContaining({ displayName: 'Wei Ling', kind: 'person' }),
    );

    const refused = await join(app, 'Wei Ling', 'lead_programmer');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error?: string }).error).toMatch(/AI attendee/);
  });

  it('puts excludedPairs back when Start fails', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const app = await startApp(scenario);
    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);
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
    // The failed Start leaves the room in the lobby, so the browser follows the saved plan it
    // would start next: the excluded pair itself, not the pack placeholder it replaced.
    expect(agendaShape(after)).toEqual(
      setup.agenda.map(({ title, minutes, ownerRoleId }) => ({ title, minutes, ownerRole: ownerRoleId })),
    );
    // The setup named the same roles; the lobby now also shows their facilitator flag.
    expect(after.roles.map(({ id, label }) => ({ id, label }))).toEqual(
      before.roles.map(({ id, label }) => ({ id, label })),
    );
    expect(after.npcs).toEqual(before.npcs);
    expect(after.excludedPairs).toEqual(before.excludedPairs);
  });

  it('seats exactly the setup person seats: two people join, a third is refused', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await startApp(pack);
    expect((await putSetup(app, humanOnlySetup(pack))).status).toBe(200);
    expect((await getScenario(app)).joinSeats).toEqual(['producer', 'lead_programmer']);

    const first = await join(app, 'Alice', 'producer');
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;

    expect((await joinWithCode(app, 'Ben', 'lead_programmer', code)).status).toBe(200);
    const third = await joinWithCode(app, 'Cara', 'producer', code);
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: string }).error).toMatch(/seat is taken|full/i);
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
    expect(scenario.joinSeats).toEqual(['producer', 'lead_programmer']);
    const app = await startApp(scenario);

    const first = await join(app, 'Alice', 'producer');
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    const second = await joinWithCode(app, 'Ben', 'lead_programmer', code);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(
      /Meetings with AI stand-ins take one person/,
    );
  });

  it('admits a renamed person role by its id and shows the new label', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    await connectService(portOf(app));
    const setup = await getSetup(app);
    const producer = setup.roles.find((role) => role.id === 'producer');
    if (producer === undefined) throw new Error('Expected the producer role');
    producer.label = 'Floor Lead';
    expect((await putSetup(app, setup)).status).toBe(200);

    // The offered seat keeps its canonical id, and the lobby shows the owner's label.
    const offered = await getScenario(app);
    expect(offered.joinSeats).toEqual(['producer']);
    expect(offered.roles.find((role) => role.id === 'producer')?.label).toBe('Floor Lead');

    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    expect((await getScenario(app)).roles.find((role) => role.id === 'producer')?.label).toBe('Floor Lead');
  });

  it('offers and seats a role added in setup, counting it toward capacity', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await startApp(pack);
    const setup = humanOnlySetup(pack);
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
      { displayName: 'Runner One', roleId: 'runner', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    const offered = await getScenario(app);
    expect(offered.joinSeats).toEqual(['producer', 'runner']);
    expect(offered.roles.find((role) => role.id === 'runner')?.label).toBe('Runner');

    const first = await join(app, 'Alice', 'producer');
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    expect((await joinWithCode(app, 'Bob', 'runner', code)).status).toBe(200);
    // Two person seats, one of them the new role: a third person does not fit.
    expect((await joinWithCode(app, 'Cara', 'runner', code)).status).toBe(409);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.roles.find((role) => role.id === 'runner')?.label).toBe('Runner');
    expect(active.joinSeats).toEqual(['producer', 'runner']);
  });

  it('seats people in setup roles that the demo pack has never heard of', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await startApp(pack);
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
    const first = await join(app, 'Alice', 'ops_lead');
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    expect((await joinWithCode(app, 'Bob', 'floor_lead', code)).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.roles.map((role) => role.id)).toEqual(
      expect.arrayContaining(['ops_lead', 'floor_lead']),
    );
  });

  it('refuses an unknown role id with the ids this meeting offers', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    const refused = await join(app, 'Guest', 'astronaut');
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('"astronaut" is not a human seat');
    expect(body.error).toContain('producer (Operations Director)');
    expect(body.error).toContain('lead_programmer (Tech & POS Lead)');
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
    const app = await startApp(pack);
    expect((await putSetup(app, humanOnlySetup(pack))).status).toBe(200);
    const first = await join(app, 'Alice', 'producer');
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    expect((await joinWithCode(app, 'Ben', 'lead_programmer', code)).status).toBe(200);

    const started = await startMeeting(app);
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual(expect.objectContaining({ started: true }));
    expect((await getScenario(app)).npcs ?? []).toEqual([]);
  });

  it('starts a team meeting filled in from a blank plan, with no demo-pack facts', async () => {
    const pack = await loadScenario('kopitiam');
    const app = await startApp(pack);

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

    expect((await join(app, 'Alice', 'chair')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.npcs ?? []).toEqual([]);
    expect(active.roles.map((role) => role.id)).toContain('chair');
  });

  it('ends a blank-plan meeting with minutes for the chair and only present people quiet', async () => {
    const pack = await loadScenario('kopitiam');
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
    const app = await startApp(pack, {
      modules: [
        createMeetingModule({ notetakerIntervalMs: 20 }),
        createWikiModule({
          wiki: { url: 'http://wiki.test', email: 'a@b.test', password: 'pw' },
          fetchImpl,
          minutesDelayMs: 10,
          today: () => '2026-11-20',
        }),
      ],
    });
    const blank = ((await (await startBlankSetup(app)).json()) as { setup: MeetingSetup }).setup;
    const filled: MeetingSetup = {
      ...blank,
      title: 'Floor planning',
      roles: [
        { id: 'chair', label: 'Chair', facilitator: true },
        { id: 'scribe', label: 'Scribe', facilitator: false },
        { id: 'ops', label: 'Ops', facilitator: false },
      ],
      agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 5, ownerRoleId: 'chair' }],
      seats: [
        { displayName: 'Alice', roleId: 'chair', kind: 'person' },
        { displayName: 'Ben', roleId: 'scribe', kind: 'person' },
        { displayName: 'Cara', roleId: 'ops', kind: 'person' },
      ],
    };
    expect((await putSetup(app, filled)).status).toBe(200);

    const alice = await join(app, 'Alice', 'chair');
    expect(alice.status).toBe(200);
    const { meetingCode } = (await alice.json()) as { meetingCode: string };
    expect((await joinWithCode(app, 'Ben', 'scribe', meetingCode)).status).toBe(200);
    // Cara never joins: her seat must not be offered work or counted as quiet.
    expect((await startMeeting(app)).status).toBe(200);

    const screen = await connectClient(portOf(app), 'screen');
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
    expect(quietRoles).toContain('scribe');
    expect(quietRoles).not.toContain('ops');
    expect(quietRoles).not.toEqual(expect.arrayContaining(['chef', 'cashier', 'barista']));

    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    const minutes = await waitFor(
      () => app.tasks.list().find((task) => task.purpose === 'meeting_minutes'),
      'the minutes card',
    );
    expect(minutes.assignee).toBe('chair');
    expect(minutes.suggestedAssignee).toBe('chair');
    expect(minutes.status).toBe('DRAFT_READY');

    // The chair is the one role that can approve the card, and does.
    const chair = await connectClient(portOf(app), 'chair');
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

    const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/setup/import-calendar`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const setup = ((await response.json()) as { setup: MeetingSetup }).setup;
    expect(setup.seats.map((seat) => seat.displayName)).toEqual(['Wei Ling', 'Mei']);
    expect(setup.seats.every((seat) => seat.kind === 'person')).toBe(true);
    expect(setup.seats.some((seat) => seat.npcProfileId !== undefined)).toBe(false);
  });

  it('keeps a saved blank plan readable after a restart', async () => {
    const pack = await loadScenario('kopitiam');
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(pack, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    expect((await startBlankSetup(first)).status).toBe(200);
    await firstPersistence.flush();

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(pack, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    const setup = await getSetup(restored);
    expect(setup.title).toBe('');
    expect(setup.agenda).toEqual([]);
    expect(setup.roles).toEqual([]);
    expect(setup.seats).toEqual([]);
    expect((await getScenario(restored)).joinSeats).toEqual([]);
  });

  it('treats an edited draft a meeting ended with as consumed after a restart', async () => {
    const pack = await loadScenario('kopitiam');
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(structuredClone(pack), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    await connectService(portOf(first));
    const setup = await getSetup(first);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    arjun.kind = 'ai';
    arjun.npcProfileId = 'Arjun';
    expect((await putSetup(first, setup)).status).toBe(200);
    expect((await join(first, 'First Visitor', 'producer')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);

    const screen = await connectClient(portOf(first), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(structuredClone(pack), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    expect(await getSetup(restored)).toEqual(defaultMeetingSetup(pack));
    expect((await join(restored, 'Second Visitor', 'lead_programmer')).status).toBe(200);
  });

  it('keeps the ended meeting saved intact when the owner edits the next draft', async () => {
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    const setup = await getSetup(first);
    setup.agenda = [{ id: 'agenda-1', title: 'Custom A', minutes: 3, ownerRoleId: 'chef' }];
    expect((await putSetup(first, setup)).status).toBe(200);
    expect((await join(first, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    const screen = await connectClient(portOf(first), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();

    const next = await getSetup(first);
    next.agenda = [{ id: 'agenda-1', title: 'Custom B', minutes: 3, ownerRoleId: 'chef' }];
    expect((await putSetup(first, next)).status).toBe(200);
    await firstPersistence.flush();

    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.sealed?.agenda.map((item) => item.title)).toEqual(['Custom A']);
    expect((await getSetup(first)).agenda.map((item) => item.title)).toEqual(['Custom B']);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    const restoredState = await meetingState(restored);
    expect(restoredState.meetingId).toBe(firstState.meetingId);
    expect(restoredState.started).toBe(false);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(['Custom A']);
    // The ended meeting is consumed, but the draft edited after END is the next meeting's setup.
    expect((await getSetup(restored)).agenda.map((item) => item.title)).toEqual(['Custom B']);
  });

  it('keeps the ended meeting saved intact when the calendar import replaces the next draft', async () => {
    const calendar: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };
    const invite = buildMeetingInviteIcs(
      {
        uid: KOPITIAM_INVITE_UID,
        title: 'Calendar B',
        agenda: [{ title: 'Calendar B', minutes: 5, owner: 'Chef' }],
        people: ['Ada', 'Bao'],
      },
      { start: '2026-11-11 07:30', end: '2026-11-11 08:00' },
    );
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
      calendar,
      calendarFetch: vi.fn<typeof fetch>(async () => new Response(invite)),
    });
    const setup = await getSetup(first);
    setup.agenda = [{ id: 'agenda-1', title: 'Custom A', minutes: 3, ownerRoleId: 'chef' }];
    expect((await putSetup(first, setup)).status).toBe(200);
    expect((await join(first, 'Cook', 'chef')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    const screen = await connectClient(portOf(first), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();

    const imported = await fetch(`http://127.0.0.1:${portOf(first)}/api/setup/import-calendar`, {
      method: 'POST',
    });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { setup: MeetingSetup }).setup.title).toBe('Calendar B');
    await firstPersistence.flush();

    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.sealed?.agenda.map((item) => item.title)).toEqual(['Custom A']);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(freshTopicScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    const restoredState = await meetingState(restored);
    expect(restoredState.meetingId).toBe(firstState.meetingId);
    expect(restoredState.started).toBe(false);
    expect((await getScenario(restored)).agenda.map((item) => item.title)).toEqual(['Custom A']);
  });

  it('forgets a departed seat holder once the grace ends, so Start asks someone to join', async () => {
    const pack = await loadScenario('kopitiam');
    // Let the join's seat reservation expire first: a live reservation keeps the holder on purpose.
    const app = await startApp(pack, { rejoinGraceMs: 20, rejoinPollMs: 5, admissionReservationMs: 20 });
    expect((await join(app, 'Departed', 'lead_programmer')).status).toBe(200);
    // The room poll sees the empty room and the short grace runs out; the holder is pruned.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const setup = humanOnlySetup(pack);
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
      { displayName: 'Mei', roleId: 'game_designer', kind: 'person' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);

    const response = await startMeeting(app);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Join the meeting before pressing Start/i);
  });

  it('lets a new visitor take any human seat after an untouched demo ends and the server restarts', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const store = new MemoryStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: firstPersistence,
    });
    await connectService(portOf(first));
    expect((await join(first, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    const firstState = await meetingState(first);

    const screen = await connectClient(portOf(first), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();
    await firstPersistence.flush();
    expect(store.saved?.state.clock.ended).toBe(true);
    expect(store.saved?.draftTouched).toBe(false);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(await loadScenario('kopitiam'), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
    });
    expect((await meetingState(restored)).meetingId).toBe(firstState.meetingId);
    const next = await getScenario(restored);
    expect(next.joinSeats).toBeUndefined();
    expect(humanRoles(next).map((role) => role.id)).toEqual(
      expect.arrayContaining(pack.roles.filter((role) => role.facilitator !== true).map((role) => role.id)),
    );
    expect((await join(restored, 'Second Visitor', 'producer')).status).toBe(200);
  });

  it('returns an edited draft to untouched after Start and end, so the next visitor takes any human seat', async () => {
    const scenario = await loadScenario('kopitiam');
    const pack = structuredClone(scenario);
    const app = await startApp(scenario, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      admissionReservationMs: 0,
    });
    await connectService(portOf(app));
    const setup = await getSetup(app);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'person';
    delete weiLing.npcProfileId;
    arjun.kind = 'ai';
    arjun.npcProfileId = 'Arjun';
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'First Visitor', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);

    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();

    // The ended meeting's setup is consumed: the next arrival starts an untouched meeting.
    expect((await getScenario(app)).joinSeats).toBeUndefined();
    expect((await join(app, 'Second Visitor', 'lead_programmer')).status).toBe(200);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));
    expect((await getScenario(app)).joinSeats).toBeUndefined();
  });

  it('keeps a returning seat holder in their seat within the grace of a running edited meeting', async () => {
    const app = await startApp(await loadScenario('kopitiam'), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    await connectService(portOf(app));
    const setup = await getSetup(app);
    setup.title = 'Friday huddle';
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Booth Playtest', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    const meetingId = (await meetingState(app)).meetingId;

    const back = await join(app, 'Booth Playtest', 'producer');
    expect(back.status).toBe(200);
    expect(((await back.json()) as { resumed?: boolean }).resumed).toBe(true);
    expect((await meetingState(app)).meetingId).toBe(meetingId);
  });

  it('refuses Start when a joined person is not a person seat in the setup being sealed', async () => {
    const app = await startApp(await loadScenario('kopitiam'));
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
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
    const producerIndex = setup.roles.findIndex((role) => role.id === 'producer');
    if (producerIndex < 0) throw new Error('Expected the producer role');
    setup.roles[producerIndex]!.facilitator = true;

    const response = await putSetup(app, setup);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string; message: string }> };
    expect(body.errors?.some((problem) => problem.field === `roles[${producerIndex}].facilitator`)).toBe(true);
    expect(
      body.errors?.some(
        (problem) =>
          /Wei Ling/.test(problem.message) &&
          /Operations Director/.test(problem.message) &&
          /One counter staff short/.test(problem.message),
      ),
    ).toBe(true);
    expect((await getSetup(app)).roles[producerIndex]!.facilitator).toBe(false);
  });

  it('refuses Start with a saved invalid setup as 422 rather than a server error', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = producerAsFacilitator(pack);
    const saved = storedMeetingWithSetup(setup, false);
    const store = new MemoryStore();
    const app = await startApp(pack, {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved, log: () => undefined }),
    });

    const response = await startMeeting(app);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string; errors?: Array<{ field: string; message: string }> };
    expect(body.errors?.some((problem) => /facilitator/.test(problem.field) || /facilitator/.test(problem.message))).toBe(true);
    expect(app.session.phase()).toBe('lobby');
    expect((await meetingState(app)).started).toBe(false);
  });

  it('refuses to boot a saved meeting whose setup describes a meeting that cannot run', async () => {
    const pack = await loadScenario('kopitiam');
    const setup = producerAsFacilitator(pack);
    const saved = storedMeetingWithSetup(setup, true);
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, saved, log: () => undefined });
    await expect(
      startApp(pack, {
        modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
        persistence,
      }),
    ).rejects.toThrow(
      /Saved meeting is unreadable \(its setup describes a meeting that cannot run.*facilitator.*\)\. Run `npm run meeting:reset` to discard it\./,
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
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, saved, log: () => undefined });
    await expect(startApp(testScenario, { persistence })).rejects.toThrow(
      /Saved meeting is unreadable \(its draft setup is invalid/,
    );
  });
});
