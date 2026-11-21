import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AuthStore,
  SessionKind,
  SessionRecord,
  UserRecord,
  WorkspaceKind,
  WorkspaceMember,
  WorkspaceRecord,
  WorkspaceRole,
} from './store';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  name: string | null;
  created_at: Date | string;
}

interface SessionRow {
  token_hash: string;
  kind: string;
  role: string | null;
  meeting_code: string | null;
  meeting_id: string | null;
  display_name: string | null;
  user_id: string | null;
  expires_at: Date | string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  kind: string;
  created_by: string | null;
  created_at: Date | string;
}

interface MemberRow {
  user_id: string;
  name: string | null;
  email: string;
  role: string;
}

const SESSION_KINDS: readonly SessionKind[] = ['host', 'participant', 'user', 'guest'];

const USER_COLUMNS = 'id, email, password_hash, google_sub, name, created_at';
const SESSION_COLUMNS =
  'token_hash, kind, role, meeting_code, meeting_id, display_name, user_id, expires_at';

function sessionKind(value: string): SessionKind {
  return SESSION_KINDS.find((kind) => kind === value) ?? 'host';
}

function workspaceKind(value: string): WorkspaceKind {
  return value === 'team' ? 'team' : 'personal';
}

function workspaceRole(value: string): WorkspaceRole {
  return value === 'admin' ? 'admin' : 'member';
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    googleSub: row.google_sub,
    name: row.name,
    createdAt: new Date(row.created_at),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    kind: sessionKind(row.kind),
    role: row.role,
    meetingCode: row.meeting_code,
    meetingId: row.meeting_id,
    displayName: row.display_name,
    userId: row.user_id,
    expiresAt: new Date(row.expires_at),
  };
}

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: workspaceKind(row.kind),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
  };
}

