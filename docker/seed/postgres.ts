import { Client } from 'pg';
import type { Env } from './env';
import { sleep } from './http';
import type { ScenarioSeed } from './scenario';


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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`Seeding Postgres failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await client.end();
  }
}
