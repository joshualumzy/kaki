import type { Pool } from 'pg';
import {
  MEETING_STATE_ID,
  type MeetingStateStore,
  type SavedMeetingPhase,
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
      draft_touched boolean,
      meeting_code text,
      seats jsonb
    )
  `);
  // Older tables declared started_at not null and lacked the setup, edit mark, code and seat columns.
  await pool.query('alter table meeting_state alter column started_at drop not null');
  await pool.query('alter table meeting_state add column if not exists setup jsonb');
  await pool.query('alter table meeting_state add column if not exists draft_touched boolean');
  await pool.query('alter table meeting_state add column if not exists meeting_code text');
  await pool.query('alter table meeting_state add column if not exists seats jsonb');
  // v6 stores one coherent meeting: draft and seal separately, its phase, identity and holders.
  await pool.query('alter table meeting_state add column if not exists meeting_id text');
  await pool.query('alter table meeting_state add column if not exists phase text');
  await pool.query('alter table meeting_state add column if not exists draft jsonb');
  await pool.query('alter table meeting_state add column if not exists sealed jsonb');
  await pool.query('alter table meeting_state add column if not exists draft_edited_since_seal boolean');
  await pool.query('alter table meeting_state add column if not exists holders jsonb');
  await pool.query('alter table meeting_state add column if not exists lobby_agenda jsonb');
  await pool.query('alter table meeting_state add column if not exists abandoned boolean');
  await pool.query('alter table meeting_state add column if not exists runner_revision integer');
}

interface MeetingStateRow {
  schema_version: number;
  saved_at: Date | string;
  started_at: Date | string | null;
  state: SavedMeetingState;
  meeting_id: string | null;
  phase: SavedMeetingPhase | null;
  draft: StoredMeeting['draft'] | null;
  sealed: StoredMeeting['sealed'] | null;
  draft_touched: boolean | null;
  draft_edited_since_seal: boolean | null;
  meeting_code: string | null;
  holders: SavedSeatAssignment[] | null;
  seats: SavedSeatAssignment[] | null;
  lobby_agenda: string[] | null;
  abandoned: boolean | null;
  runner_revision: number | null;
}

/** The Postgres-backed store the running server uses. */
export function createPostgresMeetingStateStore(pool: Pool): MeetingStateStore {
  return {
    async load() {
      const result = await pool.query<MeetingStateRow>(
        `select schema_version, saved_at, started_at, state, meeting_id, phase, draft, sealed,
                draft_touched, draft_edited_since_seal, meeting_code, holders, seats,
                lobby_agenda, abandoned, runner_revision
           from meeting_state where id = $1`,
        [MEETING_STATE_ID],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const meeting: StoredMeeting = {
        schemaVersion: row.schema_version,
        savedAt: new Date(row.saved_at).toISOString(),
        ...(row.started_at === null ? {} : { startedAt: new Date(row.started_at).toISOString() }),
        state: row.state,
        // A row from before the schema bump has none of these; the version check refuses it first.
        meetingId: row.meeting_id ?? '',
        phase: row.phase ?? 'lobby',
        draft: row.draft ?? ({} as StoredMeeting['draft']),
        ...(row.sealed === null ? {} : { sealed: row.sealed }),
        draftTouched: row.draft_touched === true,
        ...(row.draft_edited_since_seal === true ? { draftEditedSinceSeal: true } : {}),
        meetingCode: row.meeting_code ?? '',
        holders: row.holders ?? row.seats ?? [],
        ...(row.lobby_agenda === null ? {} : { lobbyAgenda: row.lobby_agenda }),
        ...(row.abandoned === true ? { abandoned: true } : {}),
        ...(row.runner_revision === null ? {} : { runnerRevision: row.runner_revision }),
      };
      return meeting;
    },

    async save(meeting) {
      await pool.query(
        `insert into meeting_state
           (id, schema_version, saved_at, started_at, state, meeting_id, phase, draft, sealed,
            draft_touched, draft_edited_since_seal, meeting_code, holders, lobby_agenda, abandoned,
            runner_revision)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         on conflict (id) do update set
           schema_version = excluded.schema_version,
           saved_at = excluded.saved_at,
           started_at = excluded.started_at,
           state = excluded.state,
           meeting_id = excluded.meeting_id,
           phase = excluded.phase,
           draft = excluded.draft,
           sealed = excluded.sealed,
           draft_touched = excluded.draft_touched,
           draft_edited_since_seal = excluded.draft_edited_since_seal,
           meeting_code = excluded.meeting_code,
           holders = excluded.holders,
           lobby_agenda = excluded.lobby_agenda,
           abandoned = excluded.abandoned,
           runner_revision = excluded.runner_revision`,
        [
          MEETING_STATE_ID,
          meeting.schemaVersion,
          meeting.savedAt,
          meeting.startedAt ?? null,
          JSON.stringify(meeting.state),
          meeting.meetingId,
          meeting.phase,
          JSON.stringify(meeting.draft),
          meeting.sealed === undefined ? null : JSON.stringify(meeting.sealed),
          meeting.draftTouched,
          meeting.draftEditedSinceSeal === true,
          meeting.meetingCode,
          JSON.stringify(meeting.holders),
          meeting.lobbyAgenda === undefined ? null : JSON.stringify(meeting.lobbyAgenda),
          meeting.abandoned === true,
          meeting.runnerRevision ?? null,
        ],
      );
    },

    async clear() {
      await pool.query('delete from meeting_state where id = $1', [MEETING_STATE_ID]);
    },
  };
}