/** The Postgres-backed auth store used by the running server. */
export function createPostgresAuthStore(pool: Pool): AuthStore {
  async function insertSession(client: Pool | PoolClient, session: SessionRecord): Promise<void> {
    await client.query(
      `insert into sessions (token_hash, kind, role, meeting_code, meeting_id, display_name, user_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        session.tokenHash,
        session.kind,
        session.role,
        session.meetingCode,
        session.meetingId,
        session.displayName ?? null,
        session.userId ?? null,
        session.expiresAt,
      ],
    );
  }

  async function findUserByGoogleSub(
    client: Pool | PoolClient,
    googleSub: string,
  ): Promise<UserRecord | undefined> {
    const result = await client.query<UserRow>(
      `select ${USER_COLUMNS} from users where google_sub = $1`,
      [googleSub],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toUser(row);
  }

  async function ensurePersonalWorkspace(client: PoolClient, userId: string): Promise<void> {
    const existing = await client.query(
      `select 1
         from workspaces w
         join workspace_members m on m.workspace_id = w.id
        where m.user_id = $1 and w.kind = 'personal'
        limit 1`,
      [userId],
    );
    if (existing.rowCount !== null && existing.rowCount > 0) return;
    const workspaceId = randomUUID();
    await client.query(
      `insert into workspaces (id, name, kind, created_by) values ($1, $2, 'personal', $3)`,
      [workspaceId, 'My workspace', userId],
    );
    await client.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`,
      [workspaceId, userId],
    );
  }

  return {
    async findUserByEmail(email) {
      const result = await pool.query<UserRow>(
        `select ${USER_COLUMNS} from users where email = $1`,
        [email],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toUser(row);
    },

    async findUserById(id) {
      const result = await pool.query<UserRow>(
        `select ${USER_COLUMNS} from users where id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toUser(row);
    },

    async findUserByGoogleSub(googleSub) {
      return findUserByGoogleSub(pool, googleSub);
    },

    async createUser({ email, passwordHash }) {
      try {
        const result = await pool.query<UserRow>(
          `insert into users (id, email, password_hash)
           values ($1, $2, $3)
           returning ${USER_COLUMNS}`,
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

    async createGoogleUser({ googleSub, name, email }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const existingBySub = await client.query<UserRow>(
          `select ${USER_COLUMNS} from users where google_sub = $1 for update`,
          [googleSub],
        );
        const subRow = existingBySub.rows[0];
        if (subRow !== undefined) {
          const updated = await client.query<UserRow>(
            `update users set name = $2, email = $3 where id = $1 returning ${USER_COLUMNS}`,
            [subRow.id, name, email],
          );
          await client.query('commit');
          const row = updated.rows[0] ?? subRow;
          return toUser(row);
        }

        const existingByEmail = await client.query<UserRow>(
          `select ${USER_COLUMNS} from users where email = $1 for update`,
          [email],
        );
        const emailRow = existingByEmail.rows[0];
        if (emailRow !== undefined) {
          if (emailRow.google_sub !== null && emailRow.google_sub !== googleSub) {
            throw new Error('That email already belongs to another Google account.');
          }
          const linked = await client.query<UserRow>(
            `update users set google_sub = $2, name = $3 where id = $1 returning ${USER_COLUMNS}`,
            [emailRow.id, googleSub, name],
          );
          await ensurePersonalWorkspace(client, emailRow.id);
          await client.query('commit');
          const row = linked.rows[0] ?? emailRow;
          return toUser(row);
        }

        const userId = randomUUID();
        const created = await client.query<UserRow>(
          `insert into users (id, email, password_hash, google_sub, name)
           values ($1, $2, null, $3, $4)
           returning ${USER_COLUMNS}`,
          [userId, email, googleSub, name],
        );
        const workspaceId = randomUUID();
        await client.query(
          `insert into workspaces (id, name, kind, created_by) values ($1, $2, 'personal', $3)`,
          [workspaceId, 'My workspace', userId],
        );
        await client.query(
          `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`,
          [workspaceId, userId],
        );
        await client.query('commit');
        const row = created.rows[0];
        if (row === undefined) throw new Error('Postgres did not return the new user');
        return toUser(row);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          // A simultaneous first sign-in may have inserted the same google_sub; use that row.
          const raced = await findUserByGoogleSub(pool, googleSub);
          if (raced !== undefined) return raced;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async updateUserProfile({ id, name, email }) {
      await pool.query('update users set name = $2, email = $3 where id = $1', [id, name, email]);
    },

    async createSession(session) {
      await insertSession(pool, session);
    },

    async findSession(tokenHash) {
      const result = await pool.query<SessionRow>(
        `select ${SESSION_COLUMNS} from sessions where token_hash = $1`,
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

    async enterSeat({ session, meetingId, role, replaces }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // The row is only taken when it is free, already ours, or being handed over by the same
        // holder whose session we are replacing.
        const claimed = await client.query(
          `insert into seat_claims (meeting_id, role, holder, expires_at)
           values ($1, $2, $3, $5)
           on conflict (meeting_id, role) do update
             set holder = excluded.holder, expires_at = excluded.expires_at
             where seat_claims.holder = excluded.holder
                or seat_claims.holder = $4
                or seat_claims.expires_at <= now()
           returning holder`,
          [meetingId, role, session.tokenHash, replaces ?? '', session.expiresAt],
        );
        if (claimed.rowCount === null || claimed.rowCount === 0) {
          await client.query('rollback');
          return false;
        }
        await insertSession(client, session);
        if (replaces !== undefined && replaces !== session.tokenHash) {
          await client.query('delete from seat_claims where holder = $1', [replaces]);
          await client.query('delete from sessions where token_hash = $1', [replaces]);
        }
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async replaceSession({ session, replaces }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await insertSession(client, session);
        await client.query('update seat_claims set holder = $1 where holder = $2', [
          session.tokenHash,
          replaces,
        ]);
        await client.query('delete from sessions where token_hash = $1', [replaces]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async seatHeldBy({ meetingId, role, holder }) {
      const result = await pool.query(
        `select 1 from seat_claims
          where meeting_id = $1 and role = $2 and holder = $3 and expires_at > now()`,
        [meetingId, role, holder],
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

    async listWorkspacesForUser(userId) {
      const result = await pool.query<WorkspaceRow & { role: string }>(
        `select w.id, w.name, w.kind, w.created_by, w.created_at, m.role
           from workspace_members m
           join workspaces w on w.id = m.workspace_id
          where m.user_id = $1
          order by w.created_at asc`,
        [userId],
      );
      return result.rows.map((row) => ({
        workspace: toWorkspace(row),
        role: workspaceRole(row.role),
      }));
    },

    async createWorkspace({ name, createdBy }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const workspaceId = randomUUID();
        const created = await client.query<WorkspaceRow>(
          `insert into workspaces (id, name, kind, created_by)
           values ($1, $2, 'team', $3)
           returning id, name, kind, created_by, created_at`,
          [workspaceId, name, createdBy],
        );
        await client.query(
          `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`,
          [workspaceId, createdBy],
        );
        await client.query('commit');
        const row = created.rows[0];
        if (row === undefined) throw new Error('Postgres did not return the new workspace');
        return { workspace: toWorkspace(row), role: 'admin' };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getWorkspace(id) {
      const result = await pool.query<WorkspaceRow>(
        `select id, name, kind, created_by, created_at from workspaces where id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toWorkspace(row);
    },

    async getMembership({ workspaceId, userId }) {
      const result = await pool.query<{ role: string }>(
        `select role from workspace_members where workspace_id = $1 and user_id = $2`,
        [workspaceId, userId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : workspaceRole(row.role);
    },

    async listWorkspaceMembers(workspaceId): Promise<WorkspaceMember[]> {
      const result = await pool.query<MemberRow>(
        `select m.user_id, u.name, u.email, m.role
           from workspace_members m
           join users u on u.id = m.user_id
          where m.workspace_id = $1
          order by m.role desc, u.email asc`,
        [workspaceId],
      );
      return result.rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        role: workspaceRole(row.role),
      }));
    },

    async addWorkspaceMember({ workspaceId, userId, role }) {
      await pool.query(
        `insert into workspace_members (workspace_id, user_id, role)
         values ($1, $2, $3)
         on conflict (workspace_id, user_id) do update set role = excluded.role`,
        [workspaceId, userId, role],
      );
    },

    async renameWorkspace({ id, name }) {
      const result = await pool.query<WorkspaceRow>(
        `update workspaces set name = $2 where id = $1
         returning id, name, kind, created_by, created_at`,
        [id, name],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toWorkspace(row);
    },

    async close() {
      await pool.end();
    },
  };
}
