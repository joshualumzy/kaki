import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthStore, SessionRecord, UserRecord } from './store';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date | string;
}

interface SessionRow {
  token_hash: string;
  kind: string;
  role: string | null;
  meeting_code: string | null;
  meeting_id: string | null;
  expires_at: Date | string;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: new Date(row.created_at),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    kind: row.kind === 'participant' ? 'participant' : 'host',
    role: row.role,
    meetingCode: row.meeting_code,
    meetingId: row.meeting_id,
    expiresAt: new Date(row.expires_at),
  };
}

/** The Postgres-backed auth store used by the running server. */
export function createPostgresAuthStore(pool: Pool): AuthStore {
  return {
    async findUserByEmail(email) {
      const result = await pool.query<UserRow>(
        'select id, email, password_hash, created_at from users where email = $1',
        [email],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toUser(row);
    },

    async createUser({ email, passwordHash }) {
      try {
        const result = await pool.query<UserRow>(
          `insert into users (id, email, password_hash)
           values ($1, $2, $3)
           returning id, email, password_hash, created_at`,
          [randomUUID(), email, passwordHash],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error('Postgres did not return the new host account');
        return toUser(row);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throw new Error('A host account with that email already exists.', { cause: error });
        }
        throw error;
      }
    },

    async createSession(session) {
      await pool.query(
        `insert into sessions (token_hash, kind, role, meeting_code, meeting_id, expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          session.tokenHash,
          session.kind,
          session.role,
          session.meetingCode,
          session.meetingId,
          session.expiresAt,
        ],
      );
    },

    async findSession(tokenHash) {
      const result = await pool.query<SessionRow>(
        `select token_hash, kind, role, meeting_code, meeting_id, expires_at
           from sessions
          where token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;

      const session = toSession(row);
      if (session.expiresAt.getTime() <= Date.now()) {
        await pool.query('delete from sessions where token_hash = $1', [tokenHash]);
        return undefined;
      }
      return session;
    },

    async claimSeat({ meetingId, role, holder, replaces }) {
      // One atomic statement: the row is only taken when it is free, already ours, or being
      // handed over by the same holder whose session we are replacing.
      const result = await pool.query(
        `insert into seat_claims (meeting_id, role, holder, expires_at)
         values ($1, $2, $3, now() + interval '12 hours')
         on conflict (meeting_id, role) do update
           set holder = excluded.holder, expires_at = excluded.expires_at
           where seat_claims.holder = excluded.holder
              or seat_claims.holder = $4
              or seat_claims.expires_at <= now()
         returning holder`,
        [meetingId, role, holder, replaces ?? ''],
      );
      return result.rowCount !== null && result.rowCount > 0;
    },

    async releaseSeats({ holder, meetingId }) {
      if (holder !== undefined) {
        await pool.query('delete from seat_claims where holder = $1', [holder]);
      }
      if (meetingId !== undefined) {
        await pool.query('delete from seat_claims where meeting_id = $1', [meetingId]);
      }
    },

    async deleteSession(tokenHash) {
      await pool.query('delete from sessions where token_hash = $1', [tokenHash]);
    },

    async close() {
      await pool.end();
    },
  };
}
