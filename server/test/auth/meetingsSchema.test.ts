import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMeetingsSchema } from '../../src/auth/schema';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

function pinnedPool(url: string, schema: string): Pool {
  return new Pool({ connectionString: url, options: `-c search_path=${schema}` });
}

interface FakeClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** A pool whose migration statements succeed without a database, to test the memo only. */
function fakePool(options: { failFirstConnect?: boolean } = {}): {
  pool: Pool;
  connects: () => number;
} {
  let connects = 0;
  let failed = false;
  const client: FakeClient = {
    async query() {
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect(): Promise<FakeClient> {
      connects += 1;
      if (options.failFirstConnect === true && !failed) {
        failed = true;
        throw new Error('connect failed');
      }
      return client;
    },
  } as unknown as Pool;
  return { pool, connects: () => connects };
}

describe('ensureMeetingsSchema memo', () => {
  it('runs the migration once per pool, however many callers there are', async () => {
    const { pool, connects } = fakePool();
    await ensureMeetingsSchema(pool);
    expect(connects()).toBe(1);
    await ensureMeetingsSchema(pool);
    await Promise.all([ensureMeetingsSchema(pool), ensureMeetingsSchema(pool)]);
    expect(connects()).toBe(1);
  });

  it('does not cache a failed run, so the next call retries', async () => {
    const { pool, connects } = fakePool({ failFirstConnect: true });
    await expect(ensureMeetingsSchema(pool)).rejects.toThrow('connect failed');
    await ensureMeetingsSchema(pool);
    expect(connects()).toBe(2);
  });
});

describe.skipIf(connectionString === undefined)('postgres meetings migration', () => {
  let postgres: PostgresTestSchema | undefined;
  let extraPool: Pool | undefined;

  afterEach(async () => {
    await extraPool?.end().catch(() => undefined);
    extraPool = undefined;
    await postgres?.dispose();
    postgres = undefined;
  });

  async function freshSchema(): Promise<PostgresTestSchema> {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    return postgres;
  }

  it('survives two processes booting at once', async () => {
    const schema = await freshSchema();
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    const second = pinnedPool(connectionString, schema.schema);
    extraPool = second;

    await expect(
      Promise.all([ensureMeetingsSchema(schema.pool), ensureMeetingsSchema(second)]),
    ).resolves.toEqual([undefined, undefined]);

    await schema.pool.query(
      "insert into meetings (id, workspace_id, title, kind) values ('at-once', 'w', 'At once', 'practice')",
    );
    const row = await schema.pool.query('select kind from meetings where id = $1', ['at-once']);
    expect(row.rows[0]?.kind).toBe('practice');
  });

  it('sweeps a differently named kind check that predates practice', async () => {
    const schema = await freshSchema();
    await schema.pool.query(`
      create table meetings (
        id text primary key,
        workspace_id text not null,
        owner_user_id text,
        title text not null,
        kind text not null default 'real',
        scheduled_for timestamptz,
        agenda jsonb,
        created_at timestamptz not null default now(),
        ended_at timestamptz,
        constraint legacy_real_only check (kind = 'real')
      )
    `);
    await schema.pool.query('create table meeting_state (id text primary key, kind text)');
    await schema.pool.query(
      "insert into meetings (id, workspace_id, title) values ('old-1', 'w', 'Old meeting')",
    );
    await schema.pool.query("insert into meeting_state (id, kind) values ('old-1', 'practice')");

    await ensureMeetingsSchema(schema.pool);

    const backfilled = await schema.pool.query('select kind from meetings where id = $1', ['old-1']);
    expect(backfilled.rows[0]?.kind).toBe('practice');

    const constraints = await schema.pool.query<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'meetings'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%kind%'`,
    );
    const names = constraints.rows.map((constraint) => constraint.conname);
    expect(names).not.toContain('legacy_real_only');
    expect(names).toContain('meetings_kind_check');
    expect(constraints.rows.every((constraint) => constraint.definition.includes('practice'))).toBe(true);
  });
});
