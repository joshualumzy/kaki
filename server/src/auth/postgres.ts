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
        `insert into sessions (token_hash, kind, role, meeting_code, expires_at)
         values ($1, $2, $3, $4, $5)`,
        [session.tokenHash, session.kind, session.role, session.meetingCode, session.expiresAt],
      );
    },

    async findSession(tokenHash) {
      const result = await pool.query<SessionRow>(
        `select token_hash, kind, role, meeting_code, expires_at
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

    async deleteSession(tokenHash) {
      await pool.query('delete from sessions where token_hash = $1', [tokenHash]);
    },

    async close() {
      await pool.end();
    },
  };
}
