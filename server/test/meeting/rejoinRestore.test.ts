import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { defaultMeetingSetup, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingModule } from '../../src/host/meeting';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import { realBaseScenario, realMeetingSetup, realScenarioWithPeople } from '../../src/meeting/realMeeting';
import type { MeetingRow } from '../../src/meeting/types';
import { createMeetingPersistence, type MeetingPersistence } from '../../src/persist/persistence';
import {
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import {
  createTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  type TestAppWithMeeting,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';

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

function savedRunning({
  holders = [{ name: 'ada', seat: 'chef' }],
  abandoned,
}: {
  holders?: Array<{ name: string; seat: string }>;
  abandoned?: boolean;
} = {}): StoredMeeting {
  const setup = defaultMeetingSetup(structuredClone(testScenario));
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: 'meeting-1',
    phase: 'running',
    draft: setup,
    draftTouched: false,
    sealed: setup,
    ...(abandoned === true ? { abandoned: true } : {}),
    holders,
    meetingCode: 'AB12CD',
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:05:00.000Z',
    state: {
      clock: {
        started: true,
        ended: false,
        paused: false,
        agendaIndex: 0,
        itemElapsedSeconds: 30,
        meetingElapsedSeconds: 30,
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

function savedRealRunning(
  row: MeetingRow,
  {
    holders = [{ name: 'ada', seat: 'chef' }],
    abandoned,
  }: {
    holders?: Array<{ name: string; seat: string }>;
    abandoned?: boolean;
  } = {},
): StoredMeeting {
  const base = realBaseScenario(row);
  // A saved setup needs at least one person seat even when nobody holds one right now.
  const sealed = realMeetingSetup(base, holders.length > 0 ? holders : [{ name: 'ada', seat: 'chef' }]);
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: row.id,
    phase: 'running',
    draft: defaultMeetingSetup(base),
    draftTouched: false,
    sealed,
    sealedKind: 'real',
    ...(abandoned === true ? { abandoned: true } : {}),
    holders,
    meetingCode: 'AB12CD',
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:05:00.000Z',
    state: {
      clock: {
        started: true,
        ended: false,
        paused: false,
        agendaIndex: 0,
        itemElapsedSeconds: 30,
        meetingElapsedSeconds: 30,
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

function savedRealEnded(row: MeetingRow): StoredMeeting {
  const running = savedRealRunning(row);
  return {
    ...running,
    phase: 'ended',
    sealedKind: 'real',
    state: { ...running.state, clock: { ...running.state.clock, ended: true } },
  };
}

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

interface StartOptions {
  saved?: StoredMeeting;
  store?: MemoryStore;
  scenario?: Scenario;
  roster?: () => Array<{ name: string }> | undefined | Promise<Array<{ name: string }> | undefined>;
  graceMs?: number;
  pollMs?: number;
  reservationMs?: number;
  persistence?: MeetingPersistence;
}

async function startApp({
  saved,
  store = new MemoryStore(),
  scenario = testScenario,
  roster = () => [],
  graceMs = 20,
  pollMs = 60_000,
  reservationMs,
  persistence,
}: StartOptions = {}): Promise<{ app: KakiApp; persistence: MeetingPersistence; store: MemoryStore }> {
  const saver =
    persistence ?? createMeetingPersistence({ store, saved: saved ?? store.saved, log: () => undefined });
  const app = await createApp({
    speechRecognition: 'browser',
    scenario,
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    persistence: saver,
    roomRoster: async () => roster(),
    rejoinGraceMs: graceMs,
    rejoinPollMs: pollMs,
    ...(reservationMs === undefined ? {} : { admissionReservationMs: reservationMs }),
  });
  apps.push(app);
  return { app, persistence: saver, store };
}

async function join(app: KakiApp, participantName: string, participantRole: string): Promise<Response> {
  await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/open`, { method: 'POST' });
  return fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantName, participantRole }),
  });
}

function startMeeting(app: KakiApp): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/start`, { method: 'POST' });
}

async function meetingId(app: KakiApp): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { meetingId: string }).meetingId;
}

async function connectService(app: KakiApp): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(app)}/ws?role=service`);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId: requested } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || requested === undefined) {
      return;
    }
    socket.send(
      JSON.stringify({ kind: 'ready', requestId, attempt, meetingId: requested }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  app.server.once('close', () => socket.terminate());
}

interface RealStartOptions {
  savedFor?: (row: MeetingRow) => StoredMeeting;
  store?: MemoryStore;
  scenario?: Scenario;
  roster?: () => Array<{ name: string }> | undefined | Promise<Array<{ name: string }> | undefined>;
  graceMs?: number;
  pollMs?: number;
  reservationMs?: number;
  meetings?: MeetingStore;
  row?: MeetingRow;
}

interface RealStarted {
  app: TestAppWithMeeting;
  persistence: MeetingPersistence;
  store: MemoryStore;
  meetings: MeetingStore;
  row: MeetingRow;
}

async function startRealApp({
  savedFor,
  store = new MemoryStore(),
  scenario = testScenario,
  roster = () => [],
  graceMs = 20,
  pollMs = 60_000,
  reservationMs,
  meetings: existingMeetings,
  row: existingRow,
}: RealStartOptions = {}): Promise<RealStarted> {
  const meetings = existingMeetings ?? createMemoryMeetingStore();
  const row = existingRow ?? await meetings.create({
    workspaceId: 'workspace-1',
    ownerUserId: 'test-owner',
    title: 'Weekly planning',
    agenda: scenario.agenda,
  });
  const saved = savedFor?.(row);
  if (saved !== undefined) store.saved = saved;
  const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
  const app = (await createTestApp({
    speechRecognition: 'browser',
    scenario,
    meetings,
    persistenceFor: async () => persistence,
    meetingModules: realModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    roomRoster: async () => roster(),
    rejoinGraceMs: graceMs,
    rejoinPollMs: pollMs,
    ...(reservationMs === undefined ? {} : { admissionReservationMs: reservationMs }),
  })) as TestAppWithMeeting;
  apps.push(app);
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
  return { app, persistence, store, meetings, row };
}

async function joinReal(app: TestAppWithMeeting, participantName: string, participantRole: string): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantName, participantRole }),
  });
}

describe('restoring a running meeting keeps the people LiveKit still shows', () => {
  it('keeps the holder when the roster still shows them at the end of the grace', async () => {
    let rosterCalls = 0;
    const { app } = await startRealApp({
      savedFor: (row) => savedRealRunning(row),
      roster: () => {
        rosterCalls += 1;
        return [{ name: 'Ada' }];
      },
    });

    await settle(80);

    expect(rosterCalls).toBeGreaterThan(0);
    expect(app.session.holders()).toEqual([{ name: 'ada', seat: 'chef' }]);
    expect(app.session.abandoned()).toBe(false);
  });

  it('keeps the holders and logs once when the roster cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app } = await startRealApp({ savedFor: (row) => savedRealRunning(row), roster: () => undefined });

    await settle(80);

    expect(app.session.holders()).toEqual([{ name: 'ada', seat: 'chef' }]);
    expect(app.session.abandoned()).toBe(false);
    const ours = warn.mock.calls.filter((args) => String(args[0]).includes('could not check who is in the room'));
    expect(ours).toHaveLength(1);
  });

  it('prunes and abandons the meeting once the roster confirms the room is empty', async () => {
    const { app, persistence, store } = await startRealApp({
      savedFor: (row) => savedRealRunning(row),
      roster: () => [],
    });

    await settle(80);

    expect(app.session.holders()).toEqual([]);
    expect(app.session.abandoned()).toBe(true);
    await persistence.flush();
    expect(store.saved?.abandoned).toBe(true);
    expect(store.saved?.holders).toEqual([]);
  });
});

describe('a delayed grace read never prunes a replacement meeting', () => {
  it('drops an empty roster answer that a reset and a new Start superseded', async () => {
    let rosterCalls = 0;
    let release!: (roster: Array<{ name: string }>) => void;
    const firstRead = new Promise<Array<{ name: string }>>((resolve) => {
      release = resolve;
    });
    const { app, row } = await startRealApp({
      savedFor: (meeting) => savedRealRunning(meeting),
      roster: () => {
        rosterCalls += 1;
        return rosterCalls === 1 ? firstRead : [];
      },
      graceMs: 20,
      pollMs: 60_000,
    });
    await waitFor(() => (rosterCalls > 0 ? true : undefined), 'the old grace roster read');

    const base = realBaseScenario(row);
    const holder = { name: 'bea', seat: 'cashier' };
    app.session.reset();
    app.session.addHolder(holder);
    app.session.beginStart(realScenarioWithPeople(base, [holder]), realMeetingSetup(base, [holder]));
    app.session.commitStart('2026-01-02T00:00:00.000Z');

    release([]);
    await settle(80);

    expect(app.session.holders()).toEqual([holder]);
    expect(app.session.abandoned()).toBe(false);
    expect(app.session.phase()).toBe('running');
  });
});

describe('an abandoned meeting never resumes after a restart', () => {
  it('starts a fresh meeting for a stranger after the holder left and the grace expired', async () => {
    const store = new MemoryStore();
    let people: Array<{ name: string }> = [];
    const first = await startApp({
      store,
      roster: () => people,
      graceMs: 200,
      pollMs: 5,
      reservationMs: 1,
    });
    await connectService(first.app);
    expect((await join(first.app, 'Ada', 'chef')).status).toBe(200);
    people = [{ name: 'Ada' }];
    expect((await startMeeting(first.app)).status).toBe(200);
    const firstMeetingId = await meetingId(first.app);

    people = [];
    await waitFor(
      () => (first.app.session.abandoned() ? true : undefined),
      'the meeting to be abandoned',
    );
    await first.persistence.flush();
    expect(store.saved?.abandoned).toBe(true);
    expect(store.saved?.holders).toEqual([]);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const restored = await startApp({ store, saved: await store.load(), roster: () => [] });
    const response = await join(restored.app, 'Priya', 'chef');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resumed?: boolean };
    expect(body.resumed).toBe(false);
    expect(await meetingId(restored.app)).not.toBe(firstMeetingId);
    expect(restored.app.session.phase()).toBe('lobby');
  });

  it('refuses a code holder replacing a restored abandoned meeting: only the owner starts the next one', async () => {
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({
      store: createMemoryAuthStore(),
      offeredRoles: () => ['chef', 'cashier'],
      meetingCode,
    });
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({
      store,
      saved: savedRunning({ holders: [], abandoned: true }),
      log: () => undefined,
    });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      auth,
      meetingCode,
      persistence,
      roomRoster: async () => [],
      rejoinGraceMs: 20,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    expect(await meetingId(app)).toBe('meeting-1');

    const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        participantName: 'Mallory',
        participantRole: 'chef',
        meetingCode: meetingCode.value,
      }),
    });

    // Abandoned is not a free-for-all: it never resumes, and replacing a meeting that ran stays the owner's call.
    expect(response.status).toBe(409);
    expect(await meetingId(app)).toBe('meeting-1');
  });
});

describe('a restored running meeting with no holders', () => {
  it('still resumes a running meeting with no holders inside its first grace', async () => {
    const { app } = await startRealApp({
      savedFor: (row) => savedRealRunning(row, { holders: [] }),
      roster: () => [],
      graceMs: 60_000,
    });
    const before = app.session.snapshot().meetingId;

    const response = await joinReal(app, 'Priya', 'chef');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { resumed?: boolean };
    expect(body.resumed).toBe(true);
    expect(app.session.snapshot().meetingId).toBe(before);
    expect(app.session.abandoned()).toBe(false);
  });
});

describe('a restored ended team meeting still under review', () => {
  it('keeps the room open for its minutes review until the owner closes it', async () => {
    const { app } = await startRealApp({
      savedFor: (row) => savedRealEnded(row),
      roster: () => [{ name: 'Ada' }],
      graceMs: 60_000,
      pollMs: 60_000,
    });

    expect(app.session.phase()).toBe('ended');
    expect(app.session.reviewingEndedTeamMeeting()).toBe(true);

    const close = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/close'), { method: 'POST' });
    expect(close.status).toBe(200);
    expect(app.session.phase()).toBe('lobby');
    expect(app.session.reviewingEndedTeamMeeting()).toBe(false);
  });

  it('releases the review when the room is verified empty', async () => {
    const { app } = await startRealApp({
      savedFor: (row) => savedRealEnded(row),
      roster: () => [],
      graceMs: 40,
      pollMs: 5,
      reservationMs: 1,
    });

    await waitFor(
      () => (app.session.reviewingEndedTeamMeeting() === false ? true : undefined),
      'the empty-room expiry to finish the review',
    );
  });
});
