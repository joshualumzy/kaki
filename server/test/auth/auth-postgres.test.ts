import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import { WorkspaceMemberError, type AuthStore } from '../../src/auth/store';
import { createPostgresAccountDataDeletion } from '../../src/account/deleteAccountData';
import { createPostgresMeetingStore } from '../../src/meeting/registry';
import { createPostgresWorkspaceToolStore } from '../../src/workspace/tools';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;
const email = `auth-test-${randomUUID()}@example.test`;

function toolRecord(workspaceId: string) {
  return {
    workspaceId,
    kind: 'mattermost' as const,
    settings: { url: 'http://mattermost.test' },
    secret: Buffer.from('secret'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
    keyId: 'key-1',
    connectedBy: 'tester',
    connectedAt: new Date('2026-11-01T00:00:00Z'),
    lastOkAt: null,
  };
}

describe.skipIf(connectionString === undefined)('postgres auth store', () => {
  let postgres: PostgresTestSchema | undefined;
  let store: AuthStore;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    await ensureAuthSchema(postgres.pool);
    await ensureAuthSchema(postgres.pool);
    store = createPostgresAuthStore(postgres.pool);
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  it('stores a host account and a session, and drops expired sessions', async () => {
    const user = await store.createUser({ email, passwordHash: 'scrypt:salt:hash' });
    expect(user.email).toBe(email);

    const found = await store.findUserByEmail(email);
    expect(found?.id).toBe(user.id);
    expect(found?.passwordHash).toBe('scrypt:salt:hash');
    expect(found?.createdAt).toBeInstanceOf(Date);

    const tokenHash = `auth-test-${randomUUID()}`;
    await store.createSession({
      tokenHash,
      kind: 'participant',
      role: 'chef',
      meetingCode: 'K7M2Q9',
      meetingId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const session = await store.findSession(tokenHash);
    expect(session).toMatchObject({
      tokenHash,
      kind: 'participant',
      role: 'chef',
      meetingCode: 'K7M2Q9',
    });
    expect(session?.expiresAt).toBeInstanceOf(Date);

    await store.deleteSession(tokenHash);
    expect(await store.findSession(tokenHash)).toBeUndefined();

    const expiredHash = `auth-test-${randomUUID()}`;
    await store.createSession({
      tokenHash: expiredHash,
      kind: 'host',
      role: null,
      meetingCode: null,
      meetingId: null,
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await store.findSession(expiredHash)).toBeUndefined();
  });

  it('refuses to overwrite an existing host account', async () => {
    await expect(
      store.createUser({ email, passwordHash: 'scrypt:other:hash' }),
    ).rejects.toThrow(/already exists/);
  });

  it('creates a Google user with one personal workspace and reuses both', async () => {
    const googleSub = `google-${randomUUID()}`;
    const googleEmail = `google-${randomUUID()}@example.test`;

    const created = await store.createGoogleUser({
      googleSub,
      name: 'Ada Lovelace',
      email: googleEmail,
    });
    expect(created.googleSub).toBe(googleSub);
    expect(created.name).toBe('Ada Lovelace');
    expect(created.passwordHash).toBeNull();

    const workspaces = await store.listWorkspacesForUser(created.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      workspace: { name: 'My workspace', kind: 'personal' },
      role: 'admin',
    });

    const again = await store.createGoogleUser({
      googleSub,
      name: 'Ada L.',
      email: googleEmail,
    });
    expect(again.id).toBe(created.id);
    expect(again.name).toBe('Ada L.');
    expect(await store.listWorkspacesForUser(created.id)).toHaveLength(1);
  });

  it('stores a user session with its display name and user id', async () => {
    const googleSub = `google-${randomUUID()}`;
    const user = await store.createGoogleUser({
      googleSub,
      name: 'Grace Hopper',
      email: `grace-${randomUUID()}@example.test`,
    });
    const tokenHash = `auth-test-${randomUUID()}`;
    await store.createSession({
      tokenHash,
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: user.name,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await store.findSession(tokenHash)).toMatchObject({
      kind: 'user',
      displayName: 'Grace Hopper',
      userId: user.id,
    });
  });

  it('creates, lists, reads, renames and shares workspaces', async () => {
    const owner = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    const member = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Member',
      email: `member-${randomUUID()}@example.test`,
    });

    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: owner.id });
    expect(team.role).toBe('admin');
    expect(await store.getWorkspace(team.workspace.id)).toMatchObject({ name: 'Kitchen', kind: 'team' });
    expect(await store.getMembership({ workspaceId: team.workspace.id, userId: owner.id })).toBe('admin');

    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.id, role: 'member' });
    expect(await store.getMembership({ workspaceId: team.workspace.id, userId: member.id })).toBe('member');
    expect((await store.listWorkspaceMembers(team.workspace.id)).map((person) => person.name)).toEqual(
      expect.arrayContaining(['Owner', 'Member']),
    );

    const renamed = await store.renameWorkspace({ id: team.workspace.id, name: 'Ada team' });
    expect(renamed?.name).toBe('Ada team');
    expect((await store.listWorkspacesForUser(member.id)).some((entry) => entry.workspace.name === 'Ada team')).toBe(
      true,
    );
  });

  it('stores one reusable invite, joins as a member, and protects the last admin', async () => {
    const owner = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    const guest = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Guest',
      email: `guest-${randomUUID()}@example.test`,
    });
    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: owner.id });

    const invite = await store.saveWorkspaceInvite({
      workspaceId: team.workspace.id,
      token: `invite-${randomUUID()}`,
      createdBy: owner.id,
    });
    expect((await store.getWorkspaceInvite(team.workspace.id))?.token).toBe(invite.token);
    expect(
      (
        await store.ensureWorkspaceInvite({
          workspaceId: team.workspace.id,
          token: `unused-${randomUUID()}`,
          createdBy: owner.id,
        })
      ).token,
    ).toBe(invite.token);

    const joined = await store.joinWorkspaceByInvite({ token: invite.token, userId: guest.id });
    expect(joined?.role).toBe('member');
    expect(await store.getMembership({ workspaceId: team.workspace.id, userId: guest.id })).toBe(
      'member',
    );

    const reset = await store.saveWorkspaceInvite({
      workspaceId: team.workspace.id,
      token: `invite-${randomUUID()}`,
      createdBy: owner.id,
    });
    expect(await store.joinWorkspaceByInvite({ token: invite.token, userId: guest.id })).toBeUndefined();
    expect(reset.token).not.toBe(invite.token);

    await expect(
      store.removeWorkspaceMember({ workspaceId: team.workspace.id, userId: owner.id }),
    ).rejects.toThrow(/at least one admin/);
    expect(await store.getMembership({ workspaceId: team.workspace.id, userId: owner.id })).toBe(
      'admin',
    );

    expect(
      await store.setWorkspaceMemberRole({
        workspaceId: team.workspace.id,
        userId: guest.id,
        role: 'admin',
      }),
    ).toBe('admin');
    expect(
      await store.setWorkspaceMemberRole({
        workspaceId: team.workspace.id,
        userId: owner.id,
        role: 'member',
      }),
    ).toBe('member');
    await expect(
      store.removeWorkspaceMember({ workspaceId: team.workspace.id, userId: guest.id }),
    ).rejects.toThrow(/at least one admin/);
    expect(
      await store.removeWorkspaceMember({ workspaceId: team.workspace.id, userId: owner.id }),
    ).toBe('member');
  });

  it('records a meeting status and reads it back', async () => {
    const owner = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const meetings = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const scheduledFor = new Date(Date.now() + 60 * 60_000).toISOString();

    const meeting = await meetings.create({
      workspaceId,
      ownerUserId: owner.id,
      title: 'Later',
      status: 'scheduled',
      scheduledFor,
    });
    expect(meeting.status).toBe('scheduled');
    expect(meeting.scheduledFor).toBe(scheduledFor);
    expect((await meetings.get(meeting.id))?.status).toBe('scheduled');
    expect((await meetings.list(workspaceId)).map((row) => row.id)).toEqual([meeting.id]);
  });

  it('deletes one account and its meetings, tools and knowledge, leaving the other account intact', async () => {
    if (postgres === undefined || connectionString === undefined) {
      throw new Error('POSTGRES_URL is missing');
    }
    const meetings = createPostgresMeetingStore(postgres.pool);
    const tools = createPostgresWorkspaceToolStore(postgres.pool);
    const first = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'First',
      email: `first-${randomUUID()}@example.test`,
    });
    const second = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Second',
      email: `second-${randomUUID()}@example.test`,
    });
    const firstWorkspace = (await store.listWorkspacesForUser(first.id))[0]!.workspace.id;
    const secondWorkspace = (await store.listWorkspacesForUser(second.id))[0]!.workspace.id;
    const firstMeeting = await meetings.create({
      workspaceId: firstWorkspace,
      ownerUserId: first.id,
      title: 'First meeting',
    });
    const secondMeeting = await meetings.create({
      workspaceId: secondWorkspace,
      ownerUserId: second.id,
      title: 'Second meeting',
    });
    // The route ends the account's meetings before the deletion transaction starts.
    await meetings.markEnded!(firstMeeting.id, new Date().toISOString());
    await tools.save(toolRecord(firstWorkspace));
    await tools.save(toolRecord(secondWorkspace));
    await postgres.pool.query('create table if not exists meeting_state (id text primary key)');
    await postgres.pool.query('insert into meeting_state (id) values ($1), ($2)', [
      firstMeeting.id,
      secondMeeting.id,
    ]);
    await postgres.pool.query(
      'create table if not exists knowledge_chunks (workspace_id text not null, ref text not null)',
    );
    await postgres.pool.query(
      'insert into knowledge_chunks (workspace_id, ref) values ($1, $2), ($3, $4)',
      [firstWorkspace, 'first', secondWorkspace, 'second'],
    );

    const deletion = createPostgresAccountDataDeletion({
      pool: postgres.pool,
      auth: store,
      meetings,
      tools,
    });
    expect(await deletion.deleteAccountData(first.id)).toEqual([]);

    expect(await meetings.get(firstMeeting.id)).toBeUndefined();
    expect(await meetings.get(secondMeeting.id)).toBeDefined();
    expect(await tools.list(firstWorkspace)).toEqual([]);
    expect(await tools.list(secondWorkspace)).toHaveLength(1);
    expect(await store.findUserByEmail(first.email)).toBeUndefined();
    expect(await store.findUserById(first.id)).toBeUndefined();
    expect(await store.listWorkspacesForUser(first.id)).toEqual([]);
    expect(await store.findUserByEmail(second.email)).toBeDefined();
    expect(await store.listWorkspacesForUser(second.id)).toHaveLength(1);

    const state = await postgres.pool.query<{ id: string }>('select id from meeting_state');
    expect(state.rows.map((row) => row.id)).toEqual([secondMeeting.id]);
    const chunks = await postgres.pool.query<{ workspace_id: string }>(
      'select workspace_id from knowledge_chunks',
    );
    expect(chunks.rows.map((row) => row.workspace_id)).toEqual([secondWorkspace]);
  });

  it('keeps a surviving team and clears invite attribution when a creator account goes', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const owner = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    const member = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Member',
      email: `member-${randomUUID()}@example.test`,
    });
    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: owner.id });
    await store.addWorkspaceMember({
      workspaceId: team.workspace.id,
      userId: member.id,
      role: 'member',
    });
    const invite = await store.saveWorkspaceInvite({
      workspaceId: team.workspace.id,
      token: `invite-${randomUUID()}`,
      createdBy: owner.id,
    });

    // The invite and the surviving workspace both point at the creator through a restrictive FK;
    // deleting the account must null that attribution rather than fail or carry the team away.
    await store.deleteUser(owner.id);

    expect(await store.getWorkspace(team.workspace.id)).toMatchObject({ createdBy: null });
    expect(await store.getWorkspaceInvite(team.workspace.id)).toMatchObject({
      token: invite.token,
      createdBy: null,
    });
    expect(
      await store.getMembership({ workspaceId: team.workspace.id, userId: member.id }),
    ).toBe('admin');
  });

  it('serializes a meeting insert with member removal and refuses a non-member owner', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const owner = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    const member = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Member',
      email: `member-${randomUUID()}@example.test`,
    });
    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: owner.id });
    await store.addWorkspaceMember({
      workspaceId: team.workspace.id,
      userId: member.id,
      role: 'member',
    });
    const meetings = createPostgresMeetingStore(postgres.pool);

    // A concurrent create has passed its membership check and holds the workspace's shared lock
    // while its meeting insert is not yet committed.
    const insert = await postgres.pool.connect();
    const racedId = randomUUID();
    try {
      await insert.query('begin');
      await insert.query('select id from workspaces where id = $1 for key share', [
        team.workspace.id,
      ]);
      await insert.query(
        `insert into meetings (id, workspace_id, owner_user_id, title, kind, status)
         values ($1, $2, $3, 'Raced in', 'real', 'open')`,
        [racedId, team.workspace.id, member.id],
      );

      const removal = store.removeWorkspaceMember({
        workspaceId: team.workspace.id,
        userId: member.id,
        actorUserId: owner.id,
        assertRemovable: async () => {
          const rows = await meetings.list(team.workspace.id);
          if (rows.some((row) => row.status === 'open' && row.ownerUserId === member.id)) {
            throw new WorkspaceMemberError('open-meeting', 'This person owns an open meeting.');
          }
        },
      });
      const outcome = await Promise.race([
        removal.then(
          () => 'done' as const,
          () => 'refused' as const,
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
      ]);
      // Removal waits for the in-flight insert, because both lock the workspace row.
      expect(outcome).toBe('blocked');
      await insert.query('commit');
      await expect(removal).rejects.toMatchObject({ problem: 'open-meeting' });
      expect(
        await store.getMembership({ workspaceId: team.workspace.id, userId: member.id }),
      ).toBe('member');
    } finally {
      await insert.query('rollback').catch(() => undefined);
      insert.release();
    }

    await meetings.markEnded!(racedId, new Date().toISOString());
    expect(
      await store.removeWorkspaceMember({
        workspaceId: team.workspace.id,
        userId: member.id,
        actorUserId: owner.id,
        assertRemovable: async () => {
          const rows = await meetings.list(team.workspace.id);
          if (rows.some((row) => row.status === 'open' && row.ownerUserId === member.id)) {
            throw new WorkspaceMemberError('open-meeting', 'This person owns an open meeting.');
          }
        },
      }),
    ).toBe('member');

    // Membership is checked inside the insert's transaction, so the removed owner cannot create.
    await expect(
      meetings.create({
        workspaceId: team.workspace.id,
        ownerUserId: member.id,
        title: 'After removal',
      }),
    ).rejects.toThrow(/not a member/);
  });
});
