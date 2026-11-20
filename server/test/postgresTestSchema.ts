import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/** A throwaway schema for one Postgres test file or case, with every query pinned to it. */
export interface PostgresTestSchema {
  readonly schema: string;
  /** The only pool callers may run queries on; it is pinned to `schema`, never `public`. */
  readonly pool: Pool;
  /** Close the pool and drop the schema, even when the test failed. Safe to call once. */
  dispose(): Promise<void>;
}

function searchPathOption(schema: string): string {
  return `-c search_path=${schema}`;
}

function assertPinned(pool: Pool, schema: string): void {
  const options = pool.options.options;
  if (typeof options !== 'string' || !options.includes(`search_path=${schema}`)) {
    throw new Error(
      `kaki test: refusing to query Postgres without search_path=${schema}. ` +
        'Use the pool from createPostgresTestSchema() so a test can never touch public.',
    );
  }
}

/** Run every query and connection through the pinned-pool check before it reaches Postgres. */
function guardPool(pool: Pool, schema: string): void {
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = ((...args: unknown[]) => {
    assertPinned(pool, schema);
    return query(...args);
  }) as unknown as Pool['query'];

  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = ((...args: unknown[]) => {
    assertPinned(pool, schema);
    return connect(...args);
  }) as unknown as Pool['connect'];
}

/**
 * Create a fresh, uniquely named schema and a pool whose search_path is pinned to it. The bootstrap
 * connection is private: it only creates and drops the schema, so no test query can reach `public`.
 */
export async function createPostgresTestSchema(connectionString: string): Promise<PostgresTestSchema> {
  if (connectionString.trim() === '') {
    throw new Error('kaki test: POSTGRES_URL is empty');
  }

  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = new Pool({ connectionString });
  let pool: Pool | undefined;

  try {
    await bootstrap.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString, options: searchPathOption(schema) });
    guardPool(pool, schema);
  } catch (error) {
    if (pool !== undefined) await pool.end().catch(() => undefined);
    await bootstrap.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
    throw error;
  }

  const pinnedPool = pool;
  if (pinnedPool === undefined) throw new Error('kaki test: could not create the test schema pool');

  let disposed = false;
  return {
    schema,
    pool: pinnedPool,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        // The app may already have closed the auth store's pool during its own shutdown.
        if (!pinnedPool.ending) await pinnedPool.end();
      } finally {
        try {
          await bootstrap.query(`drop schema if exists "${schema}" cascade`);
        } finally {
          await bootstrap.end();
        }
      }
    },
  };
}
