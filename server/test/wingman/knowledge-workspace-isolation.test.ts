import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { deleteKnowledgeFor } from '../../src/workspace/tools';
import {
  ensureKnowledgeSchema,
  writeWorkspaceChunks,
  type KnowledgeSource,
} from '../../src/wingman/knowledge/indexer';
import {
  buildRetrievalQueries,
  retrieveFromPostgres,
} from '../../src/wingman/knowledge/search';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

function chunk(source: KnowledgeSource, ref: string, text: string) {
  return { source, ref, text, publishedAt: '2026-11-22', location: 'test' };
}

describe('workspace-scoped retrieval queries', () => {
  it('names the workspace in both the vector and the keyword query', () => {
    const queries = buildRetrievalQueries('ws-a', [0.1, 0.2], 'how much?', 8);

    expect(queries.vector.text).toContain('workspace_id = $1');
    expect(queries.vector.values).toEqual(['ws-a', '[0.1,0.2]', 8]);
    expect(queries.keyword.text).toContain('workspace_id = $2');
    expect(queries.keyword.values).toEqual(['how much?', 'ws-a', 8]);
  });

  it('runs only queries bound to the requested workspace', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Pool;

    expect(await retrieveFromPostgres(pool, 'ws-a', [0.1], 'question', 8)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.values.includes('ws-a'))).toBe(true);
    expect(calls.every((call) => call.text.includes('workspace_id = $'))).toBe(true);
  });
});

const connectionString = process.env.POSTGRES_URL;

/**
 * The test schema's search_path intentionally excludes public, where pgvector's type lives. These
 * tests therefore stand a text domain in for the vector column: the production write/delete/filter
 * SQL is still exercised, while the pure unit tests above cover the vector query builder.
 */
describe.skipIf(connectionString === undefined)('workspace knowledge isolation in Postgres', () => {
  let postgres: PostgresTestSchema | undefined;
  let pool: Pool;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    pool = postgres.pool;
    await pool.query('create domain vector as text');
    await pool.query(`
      create table knowledge_chunks (
        id bigserial primary key,
        source text not null,
        ref text not null,
        text text not null,
        published_at timestamptz not null,
        embedding vector
      )
    `);
    await ensureKnowledgeSchema(pool);
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  async function refsFor(workspaceId: string, question: string): Promise<string[]> {
    const query = buildRetrievalQueries(workspaceId, [0], question, 8).keyword;
    const result = await pool.query<{ source: string; ref: string }>(query.text, query.values);
    return result.rows.map((row) => `${row.source}:${row.ref}`);
  }

  it('keeps two workspaces with the same source and ref apart', async () => {
    const a = `ws-a-${randomUUID()}`;
    const b = `ws-b-${randomUUID()}`;
    await writeWorkspaceChunks(pool, a, [chunk('wiki', 'page#1', 'alpha record')], [[0.1]]);
    await writeWorkspaceChunks(pool, b, [chunk('wiki', 'page#1', 'beta record')], [[0.2]]);

    expect(await refsFor(a, 'record')).toEqual(['wiki:page#1']);
    expect(await refsFor(b, 'record')).toEqual(['wiki:page#1']);

    const rows = await pool.query<{ workspace_id: string; text: string }>(
      'select workspace_id, text from knowledge_chunks where ref = $1 order by workspace_id',
      ['page#1'],
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { workspace_id: a, text: 'alpha record' },
        { workspace_id: b, text: 'beta record' },
      ]),
    );
  });

  it('reindexing one workspace never deletes another workspace\'s chunks', async () => {
    const a = `ws-a-${randomUUID()}`;
    const b = `ws-b-${randomUUID()}`;
    await writeWorkspaceChunks(pool, a, [chunk('wiki', 'old#1', 'alpha record')], [[0.1]]);
    await writeWorkspaceChunks(pool, b, [chunk('wiki', 'keep#1', 'beta record')], [[0.2]]);

    await writeWorkspaceChunks(pool, a, [chunk('wiki', 'new#1', 'alpha record')], [[0.3]]);

    expect(await refsFor(a, 'record')).toEqual(['wiki:new#1']);
    expect(await refsFor(b, 'record')).toEqual(['wiki:keep#1']);
  });

  it('finds nothing in an empty workspace and never the sample records', async () => {
    const empty = `ws-empty-${randomUUID()}`;
    expect(await refsFor(empty, 'record')).toEqual([]);

    await writeWorkspaceChunks(pool, SAMPLE_WORKSPACE_ID, [chunk('wiki', 'sample#1', 'sample record')], [[0.1]]);
    expect(await refsFor(empty, 'record')).toEqual([]);
    expect(await refsFor(SAMPLE_WORKSPACE_ID, 'record')).toEqual(['wiki:sample#1']);
  });

  it('disconnect deletes only that workspace and source', async () => {
    const a = `ws-a-${randomUUID()}`;
    const b = `ws-b-${randomUUID()}`;
    await writeWorkspaceChunks(
      pool,
      a,
      [chunk('mattermost', 'one', 'alpha record'), chunk('wiki', 'two', 'alpha record')],
      [[0.1], [0.2]],
    );
    await writeWorkspaceChunks(pool, b, [chunk('mattermost', 'one', 'beta record')], [[0.3]]);
    await writeWorkspaceChunks(
      pool,
      SAMPLE_WORKSPACE_ID,
      [chunk('mattermost', 'sample', 'sample record')],
      [[0.4]],
    );

    await deleteKnowledgeFor(pool, a, 'mattermost');

    const remaining = await pool.query<{ workspace_id: string; source: string; ref: string }>(
      'select workspace_id, source, ref from knowledge_chunks where workspace_id = any($1::text[]) order by workspace_id, source, ref',
      [[a, b, SAMPLE_WORKSPACE_ID]],
    );
    expect(remaining.rows).toEqual(
      expect.arrayContaining([
        { workspace_id: a, source: 'wiki', ref: 'two' },
        { workspace_id: b, source: 'mattermost', ref: 'one' },
        { workspace_id: SAMPLE_WORKSPACE_ID, source: 'mattermost', ref: 'sample' },
      ]),
    );
    expect(
      remaining.rows.some((row) => row.workspace_id === a && row.source === 'mattermost'),
    ).toBe(false);
  });
});
