import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeetingSetup } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
import { createMeetingPersistence } from '../../src/persist/persistence';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from '../../src/persist/postgres';
import {
  MEETING_STATE_ID,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const connectionString = process.env.POSTGRES_URL;

interface RawRow {
  id: string;
  schema_version: number;
  saved_at: Date | string;
  started_at: Date | string;
  state: unknown;
}

const setup = {
  title: 'Lunch service readiness',
  agenda: [
    { id: 'agenda-1', title: 'Prep', minutes: 5, ownerRoleId: 'chef' },
    { id: 'agenda-2', title: 'Service', minutes: 5, ownerRoleId: 'cashier' },
  ],
  roles: [
    { id: 'chef', label: 'Chef', facilitator: true },
    { id: 'cashier', label: 'Cashier', facilitator: false },
  ],
  seats: [
    { displayName: 'Ada', roleId: 'chef', kind: 'person' as const },
    { displayName: 'Bao', roleId: 'cashier', kind: 'person' as const },
  ],
  pace: { ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 },
  source: {
    title: 'demo pack' as const,
    agenda: 'demo pack' as const,
    roles: 'demo pack' as const,
    seats: 'demo pack' as const,
    pace: 'demo pack' as const,
  },
};

const meeting: StoredMeeting = {
  schemaVersion: MEETING_STATE_SCHEMA_VERSION,
  meetingId: 'meeting-1',
  phase: 'running',
  draft: setup,
  draftTouched: true,
  sealed: setup,
  holders: [{ name: 'ada', seat: 'chef' }],
  meetingCode: 'AB12CD',
  startedAt: '2026-02-03T04:05:06.000Z',
  savedAt: '2026-02-03T04:06:07.000Z',
  state: {
    clock: {
      started: true,
      ended: false,
      paused: false,
      agendaIndex: 1,
      itemElapsedSeconds: 42,
      meetingElapsedSeconds: 102,
    },
    notetaker: {
      pending: [{ speaker: 'Ada (Chef)', text: 'One more thing.' }],
      inFlight: [],
      recentGrounded: [],
      contextAgendaIndex: 1,
      agendaContext: [],
      openQuestions: [{ id: 'q-1', text: 'Who closes?', agendaIndex: 1 }],
      questionCount: 1,
      status: 'ok',
      talkByItem: [[1, { chef: 30 }]],
      talkTotals: [['chef', 30]],
      talkTotal: 30,
    },
    tasks: [],
  },
};

describe.skipIf(connectionString === undefined)('postgres meeting state store', () => {
  let pool: Pool;
  let store: MeetingStateStore;
  let previous: RawRow | undefined;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    pool = new Pool({ connectionString });
    await ensureMeetingStateSchema(pool);
    await ensureMeetingStateSchema(pool);
    const existing = await pool.query<RawRow>(
      'select id, schema_version, saved_at, started_at, state from meeting_state where id = $1',
      [MEETING_STATE_ID],
    );
    previous = existing.rows[0];
    store = createPostgresMeetingStateStore(pool);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query('delete from meeting_state where id = $1', [MEETING_STATE_ID]);
    if (previous !== undefined) {
      await pool.query(
        `insert into meeting_state (id, schema_version, saved_at, started_at, state)
         values ($1, $2, $3, $4, $5)`,
        [previous.id, previous.schema_version, previous.saved_at, previous.started_at, previous.state],
      );
    }
    await pool.end();
  });

  it('saves, loads and clears the one saved meeting', async () => {
    await store.save(meeting);
    const loaded = await store.load();
    expect(loaded).toEqual(meeting);

    await store.save({ ...meeting, startedAt: '2026-02-03T05:00:00.000Z' });
    expect((await store.load())?.startedAt).toBe('2026-02-03T05:00:00.000Z');

    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});


describe.skipIf(connectionString === undefined)('postgres meeting persistence through the app', () => {
  it('keeps the draft edited after END and consumes the ended meeting after a restart', async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    const bootstrap = new Pool({ connectionString });
    const schema = `meeting_persist_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | undefined;
    let app: KakiApp | undefined;
    try {
      await bootstrap.query(`create schema "${schema}"`);
      pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      await ensureMeetingStateSchema(pool);
      const store = createPostgresMeetingStateStore(pool);
      const persistence = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
      app = await createApp({
        speechRecognition: 'browser',
        scenario: testScenario,
        modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
        persistence,
        roomRoster: async () => [],
        rejoinGraceMs: 60_000,
        rejoinPollMs: 60_000,
      });
      const base = `http://127.0.0.1:${portOf(app)}`;
      const request = (path: string, method = 'GET', body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });

      const joined = await request('/api/livekit/token', 'POST', {
        participantName: 'Ada',
        participantRole: 'chef',
      });
      expect(joined.status).toBe(200);
      const setupA = (await (await request('/api/setup')).json()) as { setup: MeetingSetup };
      const draftA: MeetingSetup = {
        ...setupA.setup,
        title: 'Meeting A',
        agenda: [{ id: 'agenda-1', title: 'Prep', minutes: 5, ownerRoleId: 'chef' }],
      };
      expect((await request('/api/setup', 'PUT', draftA)).status).toBe(200);
      expect((await request('/api/meeting/start', 'POST')).status).toBe(200);
      app.session.end();
      const draftB: MeetingSetup = { ...draftA, title: 'Meeting B' };
      expect((await request('/api/setup', 'PUT', draftB)).status).toBe(200);
      await persistence.flush();
      const frozen = await store.load();
      expect(frozen?.phase).toBe('ended');
      expect(frozen?.sealed?.title).toBe('Meeting A');
      expect(frozen?.draft.title).toBe('Meeting B');

      await app.close();
      app = undefined;

      const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
      app = await createApp({
        speechRecognition: 'browser',
        scenario: testScenario,
        modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
        persistence: second,
        roomRoster: async () => [],
        rejoinGraceMs: 60_000,
        rejoinPollMs: 60_000,
      });
      const restoredBase = `http://127.0.0.1:${portOf(app)}`;
      const restoredSetup = (await (await fetch(`${restoredBase}/api/setup`)).json()) as { setup: MeetingSetup; started: boolean };
      expect(restoredSetup.started).toBe(false);
      expect(restoredSetup.setup.title).toBe('Meeting B');
      const state = (await (await fetch(`${restoredBase}/api/meeting/state`)).json()) as { started: boolean };
      expect(state.started).toBe(false);
    } finally {
      if (app !== undefined) await app.close();
      if (pool !== undefined) await pool.end();
      await bootstrap.query(`drop schema "${schema}" cascade`);
      await bootstrap.end();
    }
  });
});
