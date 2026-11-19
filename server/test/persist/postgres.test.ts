import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from '../../src/persist/postgres';
import {
  MEETING_STATE_ID,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';

const connectionString = process.env.POSTGRES_URL;

interface RawRow {
  id: string;
  schema_version: number;
  saved_at: Date | string;
  started_at: Date | string;
  state: unknown;
}

const meeting: StoredMeeting = {
  schemaVersion: MEETING_STATE_SCHEMA_VERSION,
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
