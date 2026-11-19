import type { Pool } from 'pg';
import {
  MEETING_STATE_ID,
  type MeetingStateStore,
  type SavedMeetingState,
  type SavedSeatAssignment,
  type StoredMeeting,
} from './state';

/** Create the meeting_state table if it is missing; safe to run on every startup, like the auth tables. */
export async function ensureMeetingStateSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists meeting_state (
      id text primary key,
      schema_version integer not null,
      saved_at timestamptz not null,
      started_at timestamptz,
      state jsonb not null,
      setup jsonb,
      meeting_code text,
      seats jsonb
    )
  `);
  // Older tables declared started_at not null and lacked the setup, code and seat columns.
  await pool.query('alter table meeting_state alter column started_at drop not null');
  await pool.query('alter table meeting_state add column if not exists setup jsonb');
  await pool.query('alter table meeting_state add column if not exists meeting_code text');
  await pool.query('alter table meeting_state add column if not exists seats jsonb');
}

interface MeetingStateRow {
  schema_version: number;
  saved_at: Date | string;
  started_at: Date | string | null;
  state: SavedMeetingState;
  setup: StoredMeeting['setup'] | null;
  meeting_code: string | null;
  seats: SavedSeatAssignment[] | null;
}

/** The Postgres-backed store the running server uses. */
export function createPostgresMeetingStateStore(pool: Pool): MeetingStateStore {
  return {
    async load() {
      const result = await pool.query<MeetingStateRow>(
        'select schema_version, saved_at, started_at, state, setup, meeting_code, seats from meeting_state where id = $1',
        [MEETING_STATE_ID],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const meeting: StoredMeeting = {
        schemaVersion: row.schema_version,
        savedAt: new Date(row.saved_at).toISOString(),
        ...(row.started_at === null ? {} : { startedAt: new Date(row.started_at).toISOString() }),
        state: row.state,
        // A row from before the schema bump has no setup; the version check refuses it before use.
        setup: (row.setup ?? ({} as StoredMeeting['setup'])),
        meetingCode: row.meeting_code ?? '',
        seats: row.seats ?? [],
      };
      return meeting;
    },

    async save(meeting) {
      await pool.query(
        `insert into meeting_state (id, schema_version, saved_at, started_at, state, setup, meeting_code, seats)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set
           schema_version = excluded.schema_version,
           saved_at = excluded.saved_at,
           started_at = excluded.started_at,
           state = excluded.state,
           setup = excluded.setup,
           meeting_code = excluded.meeting_code,
           seats = excluded.seats`,
        [
          MEETING_STATE_ID,
          meeting.schemaVersion,
          meeting.savedAt,
          meeting.startedAt ?? null,
          JSON.stringify(meeting.state),
          JSON.stringify(meeting.setup),
          meeting.meetingCode,
          JSON.stringify(meeting.seats),
        ],
      );
    },

    async clear() {
      await pool.query('delete from meeting_state where id = $1', [MEETING_STATE_ID]);
    },
  };
}
