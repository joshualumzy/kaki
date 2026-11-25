import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  WorkspaceMemberError,
  type AuthStore,
  type SessionKind,
  type SessionRecord,
  type UserRecord,
  type WorkspaceInvite,
  type WorkspaceKind,
  type WorkspaceMember,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './store';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  name: string | null;
  picture: string | null;
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

interface WorkspaceInviteRow {
  workspace_id: string;
  token: string;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toWorkspaceInvite(row: WorkspaceInviteRow): WorkspaceInvite {
  return {
    workspaceId: row.workspace_id,
    token: row.token,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function sameToken(given: string, stored: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_KINDS: readonly SessionKind[] = ['host', 'participant', 'user', 'guest'];

const USER_COLUMNS = 'id, email, password_hash, google_sub, name, picture, created_at';
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
    picture: row.picture,
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

    async createGoogleUser({ googleSub, name, email, picture = null }) {
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
            `update users set name = $2, email = $3, picture = $4 where id = $1 returning ${USER_COLUMNS}`,
            [subRow.id, name, email, picture],
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
            `update users set google_sub = $2, name = $3, picture = $4 where id = $1 returning ${USER_COLUMNS}`,
            [emailRow.id, googleSub, name, picture],
          );
          await ensurePersonalWorkspace(client, emailRow.id);
          await client.query('commit');
          const row = linked.rows[0] ?? emailRow;
          return toUser(row);
        }

        const userId = randomUUID();
        const created = await client.query<UserRow>(
          `insert into users (id, email, password_hash, google_sub, name, picture)
           values ($1, $2, null, $3, $4, $5)
           returning ${USER_COLUMNS}`,
          [userId, email, googleSub, name, picture],
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

    async updateUserProfile({ id, name, email, picture }) {
      if (picture === undefined) {
        await pool.query('update users set name = $2, email = $3 where id = $1', [id, name, email]);
        return;
      }
      await pool.query('update users set name = $2, email = $3, picture = $4 where id = $1', [id, name, email, picture]);
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

    async seatHolder({ meetingId, role }) {
      const result = await pool.query<{ holder: string }>(
        `select holder from seat_claims
          where meeting_id = $1 and role = $2 and expires_at > now()`,
        [meetingId, role],
      );
      return result.rows[0]?.holder;
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

    async listWorkspacesOwnedBy(userId) {
      const result = await pool.query<WorkspaceRow>(
        `select id, name, kind, created_by, created_at
           from workspaces
          where created_by = $1
          order by created_at asc`,
        [userId],
      );
      return result.rows.map(toWorkspace);
    },

    async listWorkspacesToDelete(userId) {
      const result = await pool.query<WorkspaceRow>(
        `select w.id, w.name, w.kind, w.created_by, w.created_at
           from workspaces w
           join workspace_members m on m.workspace_id = w.id and m.user_id = $1
          where not exists (
                  select 1 from workspace_members other
                   where other.workspace_id = w.id and other.user_id <> $1
                )
          order by w.created_at asc`,
        [userId],
      );
      return result.rows.map(toWorkspace);
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

    async getWorkspaceInvite(workspaceId) {
      const result = await pool.query<WorkspaceInviteRow>(
        `select workspace_id, token, created_by, created_at, updated_at
           from workspace_invites where workspace_id = $1`,
        [workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toWorkspaceInvite(row);
    },

    async ensureWorkspaceInvite({ workspaceId, token, createdBy }) {
      const created = await pool.query<WorkspaceInviteRow>(
        `insert into workspace_invites (workspace_id, token, created_by)
         values ($1, $2, $3)
         on conflict (workspace_id) do nothing
         returning workspace_id, token, created_by, created_at, updated_at`,
        [workspaceId, token, createdBy],
      );
      const createdRow = created.rows[0];
      if (createdRow !== undefined) return toWorkspaceInvite(createdRow);
      const existing = await pool.query<WorkspaceInviteRow>(
        `select workspace_id, token, created_by, created_at, updated_at
           from workspace_invites where workspace_id = $1`,
        [workspaceId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new Error('The workspace invite was not saved');
      return toWorkspaceInvite(row);
    },

    async saveWorkspaceInvite({ workspaceId, token, createdBy }) {
      const result = await pool.query<WorkspaceInviteRow>(
        `insert into workspace_invites (workspace_id, token, created_by)
         values ($1, $2, $3)
         on conflict (workspace_id) do update
           set token = excluded.token, created_by = excluded.created_by, updated_at = now()
         returning workspace_id, token, created_by, created_at, updated_at`,
        [workspaceId, token, createdBy],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Postgres did not return the workspace invite');
      return toWorkspaceInvite(row);
    },

    async joinWorkspaceByInvite({ token, userId }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const found = await client.query<WorkspaceRow & { token: string }>(
          `select w.id, w.name, w.kind, w.created_by, w.created_at, i.token
             from workspace_invites i
             join workspaces w on w.id = i.workspace_id
            where i.token = $1 and w.kind = 'team'
            for update of i`,
          [token],
        );
        const row = found.rows[0];
        if (row === undefined || !sameToken(token, row.token)) {
          await client.query('rollback');
          return undefined;
        }
        await client.query(
          `insert into workspace_members (workspace_id, user_id, role)
           values ($1, $2, 'member')
           on conflict (workspace_id, user_id) do nothing`,
          [row.id, userId],
        );
        const member = await client.query<{ role: string }>(
          'select role from workspace_members where workspace_id = $1 and user_id = $2',
          [row.id, userId],
        );
        await client.query('commit');
        const roleRow = member.rows[0];
        if (roleRow === undefined) throw new Error('The invite did not add a workspace member');
        return { workspace: toWorkspace(row), role: workspaceRole(roleRow.role) };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async removeWorkspaceMember({ workspaceId, userId, actorUserId, assertRemovable }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Lock the workspace itself, so two admins changing members at once take turns and the
        // last-admin count cannot be read by both before either removes the other. A meeting insert
        // takes a shared lock on this same row, so it either commits before this lock is granted or
        // waits and sees the membership gone.
        const workspace = await client.query('select id from workspaces where id = $1 for update', [
          workspaceId,
        ]);
        if ((workspace.rowCount ?? 0) === 0) {
          await client.query('rollback');
          return undefined;
        }
        if (actorUserId !== undefined && actorUserId !== userId) {
          const actor = await client.query<{ role: string }>(
            'select role from workspace_members where workspace_id = $1 and user_id = $2',
            [workspaceId, actorUserId],
          );
          if (workspaceRole(actor.rows[0]?.role ?? '') !== 'admin') {
            throw new WorkspaceMemberError(
              'not-admin',
              'Only a workspace admin can change members.',
            );
          }
        }
        const current = await client.query<{ role: string }>(
          'select role from workspace_members where workspace_id = $1 and user_id = $2',
          [workspaceId, userId],
        );
        const currentRow = current.rows[0];
        if (currentRow === undefined) {
          await client.query('rollback');
          return undefined;
        }
        const role = workspaceRole(currentRow.role);
        if (role === 'admin') {
          const admins = await client.query<{ count: string }>(
            `select count(*)::text as count from workspace_members
              where workspace_id = $1 and role = 'admin'`,
            [workspaceId],
          );
          if (Number(admins.rows[0]?.count ?? '0') <= 1) {
            throw new WorkspaceMemberError(
              'last-admin',
              'A workspace needs at least one admin. Make someone else an admin first.',
            );
          }
        }
        // Runs while the workspace is locked. A meeting insert cannot commit between this check and
        // the delete, because it needs a shared lock on the same workspace row.
        if (assertRemovable !== undefined) await assertRemovable();
        await client.query(
          'delete from workspace_members where workspace_id = $1 and user_id = $2',
          [workspaceId, userId],
        );
        await client.query('commit');
        return role;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async setWorkspaceMemberRole({ workspaceId, userId, role, actorUserId }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const workspace = await client.query('select id from workspaces where id = $1 for update', [
          workspaceId,
        ]);
        if ((workspace.rowCount ?? 0) === 0) {
          await client.query('rollback');
          return undefined;
        }
        if (actorUserId !== undefined) {
          const actor = await client.query<{ role: string }>(
            'select role from workspace_members where workspace_id = $1 and user_id = $2',
            [workspaceId, actorUserId],
          );
          if (workspaceRole(actor.rows[0]?.role ?? '') !== 'admin') {
            throw new WorkspaceMemberError(
              'not-admin',
              'Only a workspace admin can change members.',
            );
          }
        }
        const current = await client.query<{ role: string }>(
          'select role from workspace_members where workspace_id = $1 and user_id = $2',
          [workspaceId, userId],
        );
        const currentRow = current.rows[0];
        if (currentRow === undefined) {
          await client.query('rollback');
          return undefined;
        }
        if (workspaceRole(currentRow.role) === 'admin' && role === 'member') {
          const admins = await client.query<{ count: string }>(
            `select count(*)::text as count from workspace_members
              where workspace_id = $1 and role = 'admin'`,
            [workspaceId],
          );
          if (Number(admins.rows[0]?.count ?? '0') <= 1) {
            throw new WorkspaceMemberError(
              'last-admin',
              'A workspace needs at least one admin. Make someone else an admin first.',
            );
          }
        }
        await client.query(
          'update workspace_members set role = $3 where workspace_id = $1 and user_id = $2',
          [workspaceId, userId, role],
        );
        await client.query('commit');
        return role;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteSessionsForUser(userId) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const deleted = await client.query<{ token_hash: string }>(
          'delete from sessions where user_id = $1 returning token_hash',
          [userId],
        );
        const hashes = deleted.rows.map((row) => row.token_hash);
        if (hashes.length > 0) {
          await client.query('delete from seat_claims where holder = any($1::text[])', [hashes]);
        }
        await client.query('commit');
        return hashes;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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

    async deleteWorkspace({ id, actorUserId, beforeDelete }, transaction) {
      const client = transaction ?? (await pool.connect());
      const ownsTransaction = transaction === undefined;
      try {
        if (ownsTransaction) await client.query('begin');
        const workspace = await client.query<WorkspaceRow>(
          'select id, name, kind, created_by, created_at from workspaces where id = $1 for update',
          [id],
        );
        const row = workspace.rows[0];
        if (row === undefined || row.kind !== 'team') {
          if (ownsTransaction) await client.query('rollback');
          return false;
        }
        const actor = await client.query(
          "select 1 from workspace_members where workspace_id = $1 and user_id = $2 and role = 'admin'",
          [id, actorUserId],
        );
        if ((actor.rowCount ?? 0) === 0) {
          if (ownsTransaction) await client.query('rollback');
          return false;
        }
        if (beforeDelete !== undefined) await beforeDelete(toWorkspace(row));
        await client.query('delete from workspace_members where workspace_id = $1', [id]);
        await client.query('delete from workspace_invites where workspace_id = $1', [id]);
        await client.query('delete from workspaces where id = $1', [id]);
        if (ownsTransaction) await client.query('commit');
        return true;
      } catch (error) {
        if (ownsTransaction) await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
    },

    async deleteUser(userId, transaction) {
      // The account deletion already runs everything in one transaction; only open our own when
      // this store is used on its own.
      const client = transaction ?? (await pool.connect());
      const ownsTransaction = transaction === undefined;
      try {
        if (ownsTransaction) await client.query('begin');
        // Every session the account holds, whatever kind it became by taking a seat.
        const sessionRows = await client.query<{ token_hash: string }>(
          'select token_hash from sessions where user_id = $1',
          [userId],
        );
        const hashes = sessionRows.rows.map((row) => row.token_hash);
        if (hashes.length > 0) {
          await client.query('delete from seat_claims where holder = any($1::text[])', [hashes]);
        }
        await client.query('delete from sessions where user_id = $1', [userId]);
        // A workspace goes only when this account is its last member. A team with other members
        // survives and keeps its meetings, tools and knowledge; creation attribution is not ownership.
        const doomedRows = await client.query<{ id: string }>(
          `select w.id
             from workspaces w
             join workspace_members m on m.workspace_id = w.id and m.user_id = $1
            where not exists (
                    select 1 from workspace_members other
                     where other.workspace_id = w.id and other.user_id <> $1
                  )
            for update of w`,
          [userId],
        );
        const doomedIds = doomedRows.rows.map((row) => row.id);
        // A surviving team never loses its only admin: pass the role to a remaining member.
        await client.query(
          `with last_admin as (
             select w.id
               from workspaces w
               join workspace_members me
                 on me.workspace_id = w.id and me.user_id = $1 and me.role = 'admin'
              where not exists (
                      select 1 from workspace_members other_admin
                       where other_admin.workspace_id = w.id
                         and other_admin.role = 'admin'
                         and other_admin.user_id <> $1
                    )
                and exists (
                      select 1 from workspace_members other
                       where other.workspace_id = w.id and other.user_id <> $1
                    )
           )
           update workspace_members m
              set role = 'admin'
             from last_admin l
            where m.workspace_id = l.id
              and m.user_id = (
                select successor.user_id
                  from workspace_members successor
                 where successor.workspace_id = l.id and successor.user_id <> $1
                 order by successor.user_id
                 limit 1
              )`,
          [userId],
        );
        await client.query(
          'delete from workspace_members where user_id = $1 or workspace_id = any($2::text[])',
          [userId, doomedIds],
        );
        await client.query('delete from workspaces where id = any($1::text[])', [doomedIds]);
        // The account's name stays as creation attribution only until it goes; these two columns
        // also carry ON DELETE SET NULL, so the cleanup is explicit here as well.
        await client.query('update workspaces set created_by = null where created_by = $1', [userId]);
        await client.query('update workspace_invites set created_by = null where created_by = $1', [
          userId,
        ]);
        await client.query('delete from users where id = $1', [userId]);
        if (ownsTransaction) await client.query('commit');
        return hashes;
      } catch (error) {
        if (ownsTransaction) await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
