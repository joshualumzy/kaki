import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import type { AuthStore } from '../../src/auth/store';
import { createPostgresMeetingStore } from '../../src/meeting/registry';
import { createPostgresWorkspaceToolStore } from '../../src/workspace/tools';
import { deleteWorkspaceKnowledge } from '../../src/wingman/knowledge/indexer';
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

function pinnedUrl(value: string, schema: string): string {
  const url = new URL(value);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  return url.toString();
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

    await meetings.deleteByOwner?.(first.id, [firstWorkspace]);
    await tools.deleteWorkspaces?.([firstWorkspace]);
    await deleteWorkspaceKnowledge({
      postgresUrl: pinnedUrl(connectionString, postgres.schema),
      workspaceIds: [firstWorkspace],
    });
    expect(await store.deleteUser(first.id)).toEqual([]);

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
});
