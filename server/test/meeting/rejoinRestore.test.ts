import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultMeetingSetup, type Scenario } from '@kaki/shared';
import type { KakiApp } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
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
