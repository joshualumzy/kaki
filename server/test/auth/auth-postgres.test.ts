import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import type { AuthStore } from '../../src/auth/store';
import { createPostgresMeetingStore } from '../../src/meeting/registry';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;
const email = `auth-test-${randomUUID()}@example.test`;

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
});
