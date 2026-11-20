import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import type { AuthStore } from '../../src/auth/store';
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
});
