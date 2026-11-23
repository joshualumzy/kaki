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

  it('stores the agenda and reads it back on get and list', async () => {
    if (postgres === undefined) throw new Error('POSTGRES_URL is missing');
    const store = createPostgresMeetingStore(postgres.pool);
    const workspaceId = `workspace-${randomUUID()}`;
    const agenda = [
      { title: 'Budget', minutes: 15 },
      { title: 'Hiring' },
    ];

    const meeting = await store.create({
      workspaceId,
      ownerUserId: 'owner-1',
      title: 'Planning',
      agenda,
    });

    expect(meeting.agenda).toEqual(agenda);
    expect((await store.get(meeting.id))?.agenda).toEqual(agenda);
    expect((await store.list(workspaceId))[0]?.agenda).toEqual(agenda);
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
