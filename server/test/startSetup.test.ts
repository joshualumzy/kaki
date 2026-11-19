import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  aiCast,
  DEFAULT_MEETING_PACE,
  defaultMeetingSetup,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import { createApp, type CreateAppOptions, type KakiApp } from '../src/app';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/loadScenario';
import type { KakiModule } from '../src/modules';
import { createMeetingPersistence } from '../src/persist/persistence';
import type { MeetingStateStore, StoredMeeting } from '../src/persist/state';
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
    const app = await startApp(packScenario);
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

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.npcs?.map((npc) => npc.attendee)).toEqual(['Ada', 'Cy']);
  });

  it("starts the default Kopitiam setup as today's meeting", async () => {
    const scenario = await loadScenario('kopitiam');
    const app = await startApp(scenario);
    await connectService(portOf(app));
    const setup = await getSetup(app);
    expect(setup).toEqual(defaultMeetingSetup(scenario));
    expect(setup.pace).toEqual(DEFAULT_MEETING_PACE);

    expect((await startMeeting(app)).status).toBe(200);
    const active = await getScenario(app);
    expect(active.agenda.map(({ title, minutes, ownerRole }) => ({ title, minutes, ownerRole }))).toEqual(
      scenario.agenda.map(({ title, minutes, ownerRole }) => ({ title, minutes, ownerRole })),
    );
    expect(active.npcs?.map((npc) => npc.attendee)).toEqual(aiCast(scenario, 'Wei Ling').map((npc) => npc.attendee));
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
});
