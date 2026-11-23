import type { Pool, PoolClient } from 'pg';
import type { CalendarSettings } from '../action/calendar';
import type { EmailSettings } from '../action/email';
import type { GiteaSettings } from '../action/gitea';
import type { MattermostSettings } from '../action/mattermost';
import {
  calendarFromEnv,
  emailFromEnv,
  giteaFromEnv,
  mattermostFromEnv,
  wikiFromEnv,
} from '../action/tools';
import type { WikiSettings } from '../action/wiki';
import { SAMPLE_WORKSPACE_ID } from './constants';
import { decryptSecret, encryptSecret, parseSecretKey } from './secrets';

/** The five tool kinds a workspace can connect. */
export const WORKSPACE_TOOL_KINDS = ['mattermost', 'gitea', 'wiki', 'email', 'calendar'] as const;
export type WorkspaceToolKind = (typeof WORKSPACE_TOOL_KINDS)[number];

/** True when the value names a workspace tool kind. */
export function isWorkspaceToolKind(value: string): value is WorkspaceToolKind {
  return (WORKSPACE_TOOL_KINDS as readonly string[]).includes(value);
}

/** The tools one workspace may use; credentials are included only for Action, never for an API reply. */
export interface WorkspaceTools {
  mattermost?: MattermostSettings;
  gitea?: GiteaSettings;
  wiki?: WikiSettings;
  email?: EmailSettings;
  calendar?: CalendarSettings;
  readOnly: boolean;
}

/** What the Action and Wingman modules ask for: the tools of one workspace. */
export interface WorkspaceToolSource {
  toolsFor(workspaceId: string): Promise<WorkspaceTools>;
}

/** One saved tool row, with the secret still encrypted. */
export interface WorkspaceToolRecord {
  workspaceId: string;
  kind: WorkspaceToolKind;
  /** Non-secret settings: url, team, channel, repo, from address, calendar url. */
  settings: Record<string, unknown>;
  secret: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
  connectedBy: string;
  connectedAt: Date;
  lastOkAt: Date | null;
}

/** Everything the workspace tool API and the tool source need from persistence. */
export interface WorkspaceToolStore {
  list(workspaceId: string): Promise<WorkspaceToolRecord[]>;
  get(workspaceId: string, kind: WorkspaceToolKind): Promise<WorkspaceToolRecord | undefined>;
  save(record: WorkspaceToolRecord): Promise<void>;
  /**
   * Delete one tool row and, in the same transaction, its workspace knowledge chunks.
   * The memory store only has the row.
   */
  delete(workspaceId: string, kind: WorkspaceToolKind): Promise<void>;
  /** Delete every saved tool row of these deleted workspaces; run inside `client` when given. */
  deleteWorkspaces?(workspaceIds: readonly string[], client?: PoolClient): Promise<void>;
}

/** The knowledge source a tool kind indexes under. */
export function knowledgeSourceFor(kind: WorkspaceToolKind): string {
  return kind === 'email' ? 'mail' : kind;
}

/**
 * Delete the knowledge chunks a disconnected tool contributed to one workspace.
 * The column is ensured here too, inside the caller's transaction, so a disconnect works on a
 * database the indexer has not migrated yet. With no chunks table there is nothing to delete.
 */
export async function deleteKnowledgeFor(
  client: Pool | PoolClient,
  workspaceId: string,
  source: string,
): Promise<void> {
  const table = await client.query(
    `select 1
       from information_schema.tables
      where table_schema = current_schema()
        and table_name = 'knowledge_chunks'
      limit 1`,
  );
  if (table.rowCount === null || table.rowCount === 0) return;
  await client.query(
    `alter table knowledge_chunks
       add column if not exists workspace_id text not null default '${SAMPLE_WORKSPACE_ID}'`,
  );
  await client.query('delete from knowledge_chunks where workspace_id = $1 and source = $2', [
    workspaceId,
    source,
  ]);
}

