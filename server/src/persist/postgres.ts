import type { Pool } from 'pg';
import {
  MEETING_STATE_ID,
  type MeetingStateStore,
  type SavedMeetingState,
  type StoredMeeting,
} from './state';

/** Create the meeting_state table if it is missing; safe to run on every startup, like the auth tables. */
export async function ensureMeetingStateSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists meeting_state (
      id text primary key,
      schema_version integer not null,
      saved_at timestamptz not null,
      started_at timestamptz not null,
      state jsonb not null
    )
  `);
}

interface MeetingStateRow {
  schema_version: number;
  saved_at: Date | string;
  started_at: Date | string;
  state: SavedMeetingState;
}

/** The Postgres-backed store the running server uses. */
export function createPostgresMeetingStateStore(pool: Pool): MeetingStateStore {
  return {
    async load() {
      const result = await pool.query<MeetingStateRow>(
        'select schema_version, saved_at, started_at, state from meeting_state where id = $1',
        [MEETING_STATE_ID],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const meeting: StoredMeeting = {
        schemaVersion: row.schema_version,
        savedAt: new Date(row.saved_at).toISOString(),
        startedAt: new Date(row.started_at).toISOString(),
        state: row.state,
      };
      return meeting;
    },

    async save(meeting) {
      await pool.query(
        `insert into meeting_state (id, schema_version, saved_at, started_at, state)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set
           schema_version = excluded.schema_version,
           saved_at = excluded.saved_at,
           started_at = excluded.started_at,
           state = excluded.state`,
        [
          MEETING_STATE_ID,
          meeting.schemaVersion,
          meeting.savedAt,
          meeting.startedAt,
          JSON.stringify(meeting.state),
        ],
      );
    },

    async clear() {
      await pool.query('delete from meeting_state where id = $1', [MEETING_STATE_ID]);
    },
  };
}
