import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAccountDataDeletion } from '../../src/account/deleteAccountData';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import type { AuthStore } from '../../src/auth/store';
import { createPostgresMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { createPostgresWorkspaceToolStore, type WorkspaceToolStore } from '../../src/workspace/tools';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toolRecord(workspaceId: string, tag: string) {
  return {
    workspaceId,
    kind: 'mattermost' as const,
    settings: { url: 'http://mattermost.test', team: tag },
    secret: Buffer.from('secret'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
    keyId: 'key-1',
    connectedBy: 'tester',
    connectedAt: new Date('2026-11-01T00:00:00Z'),
    lastOkAt: null,
  };
}

describe.skipIf(connectionString === undefined)('postgres account data deletion', () => {
  let postgres: PostgresTestSchema | undefined;
  let store: AuthStore;
  let meetings: MeetingStore;
  let tools: WorkspaceToolStore;
  let deletion: ReturnType<typeof createPostgresAccountDataDeletion>;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    await ensureAuthSchema(postgres.pool);
    await postgres.pool.query('create table if not exists meeting_state (id text primary key)');
    await postgres.pool.query(
      'create table if not exists knowledge_chunks (workspace_id text not null, ref text not null)',
    );
    store = createPostgresAuthStore(postgres.pool);
    meetings = createPostgresMeetingStore(postgres.pool);
    tools = createPostgresWorkspaceToolStore(postgres.pool);
    deletion = createPostgresAccountDataDeletion({
      pool: postgres.pool,
      auth: store,
      meetings,
      tools,
    });
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  async function account(name: string) {
    const user = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name,
      email: `${randomUUID()}@example.test`,
    });
    const personal = (await store.listWorkspacesForUser(user.id))[0]!.workspace;
    const sessionHashes: string[] = [];
    for (const kind of ['user', 'participant'] as const) {
      const tokenHash = `session-${randomUUID()}`;
      await store.createSession({
        tokenHash,
        kind,
        role: kind === 'participant' ? 'chef' : null,
        meetingCode: null,
        meetingId: kind === 'participant' ? 'meeting' : null,
        displayName: name,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      sessionHashes.push(tokenHash);
    }
    return { user, personal, sessionHashes };
  }

  async function claim(meetingId: string, holder: string): Promise<void> {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    await postgres.pool.query(
      `insert into seat_claims (meeting_id, role, holder, expires_at)
       values ($1, 'chef', $2, now() + interval '1 hour')`,
      [meetingId, holder],
    );
  }

  async function state(meetingId: string): Promise<void> {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    await postgres.pool.query('insert into meeting_state (id) values ($1)', [meetingId]);
  }

  async function chunk(workspaceId: string, ref: string): Promise<void> {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    await postgres.pool.query('insert into knowledge_chunks (workspace_id, ref) values ($1, $2)', [
      workspaceId,
      ref,
    ]);
  }

  it('deletes every owned row in one transaction and revokes every session by user id', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const ada = await account('Ada Lovelace');
    const ben = await account('Ben Bitdiddle');
    const adaTeam = await store.createWorkspace({ name: 'Ada team', createdBy: ada.user.id });
    const benTeam = await store.createWorkspace({ name: 'Ben team', createdBy: ben.user.id });
    await store.addWorkspaceMember({
      workspaceId: benTeam.workspace.id,
      userId: ada.user.id,
      role: 'member',
    });
    await store.addWorkspaceMember({
      workspaceId: adaTeam.workspace.id,
      userId: ben.user.id,
      role: 'member',
    });

    const adaPersonalMeeting = await meetings.create({
      workspaceId: ada.personal.id,
      ownerUserId: ada.user.id,
      title: 'Ada personal',
    });
    const adaTeamMeeting = await meetings.create({
      workspaceId: adaTeam.workspace.id,
      ownerUserId: ada.user.id,
      title: 'Ada team',
    });
    const benInAdaTeam = await meetings.create({
      workspaceId: adaTeam.workspace.id,
      ownerUserId: ben.user.id,
      title: 'Ben in Ada team',
    });
    const adaInBenTeam = await meetings.create({
      workspaceId: benTeam.workspace.id,
      ownerUserId: ada.user.id,
      title: 'Ada in Ben team',
    });
    const benOwnMeeting = await meetings.create({
      workspaceId: ben.personal.id,
      ownerUserId: ben.user.id,
      title: 'Ben personal',
    });
    for (const meeting of [
      adaPersonalMeeting,
      adaTeamMeeting,
      benInAdaTeam,
      adaInBenTeam,
      benOwnMeeting,
    ]) {
      // The route ends every meeting it can before this transaction starts.
      await meetings.markEnded!(meeting.id, new Date().toISOString());
      await state(meeting.id);
    }
    // Another visitor's practice history has no owner and no workspace row; it must survive.
    await state('practice-visitor-history');
    await claim(adaPersonalMeeting.id, ada.sessionHashes[1]!);
    await claim(benInAdaTeam.id, ben.sessionHashes[1]!);
    await claim(adaInBenTeam.id, ada.sessionHashes[1]!);
    await claim(benOwnMeeting.id, ben.sessionHashes[1]!);

    await tools.save(toolRecord(ada.personal.id, 'ada-personal'));
    await tools.save(toolRecord(adaTeam.workspace.id, 'ada-team'));
    await tools.save(toolRecord(ben.personal.id, 'ben-personal'));
    await tools.save(toolRecord(benTeam.workspace.id, 'ben-team'));

    await chunk(ada.personal.id, 'ada-personal');
    await chunk(adaTeam.workspace.id, 'ada-team');
    await chunk(ben.personal.id, 'ben-personal');
    await chunk(benTeam.workspace.id, 'ben-team');
    await chunk(SAMPLE_WORKSPACE_ID, 'sample');
    await chunk('practice-visitor-workspace', 'practice');

    const guestHash = `guest-${randomUUID()}`;
    await store.createSession({
      tokenHash: guestHash,
      kind: 'guest',
      role: null,
      meetingCode: null,
      meetingId: adaPersonalMeeting.id,
      displayName: 'Visitor',
      userId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const hashes = await deletion.deleteAccountData(ada.user.id);

    expect(new Set(hashes)).toEqual(new Set(ada.sessionHashes));
    expect(await store.findUserById(ada.user.id)).toBeUndefined();
    expect(await store.findUserById(ben.user.id)).toBeDefined();
    expect(await store.getWorkspace(ada.personal.id)).toBeUndefined();
    // Ada's team still has Ben, so it survives with its data; only her attribution and membership go.
    expect(await store.getWorkspace(adaTeam.workspace.id)).toMatchObject({ createdBy: null });
    expect(await store.getWorkspace(ben.personal.id)).toBeDefined();
    expect(await store.getWorkspace(benTeam.workspace.id)).toBeDefined();
    expect(
      await store.getMembership({ workspaceId: adaTeam.workspace.id, userId: ben.user.id }),
    ).toBe('admin');
    expect(
      await store.getMembership({ workspaceId: benTeam.workspace.id, userId: ada.user.id }),
    ).toBeUndefined();
    expect(
      await store.getMembership({ workspaceId: benTeam.workspace.id, userId: ben.user.id }),
    ).toBe('admin');

    for (const hash of ada.sessionHashes) expect(await store.findSession(hash)).toBeUndefined();
    expect(await store.findSession(ben.sessionHashes[0]!)).toBeDefined();
    expect(await store.findSession(guestHash)).toBeDefined();

    expect(await meetings.get(adaPersonalMeeting.id)).toBeUndefined();
    // Ada's team survives, so its meetings stay; the ones she owned are handed to the workspace.
    expect((await meetings.get(adaTeamMeeting.id))?.ownerUserId).toBeNull();
    expect((await meetings.get(benInAdaTeam.id))?.ownerUserId).toBe(ben.user.id);
    const kept = await meetings.get(adaInBenTeam.id);
    expect(kept?.ownerUserId).toBeNull();
    expect((await meetings.get(benOwnMeeting.id))?.ownerUserId).toBe(ben.user.id);

    const states = await postgres.pool.query<{ id: string }>('select id from meeting_state');
    expect(new Set(states.rows.map((row) => row.id))).toEqual(
      new Set([
        adaTeamMeeting.id,
        benInAdaTeam.id,
        adaInBenTeam.id,
        benOwnMeeting.id,
        'practice-visitor-history',
      ]),
    );
    const claims = await postgres.pool.query<{ meeting_id: string; holder: string }>(
      'select meeting_id, holder from seat_claims order by meeting_id',
    );
    expect(claims.rows).toEqual(
      expect.arrayContaining([
        { meeting_id: benInAdaTeam.id, holder: ben.sessionHashes[1]! },
        { meeting_id: benOwnMeeting.id, holder: ben.sessionHashes[1]! },
      ]),
    );
    expect(claims.rows).toHaveLength(2);

    expect(await tools.list(ada.personal.id)).toEqual([]);
    expect(await tools.list(adaTeam.workspace.id)).toHaveLength(1);
    expect(await tools.list(ben.personal.id)).toHaveLength(1);
    expect(await tools.list(benTeam.workspace.id)).toHaveLength(1);

    const chunks = await postgres.pool.query<{ workspace_id: string }>(
      'select workspace_id from knowledge_chunks',
    );
    expect(new Set(chunks.rows.map((row) => row.workspace_id))).toEqual(
      new Set([
        SAMPLE_WORKSPACE_ID,
        'practice-visitor-workspace',
        adaTeam.workspace.id,
        ben.personal.id,
        benTeam.workspace.id,
      ]),
    );
  });

  it("deletes the account's own practice meetings with their state and claims", async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const ada = await account('Ada Practice');
    const ben = await account('Ben Practice');
    const adaPractice = await meetings.create({
      workspaceId: SAMPLE_WORKSPACE_ID,
      ownerUserId: ada.user.id,
      title: 'Ada practice',
      kind: 'practice',
    });
    const benPractice = await meetings.create({
      workspaceId: SAMPLE_WORKSPACE_ID,
      ownerUserId: ben.user.id,
      title: 'Ben practice',
      kind: 'practice',
    });
    // A real meeting in the shared sample workspace is not the account's own practice: it stays.
    const adaSampleReal = await meetings.create({
      workspaceId: SAMPLE_WORKSPACE_ID,
      ownerUserId: ada.user.id,
      title: 'Ada real in sample',
    });
    for (const meeting of [adaPractice, benPractice, adaSampleReal]) {
      await meetings.markEnded!(meeting.id, new Date().toISOString());
      await state(meeting.id);
    }
    await claim(adaPractice.id, ada.sessionHashes[1]!);
    await claim(benPractice.id, ben.sessionHashes[1]!);
    await claim(adaSampleReal.id, ada.sessionHashes[1]!);

    await deletion.deleteAccountData(ada.user.id);

    expect(await meetings.get(adaPractice.id)).toBeUndefined();
    expect(await meetings.get(benPractice.id)).toMatchObject({ ownerUserId: ben.user.id });
    expect(await meetings.get(adaSampleReal.id)).toMatchObject({ ownerUserId: null });

    const states = await postgres.pool.query<{ id: string }>('select id from meeting_state');
    const stateIds = new Set(states.rows.map((row) => row.id));
    expect(stateIds.has(adaPractice.id)).toBe(false);
    expect(stateIds.has(benPractice.id)).toBe(true);
    expect(stateIds.has(adaSampleReal.id)).toBe(true);
    // The deleted account's own claim goes with their sessions; the other person's stays.
    const claims = await postgres.pool.query<{ meeting_id: string }>(
      'select meeting_id from seat_claims',
    );
    const claimIds = claims.rows.map((row) => row.meeting_id);
    expect(claimIds).not.toContain(adaPractice.id);
    expect(claimIds).not.toContain(adaSampleReal.id);
    expect(claimIds).toContain(benPractice.id);
  });

  it('rolls everything back when a delete fails midway, and a retry finishes the job', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const ada = await account('Ada Rollback');
    const meeting = await meetings.create({
      workspaceId: ada.personal.id,
      ownerUserId: ada.user.id,
      title: 'Rollback',
    });
    await meetings.markEnded!(meeting.id, new Date().toISOString());
    await state(meeting.id);
    await tools.save(toolRecord(ada.personal.id, 'rollback'));
    await chunk(ada.personal.id, 'rollback');
    await claim(meeting.id, ada.sessionHashes[1]!);

    await postgres.pool.query(
      `create function raise_on_user_delete() returns trigger language plpgsql as $$
       begin raise exception 'blocked user delete'; end $$`,
    );
    await postgres.pool.query(
      'create trigger block_user_delete before delete on users for each row execute function raise_on_user_delete()',
    );
    try {
      await expect(deletion.deleteAccountData(ada.user.id)).rejects.toThrow(/blocked user delete/);

      expect(await store.findUserById(ada.user.id)).toBeDefined();
      for (const hash of ada.sessionHashes) expect(await store.findSession(hash)).toBeDefined();
      expect(await store.getWorkspace(ada.personal.id)).toBeDefined();
      expect(await meetings.get(meeting.id)).toBeDefined();
      expect(
        (
          await postgres.pool.query('select id from meeting_state where id = $1', [meeting.id])
        ).rowCount,
      ).toBe(1);
      expect(
        (await postgres.pool.query('select 1 from seat_claims where meeting_id = $1', [meeting.id]))
          .rowCount,
      ).toBe(1);
      expect(await tools.list(ada.personal.id)).toHaveLength(1);
      expect(
        (
          await postgres.pool.query('select 1 from knowledge_chunks where workspace_id = $1', [
            ada.personal.id,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await postgres.pool.query('drop trigger if exists block_user_delete on users');
      await postgres.pool.query('drop function if exists raise_on_user_delete()');
    }

    await deletion.deleteAccountData(ada.user.id);
    expect(await store.findUserById(ada.user.id)).toBeUndefined();
    expect(await meetings.get(meeting.id)).toBeUndefined();
    expect(await tools.list(ada.personal.id)).toEqual([]);
  });

  it('rolls back and asks for a retry when a meeting is created after endOwnedBy ran', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const ada = await account('Ada Race');
    const earlier = await meetings.create({
      workspaceId: ada.personal.id,
      ownerUserId: ada.user.id,
      title: 'Ended before deletion',
    });
    await meetings.markEnded!(earlier.id, new Date().toISOString());
    // The meeting the owner created while the deletion was between endOwnedBy and its transaction.
    const raced = await meetings.create({
      workspaceId: ada.personal.id,
      ownerUserId: ada.user.id,
      title: 'Created during deletion',
    });
    await state(raced.id);
    await tools.save(toolRecord(ada.personal.id, 'race'));
    await chunk(ada.personal.id, 'race');

    await expect(deletion.deleteAccountData(ada.user.id)).rejects.toThrow(/try again/);

    expect(await store.findUserById(ada.user.id)).toBeDefined();
    for (const hash of ada.sessionHashes) expect(await store.findSession(hash)).toBeDefined();
    expect(await store.getWorkspace(ada.personal.id)).toBeDefined();
    expect(await meetings.get(earlier.id)).toBeDefined();
    expect(await meetings.get(raced.id)).toBeDefined();
    expect(
      (await postgres.pool.query('select id from meeting_state where id = $1', [raced.id])).rowCount,
    ).toBe(1);
    expect(await tools.list(ada.personal.id)).toHaveLength(1);
    expect(
      (
        await postgres.pool.query('select 1 from knowledge_chunks where workspace_id = $1', [
          ada.personal.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('makes a meeting insert wait for the account lock, then fail once the account is gone', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const userId = randomUUID();
    await postgres.pool.query('insert into users (id, email) values ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ]);
    const lock = await postgres.pool.connect();
    try {
      await lock.query('begin');
      // What the deletion holds before it looks for open meetings.
      await lock.query('select id from users where id = $1 for update', [userId]);
      const create = meetings.create({
        workspaceId: 'workspace-race',
        ownerUserId: userId,
        title: 'Raced in',
      });
      const outcome = await Promise.race([
        create.then(
          () => 'inserted' as const,
          () => 'rejected' as const,
        ),
        delay(200).then(() => 'blocked' as const),
      ]);
      expect(outcome).toBe('blocked');
      await lock.query('delete from users where id = $1', [userId]);
      await lock.query('commit');
      await expect(create).rejects.toThrow(/no longer exists/);
      expect(await meetings.listByOwner!(userId)).toEqual([]);
    } finally {
      await lock.query('rollback').catch(() => undefined);
      lock.release();
    }
  });

  it('waits for an in-flight meeting insert, then rolls back because the meeting is still open', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const ada = await account('Ada In Flight');
    const lock = await postgres.pool.connect();
    try {
      await lock.query('begin');
      // What a meeting insert holds while it checks the owner still exists.
      await lock.query('select id from users where id = $1 for key share', [ada.user.id]);
      const deletionPromise = deletion.deleteAccountData(ada.user.id);
      const outcome = await Promise.race([
        deletionPromise.then(
          () => 'finished' as const,
          () => 'rejected' as const,
        ),
        delay(200).then(() => 'blocked' as const),
      ]);
      expect(outcome).toBe('blocked');
      const raced = await meetings.create({
        workspaceId: ada.personal.id,
        ownerUserId: ada.user.id,
        title: 'Created while deleting',
      });
      await lock.query('commit');
      await expect(deletionPromise).rejects.toThrow(/try again/);
      expect(await store.findUserById(ada.user.id)).toBeDefined();
      expect(await meetings.get(raced.id)).toBeDefined();
    } finally {
      await lock.query('rollback').catch(() => undefined);
      lock.release();
    }
  });
});