function stringSetting(settings: Record<string, unknown>, name: string): string {
  const value = settings[name];
  return typeof value === 'string' ? value : '';
}

function viewBaseUrl(settings: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  const stored = stringSetting(settings, 'viewBaseUrl');
  if (stored !== '') return stored;
  return env.KAKI_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.PORT ?? '3001'}`;
}

/** Build the typed Action settings from a row and its decrypted token. */
export function settingsForRecord(
  record: WorkspaceToolRecord,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): MattermostSettings | GiteaSettings | WikiSettings | EmailSettings | CalendarSettings {
  switch (record.kind) {
    case 'mattermost':
      return {
        url: stringSetting(record.settings, 'url'),
        token,
        team: stringSetting(record.settings, 'team'),
        channel: stringSetting(record.settings, 'channel'),
      };
    case 'gitea':
      return {
        url: stringSetting(record.settings, 'url'),
        token,
        owner: stringSetting(record.settings, 'owner'),
        repo: stringSetting(record.settings, 'repo'),
      };
    case 'wiki':
      return {
        url: stringSetting(record.settings, 'url'),
        email: stringSetting(record.settings, 'email'),
        password: token,
      };
    case 'email':
      return {
        smtpHost: stringSetting(record.settings, 'smtpHost'),
        smtpPort: Number(record.settings.smtpPort),
        from: stringSetting(record.settings, 'from'),
        mailpitUrl: stringSetting(record.settings, 'mailpitUrl'),
      };
    case 'calendar':
      return {
        caldavUrl: stringSetting(record.settings, 'caldavUrl'),
        viewBaseUrl: viewBaseUrl(record.settings, env),
        ...(stringSetting(record.settings, 'user') === ''
          ? {}
          : { user: stringSetting(record.settings, 'user') }),
        ...(stringSetting(record.settings, 'calendar') === ''
          ? {}
          : { calendar: stringSetting(record.settings, 'calendar') }),
      };
  }
}

/** Real workspaces read and decrypt their rows; the sample workspace reads today's environment. */
export function createWorkspaceToolSource(
  store: WorkspaceToolStore,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceToolSource {
  return {
    async toolsFor(workspaceId) {
      if (workspaceId === SAMPLE_WORKSPACE_ID) {
        return {
          mattermost: mattermostFromEnv(env),
          gitea: giteaFromEnv(env),
          wiki: wikiFromEnv(env),
          email: emailFromEnv(env),
          calendar: calendarFromEnv(env),
          readOnly: true,
        };
      }

      const rows = await store.list(workspaceId);
      const tools: WorkspaceTools = { readOnly: false };
      if (rows.length === 0) return tools;
      const key = parseSecretKey(env.KAKI_SECRET_KEY);
      for (const record of rows) {
        const token = decryptSecret(record, key);
        const settings = settingsForRecord(record, token, env);
        switch (record.kind) {
          case 'mattermost':
            tools.mattermost = settings as MattermostSettings;
            break;
          case 'gitea':
            tools.gitea = settings as GiteaSettings;
            break;
          case 'wiki':
            tools.wiki = settings as WikiSettings;
            break;
          case 'email':
            tools.email = settings as EmailSettings;
            break;
          case 'calendar':
            tools.calendar = settings as CalendarSettings;
            break;
        }
      }
      return tools;
    },
  };
}

function cloneRecord(record: WorkspaceToolRecord): WorkspaceToolRecord {
  return {
    ...record,
    settings: { ...record.settings },
    secret: Buffer.from(record.secret),
    iv: Buffer.from(record.iv),
    tag: Buffer.from(record.tag),
    connectedAt: new Date(record.connectedAt),
    lastOkAt: record.lastOkAt === null ? null : new Date(record.lastOkAt),
  };
}

/** An in-memory tool store for tests and for running without Postgres. */
export function createMemoryWorkspaceToolStore(): WorkspaceToolStore {
  const rows = new Map<string, WorkspaceToolRecord>();
  const keyOf = (workspaceId: string, kind: WorkspaceToolKind): string => `${workspaceId}\u0000${kind}`;
  return {
    async list(workspaceId) {
      return [...rows.values()]
        .filter((record) => record.workspaceId === workspaceId)
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map(cloneRecord);
    },
    async get(workspaceId, kind) {
      const record = rows.get(keyOf(workspaceId, kind));
      return record === undefined ? undefined : cloneRecord(record);
    },
    async save(record) {
      rows.set(keyOf(record.workspaceId, record.kind), cloneRecord(record));
    },
    async delete(workspaceId, kind) {
      rows.delete(keyOf(workspaceId, kind));
    },
    async deleteWorkspaces(workspaceIds, _client) {
      const wanted = new Set(workspaceIds);
      for (const [key, record] of rows) {
        if (wanted.has(record.workspaceId)) rows.delete(key);
      }
    },
  };
}

interface WorkspaceToolRow {
  workspace_id: string;
  kind: string;
  settings: Record<string, unknown>;
  secret: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_id: string;
  connected_by: string;
  connected_at: Date | string;
  last_ok_at: Date | string | null;
}

function toToolRecord(row: WorkspaceToolRow): WorkspaceToolRecord {
  return {
    workspaceId: row.workspace_id,
    kind: row.kind as WorkspaceToolKind,
    settings: row.settings,
    secret: row.secret,
    iv: row.iv,
    tag: row.tag,
    keyId: row.key_id,
    connectedBy: row.connected_by,
    connectedAt: new Date(row.connected_at),
    lastOkAt: row.last_ok_at === null ? null : new Date(row.last_ok_at),
  };
}

const TOOL_COLUMNS =
  'workspace_id, kind, settings, secret, iv, tag, key_id, connected_by, connected_at, last_ok_at';

/** The Postgres-backed tool store used by the running server. */
export function createPostgresWorkspaceToolStore(pool: Pool): WorkspaceToolStore {
  return {
    async list(workspaceId) {
      const result = await pool.query<WorkspaceToolRow>(
        `select ${TOOL_COLUMNS} from workspace_tools where workspace_id = $1 order by kind asc`,
        [workspaceId],
      );
      return result.rows.map(toToolRecord);
    },
    async get(workspaceId, kind) {
      const result = await pool.query<WorkspaceToolRow>(
        `select ${TOOL_COLUMNS} from workspace_tools where workspace_id = $1 and kind = $2`,
        [workspaceId, kind],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toToolRecord(row);
    },
    async save(record) {
      await pool.query(
        `insert into workspace_tools
           (workspace_id, kind, settings, secret, iv, tag, key_id, connected_by, connected_at, last_ok_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (workspace_id, kind) do update set
           settings = excluded.settings,
           secret = excluded.secret,
           iv = excluded.iv,
           tag = excluded.tag,
           key_id = excluded.key_id,
           connected_by = excluded.connected_by,
           connected_at = excluded.connected_at,
           last_ok_at = excluded.last_ok_at`,
        [
          record.workspaceId,
          record.kind,
          record.settings,
          record.secret,
          record.iv,
          record.tag,
          record.keyId,
          record.connectedBy,
          record.connectedAt,
          record.lastOkAt,
        ],
      );
    },
    async delete(workspaceId, kind) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from workspace_tools where workspace_id = $1 and kind = $2', [
          workspaceId,
          kind,
        ]);
        await deleteKnowledgeFor(client, workspaceId, knowledgeSourceFor(kind));
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteWorkspaces(workspaceIds, client) {
      if (workspaceIds.length === 0) return;
      await (client ?? pool).query('delete from workspace_tools where workspace_id = any($1::text[])', [
        [...workspaceIds],
      ]);
    },
  };
}

/** Encrypt a submitted token for storage under the current server key. */
export function encryptToolToken(token: string, env: NodeJS.ProcessEnv = process.env) {
  return encryptSecret(token, parseSecretKey(env.KAKI_SECRET_KEY));
}
