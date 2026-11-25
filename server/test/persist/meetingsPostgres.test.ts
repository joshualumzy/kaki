import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAuthSchema, ensureMeetingsSchema } from '../../src/auth/schema';
import { createPostgresMeetingStore } from '../../src/meeting/registry';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

describe.skipIf(connectionString === undefined)('postgres meeting store agenda', () => {
  let postgres: PostgresTestSchema | undefined;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    await ensureAuthSchema(postgres.pool);
    await ensureMeetingsSchema(postgres.pool);
    // Every meeting belongs to an account, and the store checks that owner still exists.
    await postgres.pool.query(
      "insert into users (id, email) values ('owner-1', 'owner-1@example.test')",
    );
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  it('stores the agenda, owners and pace, and reads them back on get and list', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const agenda = [
      { title: 'Budget', minutes: 15, ownerUserId: 'owner-1' },
      { title: 'Hiring' },
    ];
    const pace = { quietCheckAfter: 90, comingUpBefore: 45 };

    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'Planning',
      agenda,
      pace,
    });

    expect(meeting.agenda).toEqual(agenda);
    expect(meeting.pace).toEqual(pace);
    expect((await store.get(meeting.id))?.agenda).toEqual(agenda);
    expect((await store.get(meeting.id))?.pace).toEqual(pace);
    expect((await store.list(workspaceId))[0]?.agenda).toEqual(agenda);
  });

  it('updates a meeting in place', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'Planning',
      agenda: [{ title: 'Budget', minutes: 10 }],
    });
    const scheduledFor = new Date(Date.now() + 60 * 60_000).toISOString();

    const updated = await store.update!(meeting.id, {
      title: 'Planning v2',
      agenda: [{ title: 'Budget', minutes: 20, ownerUserId: 'owner-1' }],
      pace: { quietCheckAfter: 60, comingUpBefore: 30 },
      scheduledFor,
    });

    expect(updated).toMatchObject({
      title: 'Planning v2',
      agenda: [{ title: 'Budget', minutes: 20, ownerUserId: 'owner-1' }],
      pace: { quietCheckAfter: 60, comingUpBefore: 30 },
      scheduledFor,
    });
    expect(await store.get(meeting.id)).toMatchObject({ title: 'Planning v2' });
  });

  it('deletes the row, saved state, seat claims and meeting knowledge chunk together', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'Cancelled',
    });
    await postgres.pool.query(`
      create table if not exists meeting_state (
        id text primary key,
        schema_version integer not null,
        saved_at timestamptz not null,
        state jsonb not null
      )
    `);
    await postgres.pool.query(
      "insert into meeting_state (id, schema_version, saved_at, state) values ($1, 1, now(), '{}')",
      [meeting.id],
    );
    await postgres.pool.query(
      "insert into seat_claims (meeting_id, role, holder, expires_at) values ($1, 'seat-1', 'holder-1', now() + interval '1 hour')",
      [meeting.id],
    );
    await postgres.pool.query('create table if not exists knowledge_chunks (workspace_id text, source text, ref text)');
    await postgres.pool.query(
      "insert into knowledge_chunks (workspace_id, source, ref) values ($1, 'meeting', $2)",
      [workspaceId, `meeting:${meeting.id}`],
    );

    expect(await store.delete!(meeting.id)).toBe(true);
    expect(await store.get(meeting.id)).toBeUndefined();
    const counts = await postgres.pool.query<{
      states: string;
      claims: string;
      chunks: string;
    }>(
      `select
         (select count(*)::text from meeting_state where id = $1) as states,
         (select count(*)::text from seat_claims where meeting_id = $1) as claims,
         (select count(*)::text from knowledge_chunks where ref = $2) as chunks`,
      [meeting.id, `meeting:${meeting.id}`],
    );
    expect(counts.rows[0]).toEqual({ states: '0', claims: '0', chunks: '0' });
  });

  it('marks a scheduled meeting open once it starts, atomically', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const meeting = await store.create({
      workspaceId: `workspace-${randomUUID()}`,
      ownerUserId: 'owner-1',
      title: 'Starting early',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    expect(await store.markOpen!(meeting.id)).toBe(true);
    expect((await store.get(meeting.id))?.status).toBe('open');
    // Starting again is harmless, but the transition is never undone.
    expect(await store.markOpen!(meeting.id)).toBe(true);
    expect((await store.get(meeting.id))?.status).toBe('open');
  });

  it('refuses a scheduled-only edit or delete once the meeting has started', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const meeting = await store.create({
      workspaceId: `workspace-${randomUUID()}`,
      ownerUserId: 'owner-1',
      title: 'Starting early',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await store.markOpen!(meeting.id);

    expect(await store.update!(meeting.id, { title: 'Too late' }, { onlyIfScheduled: true })).toBeUndefined();
    expect(await store.delete!(meeting.id, { onlyIfScheduled: true })).toBe(false);
    expect((await store.get(meeting.id))?.title).toBe('Starting early');
  });

  it('keeps one calendar event state per meeting and deletes it with the meeting or workspace', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'On the calendar',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    await store.saveCalendarEvent!(meeting.id, {
      uid: `kaki-meeting-${meeting.id}@kaki.local`,
      sequence: 2,
      state: 'error',
      error: 'The calendar returned HTTP 500',
      syncedAt: null,
    });
    expect(await store.calendarEventFor!(meeting.id)).toEqual({
      uid: `kaki-meeting-${meeting.id}@kaki.local`,
      sequence: 2,
      state: 'error',
      error: 'The calendar returned HTTP 500',
      syncedAt: null,
    });

    await store.saveCalendarEvent!(meeting.id, {
      uid: `kaki-meeting-${meeting.id}@kaki.local`,
      sequence: 2,
      state: 'synced',
      error: null,
      syncedAt: new Date().toISOString(),
    });
    expect((await store.calendarEventFor!(meeting.id))?.state).toBe('synced');

    await store.deleteWorkspace!(workspaceId);
    expect(await store.list(workspaceId)).toEqual([]);
    expect(await store.calendarEventFor!(meeting.id)).toBeUndefined();
    const remaining = await postgres.pool.query<{ count: string }>(
      'select count(*)::text as count from meeting_calendar_events where meeting_id = $1',
      [meeting.id],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });

  it('stores a meeting with no agenda as an empty list', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;

    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'No agenda yet',
    });

    expect(meeting.agenda).toEqual([]);
    expect((await store.get(meeting.id))?.agenda).toEqual([]);
  });
});
