import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAuthSchema, ensureMeetingsSchema, ensureWorkspaceToolsSchema } from '../../src/auth/schema';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { createPostgresMeetingStore } from '../../src/meeting/registry';
import { createPostgresWorkspaceToolStore } from '../../src/workspace/tools';
import { createPostgresWorkspaceDataDeletion } from '../../src/workspace/deleteWorkspaceData';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

describe.skipIf(connectionString === undefined)('postgres workspace deletion', () => {
  let postgres: PostgresTestSchema | undefined;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    await ensureAuthSchema(postgres.pool);
    await ensureMeetingsSchema(postgres.pool);
    await ensureWorkspaceToolsSchema(postgres.pool);
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  it('deletes the workspace, its meetings, calendar state, tools, invite and knowledge together', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const auth = createPostgresAuthStore(postgres.pool);
    const meetings = createPostgresMeetingStore(postgres.pool);
    const tools = createPostgresWorkspaceToolStore(postgres.pool);
    const deletion = createPostgresWorkspaceDataDeletion({
      pool: postgres.pool,
      auth,
      meetings,
      tools,
    });
    const owner = await auth.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Owner',
      email: `owner-${randomUUID()}@example.test`,
    });
    const member = await auth.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name: 'Member',
      email: `member-${randomUUID()}@example.test`,
    });
    const team = await auth.createWorkspace({ name: 'Kitchen', createdBy: owner.id });
    await auth.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.id, role: 'member' });
    await auth.saveWorkspaceInvite({
      workspaceId: team.workspace.id,
      token: `invite-${randomUUID()}`,
      createdBy: owner.id,
    });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.id,
      title: 'Doomed',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    });
    await meetings.saveCalendarEvent!(meeting.id, {
      uid: `kaki-meeting-${meeting.id}@kaki.local`,
      sequence: 0,
      state: 'synced',
      error: null,
      syncedAt: new Date().toISOString(),
    });
    await tools.save({
      workspaceId: team.workspace.id,
      kind: 'calendar',
      settings: { caldavUrl: 'http://calendar.test' },
      secret: randomBytes(16),
      iv: randomBytes(12),
      tag: randomBytes(16),
      keyId: `key-${randomUUID()}`,
      connectedBy: owner.id,
      connectedAt: new Date(),
      lastOkAt: null,
    });
    await postgres.pool.query(
      'create table if not exists knowledge_chunks (workspace_id text, source text, ref text)',
    );
    await postgres.pool.query(
      "insert into knowledge_chunks (workspace_id, source, ref) values ($1, 'calendar', 'event-1')",
      [team.workspace.id],
    );

    let preparedForUnauthorized = false;
    expect(
      await deletion.deleteWorkspace({
        workspaceId: team.workspace.id,
        actorUserId: member.id,
        beforeDelete: async () => {
          preparedForUnauthorized = true;
        },
      }),
    ).toBe(false);
    // Side effects run only after the locked admin recheck, so a demoted actor reaches none of them.
    expect(preparedForUnauthorized).toBe(false);
    expect(await auth.getWorkspace(team.workspace.id)).toBeDefined();

    let preparedFor = '';
    expect(
      await deletion.deleteWorkspace({
        workspaceId: team.workspace.id,
        actorUserId: owner.id,
        beforeDelete: async (workspace) => {
          preparedFor = workspace.name;
        },
      }),
    ).toBe(true);
    expect(preparedFor).toBe('Kitchen');
    expect(await auth.getWorkspace(team.workspace.id)).toBeUndefined();
    expect(await auth.getWorkspaceInvite(team.workspace.id)).toBeUndefined();
    expect(await meetings.list(team.workspace.id)).toEqual([]);
    expect(await meetings.calendarEventFor!(meeting.id)).toBeUndefined();
    expect(await tools.list(team.workspace.id)).toEqual([]);
    const chunks = await postgres.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_chunks where workspace_id = $1',
      [team.workspace.id],
    );
    expect(chunks.rows[0]?.count).toBe('0');

    // A writer that wakes up after the commit cannot recreate the deleted workspace's data.
    await expect(
      tools.save({
        workspaceId: team.workspace.id,
        kind: 'calendar',
        settings: { caldavUrl: 'http://calendar.test' },
        secret: randomBytes(16),
        iv: randomBytes(12),
        tag: randomBytes(16),
        keyId: `key-${randomUUID()}`,
        connectedBy: owner.id,
        connectedAt: new Date(),
        lastOkAt: null,
      }),
    ).rejects.toThrow(/foreign key/);
    await expect(
      meetings.create({
        workspaceId: team.workspace.id,
        ownerUserId: owner.id,
        title: 'Resurrected',
      }),
    ).rejects.toThrow(/no longer exists/);
  });
});
