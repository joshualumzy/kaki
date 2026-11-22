import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAuthSchema } from '../../src/auth/schema';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { encryptSecret, keyIdOf } from '../../src/workspace/secrets';
import {
  createMemoryWorkspaceToolStore,
  createPostgresWorkspaceToolStore,
  createWorkspaceToolSource,
  type WorkspaceToolRecord,
  type WorkspaceToolStore,
} from '../../src/workspace/tools';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

function key(): Buffer {
  return randomBytes(32);
}

function record(workspaceId: string, token: string): WorkspaceToolRecord {
  const secretKey = key();
  return {
    workspaceId,
    kind: 'mattermost',
    settings: { url: 'http://mattermost.test', team: 'kopitiam', channel: 'launch' },
    ...encryptSecret(token, secretKey),
    connectedBy: 'user-1',
    connectedAt: new Date('2026-11-01T00:00:00Z'),
    lastOkAt: new Date('2026-11-02T00:00:00Z'),
  };
}

describe('memory workspace tool store', () => {
  it('saves, lists, reads and deletes one workspace tool', async () => {
    const store = createMemoryWorkspaceToolStore();
    const saved = record('workspace-1', 'secret-token');
    await store.save(saved);
    await store.save(record('workspace-2', 'other-token'));

    expect((await store.list('workspace-1')).map((entry) => entry.kind)).toEqual(['mattermost']);
    const found = await store.get('workspace-1', 'mattermost');
    expect(found?.settings).toEqual(saved.settings);
    expect(found?.connectedBy).toBe('user-1');
    expect(found?.lastOkAt).toEqual(new Date('2026-11-02T00:00:00Z'));

    await store.delete('workspace-1', 'mattermost');
    expect(await store.get('workspace-1', 'mattermost')).toBeUndefined();
    expect((await store.list('workspace-2')).length).toBe(1);
  });
});

describe('workspace tool source', () => {
  it('decrypts a real workspace tool and never reads the sample environment', async () => {
    const store = createMemoryWorkspaceToolStore();
    const secretKey = key();
    const workspaceId = 'workspace-real';
    await store.save({
      workspaceId,
      kind: 'gitea',
      settings: { url: 'http://gitea.test', owner: 'kopitiam', repo: 'pos' },
      ...encryptSecret('gitea-token', secretKey),
      connectedBy: 'user-1',
      connectedAt: new Date(),
      lastOkAt: null,
    });
    const source = createWorkspaceToolSource(store, {
      KAKI_SECRET_KEY: secretKey.toString('base64'),
    });

    const tools = await source.toolsFor(workspaceId);
    expect(tools.readOnly).toBe(false);
    expect(tools.gitea).toEqual({
      url: 'http://gitea.test',
      token: 'gitea-token',
      owner: 'kopitiam',
      repo: 'pos',
    });
    expect(tools.mattermost).toBeUndefined();
  });

  it('gives the sample workspace the environment tools and marks it read-only', async () => {
    const source = createWorkspaceToolSource(createMemoryWorkspaceToolStore(), {
      MATTERMOST_URL: 'http://mattermost.test',
      MATTERMOST_TOKEN: 'sample-token',
      MATTERMOST_TEAM: 'kopitiam',
      MATTERMOST_CHANNEL: 'launch',
    });
    const tools = await source.toolsFor(SAMPLE_WORKSPACE_ID);
    expect(tools.readOnly).toBe(true);
    expect(tools.mattermost).toMatchObject({ url: 'http://mattermost.test', channel: 'launch' });
  });

  it('reports a wrong key instead of returning garbage', async () => {
    const store = createMemoryWorkspaceToolStore();
    const savedKey = key();
    await store.save({
      ...record('workspace-real', 'token'),
      ...encryptSecret('token', savedKey),
      keyId: keyIdOf(savedKey),
    });
    const source = createWorkspaceToolSource(store, {
      KAKI_SECRET_KEY: key().toString('base64'),
    });
    await expect(source.toolsFor('workspace-real')).rejects.toThrow(/another key; reconnect it/);
  });
});

describe.skipIf(connectionString === undefined)('postgres workspace tool store parity', () => {
  let postgres: PostgresTestSchema | undefined;
  let store: WorkspaceToolStore;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    postgres = await createPostgresTestSchema(connectionString);
    await ensureAuthSchema(postgres.pool);
    store = createPostgresWorkspaceToolStore(postgres.pool);
  });

  afterAll(async () => {
    await postgres?.dispose();
  });

  it('keeps the same save/list/get/delete behaviour as memory', async () => {
    const workspaceId = `workspace-${randomUUID()}`;
    const saved = record(workspaceId, 'secret-token');
    await store.save(saved);

    const listed = await store.list(workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.settings).toEqual(saved.settings);
    expect(listed[0]?.connectedBy).toBe('user-1');
    expect(listed[0]?.lastOkAt).toEqual(new Date('2026-11-02T00:00:00Z'));
    expect((await store.get(workspaceId, 'mattermost'))?.keyId).toBe(saved.keyId);

    await store.delete(workspaceId, 'mattermost');
    expect(await store.get(workspaceId, 'mattermost')).toBeUndefined();
  });

  it('deletes the tool row and its workspace knowledge chunks together', async () => {
    const workspaceId = `workspace-${randomUUID()}`;
    const client = postgres?.pool;
    if (client === undefined) throw new Error('Postgres test pool is missing');
    await client.query(`
      create table if not exists knowledge_chunks (
        source text not null,
        ref text not null,
        workspace_id text not null,
        text text not null
      )
    `);
    await store.save(record(workspaceId, 'secret-token'));
    await client.query(
      `insert into knowledge_chunks (source, ref, workspace_id, text) values
         ('mattermost', '1', $1, 'gone'),
         ('mattermost', '2', $2, 'kept')`,
      [workspaceId, `other-${workspaceId}`],
    );

    await store.delete(workspaceId, 'mattermost');

    const remaining = await client.query<{ workspace_id: string }>(
      'select workspace_id from knowledge_chunks order by workspace_id',
    );
    expect(remaining.rows.map((row) => row.workspace_id)).toEqual([`other-${workspaceId}`]);
  });
});
