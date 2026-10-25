import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAuthStore } from '../src/auth/postgres';
import { ensureAuthSchema } from '../src/auth/schema';
import type { AuthStore } from '../src/auth/store';

const connectionString = process.env.POSTGRES_URL;
const email = `auth-test-${randomUUID()}@example.test`;

describe.skipIf(connectionString === undefined)('postgres auth store', () => {
  let pool: Pool;
  let store: AuthStore;
  const tokenHashes: string[] = [];

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    pool = new Pool({ connectionString });
    await ensureAuthSchema(pool);
    await ensureAuthSchema(pool);
    store = createPostgresAuthStore(pool);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query('delete from sessions where token_hash = any($1)', [tokenHashes]);
    await pool.query('delete from users where email = $1', [email]);
    await pool.end();
  });

  it('stores a host account and a session, and drops expired sessions', async () => {
    const user = await store.createUser({ email, passwordHash: 'scrypt:salt:hash' });
    expect(user.email).toBe(email);

    const found = await store.findUserByEmail(email);
    expect(found?.id).toBe(user.id);
    expect(found?.passwordHash).toBe('scrypt:salt:hash');
    expect(found?.createdAt).toBeInstanceOf(Date);

    const tokenHash = `auth-test-${randomUUID()}`;
    tokenHashes.push(tokenHash);
    await store.createSession({
      tokenHash,
      kind: 'participant',
      role: 'chef',
      meetingCode: 'K7M2Q9',
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
    tokenHashes.push(expiredHash);
    await store.createSession({
      tokenHash: expiredHash,
      kind: 'host',
      role: null,
      meetingCode: null,
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
