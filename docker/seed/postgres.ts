import { randomBytes, scryptSync } from 'node:crypto';
import { Client } from 'pg';
import type { Env } from './env';
import { sleep } from './http';
import type { ScenarioSeed } from './scenario';

function hashDemoPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}


function clientOptions(env: Env) {
  return {
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5_000,
  };
}

export async function seedPostgres(env: Env, seed: ScenarioSeed): Promise<void> {
  let client: Client | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = new Client(clientOptions(env));
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch (error) {
      lastError = error;
      await candidate.end().catch(() => undefined);
      await sleep(1_000);
    }
  }

  if (!client) {
    throw new Error(
      `Postgres is not reachable at ${env.POSTGRES_HOST}:${env.POSTGRES_PORT}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { cause: lastError },
    );
  }

  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(seed.postgresSchema);
    await client.query(seed.postgresData);
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text primary key,
        email text not null unique,
        password_hash text not null,
        created_at timestamptz not null default now()
      )
    `);
    const demoHash = hashDemoPassword('demo');
    await client.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ('user-demo', 'demo', $1), ('user-demo-email', 'demo@nanyangkopitiam.example', $1)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [demoHash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`Seeding Postgres failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await client.end();
  }
}
