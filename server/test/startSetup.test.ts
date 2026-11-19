import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  aiCast,
  DEFAULT_MEETING_PACE,
  defaultMeetingSetup,
  parseScenario,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
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

function join(app: KakiApp, participantName: string, participantRole: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName, participantRole }),
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
        const setup = context.meetingDetails?.().setup;
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
    expect(agendaShape(after)).toEqual(agendaShape(before));
    expect(after.roles).toEqual(before.roles);
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
    const afterNew = structuredClone(await getScenario(app));
    expect(afterNew.agenda).toHaveLength(2);
    expect(afterNew.agenda.every((item) => pack.agenda.some((packItem) => packItem.title === item.title))).toBe(true);
    expect(await getSetup(app)).toEqual(defaultMeetingSetup(pack));

    expect((await startMeeting(app)).status).toBe(200);
    expect(agendaShape(await getScenario(app))).toEqual(agendaShape(afterNew));

    screen.messages.length = 0;
    screen.ws.send(JSON.stringify({ type: 'END_MEETING', silent: true }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset after the end');
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
    expect((await join(app, 'Booth Playtest', 'lead_programmer')).status).toBe(200);
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
    expect(agendaShape(after)).toEqual(agendaShape(before));
    expect(after.roles).toEqual(before.roles);
    expect(after.npcs).toEqual(before.npcs);
    expect(after.excludedPairs).toEqual(before.excludedPairs);
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
      /Saved meeting is unreadable \(its setup is invalid/,
    );
  });
});
