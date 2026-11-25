import { Client, type Pool, type PoolClient } from 'pg';
import { loadEnv, type Env } from '../../../../docker/seed/env';
import { jsonRequest, request, sleep } from '../../../../docker/seed/http';
import { loadScenarioSeed } from '../../../../docker/seed/scenario';
import type { EmailSettings } from '../../action/email';
import type { GiteaSettings } from '../../action/gitea';
import type { MattermostSettings } from '../../action/mattermost';
import type { WikiSettings } from '../../action/wiki';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import {
  createMemoryWorkspaceToolStore,
  createWorkspaceToolSource,
  knowledgeSourceFor,
  type WorkspaceToolKind,
  type WorkspaceTools,
} from '../../workspace/tools';
import { isoDay, parseLongDay, shortDay } from './dates';
import { embedText, embedTexts, gatewayConfigFromEnv, missingGatewayEnv, type GatewayConfig } from './gateway';

/** Every stored kind of searchable record; `meeting` holds an ended meeting's minutes and to-dos. */
export type KnowledgeSource = 'wiki' | 'gitea' | 'mattermost' | 'mail' | 'postgres' | 'meeting';

/** One row of the searchable company knowledge. */
interface KnowledgeChunk {
  source: KnowledgeSource;
  ref: string;
  text: string;
  publishedAt: string;
  /** The channel, repository, page path or table the record came from, when the tool has one. */
  location?: string;
}

/** Anything that can run a query: a pool, a client or a transaction client. */
export type Queryable = Pool | Client | PoolClient;

interface IndexSummary {
  chunks: number;
  sources: Record<string, number>;
}

interface WikiPageInput {
  path: string;
  title: string;
  content: string;
  /** The page's own update time from the tool; the seed instead writes it into the content. */
  updatedAt?: string | Date;
}

interface GiteaIssueInput {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string;
  /** The issue's own update time from the tool; the seed instead writes "Opened:" into the body. */
  date?: string;
}

interface MattermostPostInput {
  id: string;
  root_id?: string;
  user_id: string;
  message: string;
  props?: Record<string, string>;
  create_at: number;
  type?: string;
}

interface MailMessageInput {
  messageId: string;
  subject: string;
  from: string;
  fromAddress: string;
  date: string;
  text: string;
}

/** One row from any seeded Postgres company table. */
interface PostgresRow {
  [column: string]: unknown;
}

interface WikiSection {
  heading: string;
  body: string;
}

/** Read the "Last updated:" or "Last reviewed:" line every wiki page must carry. */
export function parseWikiUpdatedAt(content: string, label = 'wiki page'): string {
  const match = /Last (?:updated|reviewed):\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(content);
  if (!match) {
    throw new Error(`${label}: missing a "Last updated:" or "Last reviewed: <d Month yyyy>" line`);
  }
  return parseLongDay(match[1] as string, match[2] as string, match[3] as string);
}

/** Read the "Opened: YYYY-MM-DD" last line every seeded Gitea issue body must carry. */
export function parseIssueOpenedAt(body: string, label = 'gitea issue'): string {
  const match = /(?:^|\n)Opened:\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(body.trimEnd());
  if (!match) {
    throw new Error(`${label}: body is missing the final "Opened: YYYY-MM-DD" line`);
  }
  return isoDay(match[1] as string);
}

/** Read the seed date Mattermost stores on each post as props.sent_at. */
export function parseMattermostSentAt(
  props: Record<string, string> | undefined,
  label = 'mattermost post',
): string {
  const sentAt = props?.sent_at;
  if (typeof sentAt !== 'string' || sentAt.trim() === '') {
    throw new Error(`${label}: missing the props.sent_at seed date`);
  }
  return isoDay(sentAt);
}

/** Read a mail Date header. */
export function parseMailDate(value: string, label = 'email'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}: invalid Date header "${value}"`);
  return isoDay(date);
}

function splitWikiSections(content: string): WikiSection[] {
  const sections: WikiSection[] = [];
  let heading = 'Overview';
  let lines: string[] = [];

  function flush(): void {
    const body = lines.join('\n').trim();
    if (body !== '') sections.push({ heading, body });
  }

  for (const line of content.split(/\r?\n/)) {
    const section = /^##\s+(.+?)\s*$/.exec(line);
    if (section) {
      flush();
      heading = section[1] as string;
      lines = [];
    } else if (/^#\s+/.test(line) && lines.every((entry) => entry.trim() === '')) {
      continue;
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The seed date written into a Mattermost post; real posts use their create_at instead. */
function seedMattermostDate(post: MattermostPostInput): string {
  return parseMattermostSentAt(post.props, `Mattermost post ${post.id}`);
}

/** Make one chunk per wiki page section, with the page date in every header. */
export function wikiChunks(page: WikiPageInput): KnowledgeChunk[] {
  const updatedAt =
    page.updatedAt === undefined
      ? parseWikiUpdatedAt(page.content, `Wiki page "${page.path}"`)
      : isoDay(page.updatedAt);
  const header = `[Wiki: ${page.title}, updated ${shortDay(updatedAt)}]`;
  return splitWikiSections(page.content).map((section, index) => ({
    source: 'wiki',
    ref: `${page.path}#${index + 1}-${slug(section.heading)}`,
    text: `${header}\n\n${section.heading}\n\n${section.body}`,
    publishedAt: updatedAt,
    location: page.path,
  }));
}

/** Make one chunk per Gitea issue. */
export function giteaChunk(issue: GiteaIssueInput, repo: string, openedOverride?: string): KnowledgeChunk {
  const openedAt =
    openedOverride === undefined
      ? parseIssueOpenedAt(issue.body, `Gitea issue #${issue.number}`)
      : isoDay(openedOverride);
  const labels = issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'Labels: none';
  return {
    source: 'gitea',
    ref: `#${issue.number}`,
    text: `[Gitea: ${repo} #${issue.number} "${issue.title}", opened ${shortDay(openedAt)}]\n\n${issue.title}\nState: ${issue.state}\n${labels}\n\n${issue.body}`,
    publishedAt: openedAt,
    location: repo,
  };
}

/** Make one chunk per Mattermost thread, grouping a root post and its replies. */
export function mattermostThreadChunk(
  channelName: string,
  root: MattermostPostInput,
  replies: MattermostPostInput[],
  usernames: Map<string, string>,
  dateOf: (post: MattermostPostInput) => string = seedMattermostDate,
): KnowledgeChunk {
  const posts = [root, ...replies].sort((a, b) => {
    const aDate = dateOf(a).localeCompare(dateOf(b));
    return aDate === 0 ? a.create_at - b.create_at : aDate;
  });
  const latest = posts[posts.length - 1] as MattermostPostInput;
  const latestDate = dateOf(latest);
  const lines = posts.map((post) => {
    const sentAt = dateOf(post);
    const author = usernames.get(post.user_id) ?? post.user_id;
    return `[${sentAt}] ${author}: ${post.message}`;
  });
  return {
    source: 'mattermost',
    ref: `#${channelName}/${root.id}`,
    text: `[Mattermost: #${channelName} thread, ${shortDay(latestDate)}]\n\n${lines.join('\n\n')}`,
    publishedAt: latestDate,
    location: `#${channelName}`,
  };
}

/** The organisation-looking label from an address domain, for the chunk header. */
function mailOrganisation(address: string): string {
  const domain = address.split('@')[1]?.split('.')[0] ?? address;
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/** Make one chunk per email. */
export function mailChunk(email: MailMessageInput): KnowledgeChunk {
  const date = parseMailDate(email.date, `Email "${email.subject}"`);
  return {
    source: 'mail',
    ref: email.messageId,
    text: `[Mail from ${mailOrganisation(email.fromAddress)}: ${email.subject}, ${shortDay(date)}]\n\nFrom: ${email.from}\nSubject: ${email.subject}\nDate: ${isoDay(date)}\n\n${email.text}`,
    publishedAt: date,
    location: email.fromAddress,
  };
}

/** Make one chunk for a row from a seeded Postgres company table. */
export function postgresRowChunk(table: string, row: PostgresRow, dateColumn: string): KnowledgeChunk {
  const updatedAt = isoDay(row[dateColumn] as string | Date);
  const id = row.id;
  const fallback = Object.values(row).find((value) => typeof value === 'string') ?? table;
  const ref = `${table}/${id === undefined ? slug(String(fallback)) : String(id)}`;
  const lines = Object.entries(row)
    .filter(([column]) => column !== 'embedding')
    .map(([column, value]) => `${column}: ${String(value)}`);
  return {
    source: 'postgres',
    ref,
    text: `[Postgres: ${table}, updated ${shortDay(updatedAt)}]\n\n${lines.join('\n')}`,
    publishedAt: updatedAt,
    location: table,
  };
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function wikiGraphQl<T>(
  baseUrl: string,
  query: string,
  variables: Record<string, unknown>,
  jwt?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const result = await jsonRequest<GraphQlResponse<T>>(
    `${baseUrl}/graphql`,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) },
    'Wiki.js GraphQL',
  );
  if (result.errors?.length) {
    throw new Error(`Wiki.js GraphQL error: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  if (!result.data) throw new Error('Wiki.js GraphQL returned no data');
  return result.data;
}

async function wikiLogin(settings: WikiSettings): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const login = await wikiGraphQl<{
        authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message?: string } } };
      }>(
        settings.url,
        `mutation Login($username: String!, $password: String!, $strategy: String!) {
          authentication {
            login(username: $username, password: $password, strategy: $strategy) {
              jwt
              responseResult { succeeded message }
            }
          }
        }`,
        { username: settings.email, password: settings.password, strategy: 'local' },
      );
      const result = login.authentication.login;
      if (!result.responseResult.succeeded || !result.jwt) {
        throw new Error(`Wiki.js login failed: ${result.responseResult.message ?? 'no token returned'}`);
      }
      return result.jwt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wait = /Too many requests.*?in (\d+) seconds/i.exec(message);
      if (!wait?.[1] || attempt === 2) throw error;
      await sleep((Number(wait[1]) + 1) * 1_000);
    }
  }
  throw new Error('Wiki.js login failed');
}

/**
 * Read the wiki's pages. A sample index only keeps the pages its scenario seeded; a workspace
 * index reads every page the connected wiki offers.
 */
async function fetchWikiPages(settings: WikiSettings, seededPaths?: Set<string>): Promise<WikiPageInput[]> {
  const jwt = await wikiLogin(settings);

  const list = await wikiGraphQl<{ pages: { list: Array<{ path: string; title: string; updatedAt?: string }> } }>(
    settings.url,
    `query { pages { list { path title updatedAt } } }`,
    {},
    jwt,
  );

  const pages: WikiPageInput[] = [];
  for (const page of list.pages.list) {
    if (seededPaths !== undefined && !seededPaths.has(page.path)) continue;
    const detail = await wikiGraphQl<{ pages: { singleByPath: { content: string } | null } }>(
      settings.url,
      `query Page($path: String!, $locale: String!) {
        pages { singleByPath(path: $path, locale: $locale) { content } }
      }`,
      { path: page.path, locale: 'en' },
      jwt,
    );
    const content = detail.pages.singleByPath?.content;
    if (content === undefined) throw new Error(`Wiki.js page "${page.path}" returned no content`);
    pages.push({
      path: page.path,
      title: page.title,
      content,
      // A sample page carries its own "Last updated" line; a real page uses the wiki's timestamp.
      ...(seededPaths === undefined && page.updatedAt !== undefined ? { updatedAt: page.updatedAt } : {}),
    });
  }
  return pages;
}

interface GiteaIssueResponse {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: Array<{ name: string }>;
  created_at?: string;
  updated_at?: string;
}

/** Read the repository's issues; a sample index keeps only the seeded titles. */
async function fetchGiteaIssues(settings: GiteaSettings, seededTitles?: Set<string>): Promise<GiteaIssueInput[]> {
  const issues = await jsonRequest<GiteaIssueResponse[]>(
    `${settings.url}/api/v1/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/issues?state=all&type=issues&limit=100`,
    { headers: { Authorization: `token ${settings.token}` } },
    'Gitea issues',
  );
  return issues
    .filter((issue) => seededTitles === undefined || seededTitles.has(issue.title))
    .map((issue) => {
      const date = issue.updated_at ?? issue.created_at;
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        body: issue.body,
        ...(date === undefined ? {} : { date }),
      };
    });
}

interface MattermostTeam {
  id: string;
  name: string;
}

interface MattermostChannel {
  id: string;
  name: string;
}

interface MattermostMember {
  user_id: string;
}

interface MattermostUser {
  id: string;
  username: string;
}

interface MattermostPostList {
  posts: Record<string, MattermostPostInput>;
}

async function mattermostJson<T>(settings: MattermostSettings, path: string): Promise<T> {
  return jsonRequest<T>(
    `${settings.url}/api/v4${path}`,
    { headers: { Authorization: `Bearer ${settings.token}` } },
    `Mattermost ${path}`,
  );
}

type MattermostThread = {
  channel: string;
  root: MattermostPostInput;
  replies: MattermostPostInput[];
  usernames: Map<string, string>;
};

/**
 * Read Mattermost threads. A sample index reads every seeded channel and requires the seed date;
 * a workspace index reads only the channel its connection posts into and dates posts by create_at.
 */
async function fetchMattermostThreads(
  settings: MattermostSettings,
  seededChannels?: Set<string>,
): Promise<MattermostThread[]> {
  const team = await mattermostJson<MattermostTeam>(
    settings,
    `/teams/name/${encodeURIComponent(settings.team)}`,
  );
  const [channels, members] = await Promise.all([
    mattermostJson<MattermostChannel[]>(settings, `/teams/${team.id}/channels`),
    mattermostJson<MattermostMember[]>(settings, `/teams/${team.id}/members?per_page=200`),
  ]);
  const users = await Promise.all(
    members.map((member) => mattermostJson<MattermostUser>(settings, `/users/${member.user_id}`)),
  );
  const usernames = new Map(users.map((user) => [user.id, user.username]));

  let wanted = channels;
  if (seededChannels !== undefined) {
    wanted = channels.filter((channel) => seededChannels.has(channel.name));
  } else {
    const configured = settings.channel;
    wanted = channels.filter((channel) => channel.name === configured);
    if (wanted.length === 0) {
      throw new Error(`Mattermost has no channel named "${configured}" to index`);
    }
  }

  const threads: MattermostThread[] = [];
  for (const channel of wanted) {
    const list = await mattermostJson<MattermostPostList>(
      settings,
      `/channels/${channel.id}/posts?per_page=200&page=0`,
    );
    const posts = Object.values(list.posts).filter((post) => {
      if (post.type || post.message.trim() === '') return false;
      if (seededChannels === undefined) return true;
      return typeof post.props?.sent_at === 'string' && post.props.sent_at.trim() !== '';
    });
    const replies = new Map<string, MattermostPostInput[]>();
    const roots: MattermostPostInput[] = [];
    for (const post of posts) {
      if (post.root_id) {
        const existing = replies.get(post.root_id) ?? [];
        existing.push(post);
        replies.set(post.root_id, existing);
      } else {
        roots.push(post);
      }
    }
    for (const root of roots) {
      threads.push({ channel: channel.name, root, replies: replies.get(root.id) ?? [], usernames });
    }
  }
  return threads;
}

interface MailSummary {
  ID: string;
  MessageID: string;
  Subject: string;
  From: { Name: string; Address: string };
}

interface MailMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  From: { Name: string; Address: string };
  Date: string;
  Text: string;
}

async function fetchEmails(settings: EmailSettings): Promise<MailMessageInput[]> {
  const list = await jsonRequest<{ messages: MailSummary[] }>(
    `${settings.mailpitUrl}/api/v1/messages`,
    {},
    'Mailpit messages',
  );
  const messages = await Promise.all(
    list.messages.map((summary) =>
      jsonRequest<MailMessage>(
        `${settings.mailpitUrl}/api/v1/message/${encodeURIComponent(summary.ID)}`,
        {},
        'Mailpit message',
      ),
    ),
  );
  return messages.map((message) => ({
    messageId: message.MessageID,
    subject: message.Subject,
    from: message.From.Name ? `${message.From.Name} <${message.From.Address}>` : message.From.Address,
    fromAddress: message.From.Address,
    date: message.Date,
    text: message.Text,
  }));
}

/** Read the seeded company tables; only the sample workspace's records live in this database. */
async function fetchPostgresChunks(postgresUrl: string): Promise<KnowledgeChunk[]> {
  const client = new Client({ connectionString: postgresUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'knowledge_chunks' ORDER BY table_name",
    );
    const chunks: KnowledgeChunk[] = [];
    for (const { table_name: table } of tables.rows) {
      const columns = await client.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['public', table],
      );
      const names = columns.rows.map((column) => column.column_name);
      const dateColumn = ['updated_on', 'captured_on', 'trial_date', 'published_at', 'date'].find((column) =>
        names.includes(column),
      );
      if (dateColumn === undefined) {
        console.warn(`kaki indexer: skipping Postgres table "${table}" because it has no company date column`);
        continue;
      }
      const rows = await client.query<PostgresRow>(`SELECT * FROM ${quoteIdentifier(table)}`);
      for (const row of rows.rows) chunks.push(postgresRowChunk(table, row, dateColumn));
    }
    return chunks;
  } finally {
    await client.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Bring an existing chunks table up to the workspace-scoped shape: a workspace on every row, an
 * optional location, the full-text column, and a unique key that includes the workspace so two
 * workspaces may use the same source and ref without colliding.
 */
export async function ensureKnowledgeSchema(db: Queryable): Promise<void> {
  await db.query(
    `ALTER TABLE knowledge_chunks
       ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT '${SAMPLE_WORKSPACE_ID}'`,
  );
  await db.query('ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS location text');
  // The seeded table had UNIQUE (source, ref); that would stop a second workspace indexing its own
  // copy of the same record. Replace it with the workspace-scoped key and index.
  await db.query('ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_source_ref_key');
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_workspace_source_ref_uidx
       ON knowledge_chunks (workspace_id, source, ref)`,
  );
  await db.query(
    'CREATE INDEX IF NOT EXISTS knowledge_chunks_workspace_source_idx ON knowledge_chunks (workspace_id, source)',
  );
  await db.query(
    `ALTER TABLE knowledge_chunks
       ADD COLUMN IF NOT EXISTS text_tsv tsvector
       GENERATED ALWAYS AS (to_tsvector('english', text)) STORED`,
  );
  await db.query(
    'CREATE INDEX IF NOT EXISTS knowledge_chunks_text_tsv_idx ON knowledge_chunks USING GIN (text_tsv)',
  );
}

/**
 * Delete the knowledge chunks of deleted workspaces. Runs on the caller's connection so it joins
 * the account-deletion transaction. The table may not exist yet on a database the indexer has
 * never migrated, so a missing table simply has nothing to delete. Both the existence check and
 * the delete name the current schema, so a stray search_path can never reach another schema's table.
 */
export async function deleteWorkspaceKnowledge(input: {
  db: Queryable;
  workspaceIds: readonly string[];
}): Promise<void> {
  if (input.workspaceIds.length === 0) return;
  const schema = await input.db.query<{ name: string | null }>('select current_schema() as name');
  const schemaName = schema.rows[0]?.name;
  if (schemaName === null || schemaName === undefined) {
    throw new Error('cannot delete workspace knowledge: the connection has no current schema');
  }
  const table = `${quoteIdentifier(schemaName)}.${quoteIdentifier('knowledge_chunks')}`;
  const found = await input.db.query<{ name: string | null }>('select to_regclass($1) as name', [
    table,
  ]);
  if (found.rows[0]?.name === null || found.rows[0]?.name === undefined) return;
  await input.db.query(`delete from ${table} where workspace_id = any($1::text[])`, [
    [...input.workspaceIds],
  ]);
}

/** Delete one workspace's source chunks whose refs are no longer present. */
export async function pruneWorkspaceSource(
  db: Queryable,
  workspaceId: string,
  source: KnowledgeSource,
  refs: string[],
): Promise<void> {
  await db.query(
    'DELETE FROM knowledge_chunks WHERE workspace_id = $1 AND source = $2 AND NOT (ref = ANY($3::text[]))',
    [workspaceId, source, refs],
  );
}

/**
 * Upsert chunks for one workspace and drop the stale refs of every source present in this batch.
 * The upsert and the delete both name the workspace, so one workspace's reindex can never touch
 * another's rows.
 */
async function writeWorkspaceChunksIn(
  db: Queryable,
  workspaceId: string,
  chunks: KnowledgeChunk[],
  embeddings: number[][],
  options: { prune?: boolean },
): Promise<void> {
  // An indexer that wakes after a workspace deletion must not recreate its private chunks. The
  // workspace row is locked in share mode: it either waits out an in-flight deletion and finds the
  // row gone, or writes first and the deletion removes the chunks with everything else.
  if (workspaceId !== SAMPLE_WORKSPACE_ID) {
    const table = await db.query<{ name: string | null }>('select to_regclass($1) as name', [
      'workspaces',
    ]);
    if (table.rows[0]?.name !== null && table.rows[0]?.name !== undefined) {
      const workspace = await db.query('select id from workspaces where id = $1 for key share', [
        workspaceId,
      ]);
      if ((workspace.rowCount ?? 0) === 0) {
        throw new Error(`workspace ${workspaceId} no longer exists`);
      }
    }
  }
  await ensureKnowledgeSchema(db);
  for (const [index, chunk] of chunks.entries()) {
    const embedding = embeddings[index];
    if (embedding === undefined) throw new Error(`No embedding for chunk ${chunk.source}:${chunk.ref}`);
    await db.query(
      `INSERT INTO knowledge_chunks (workspace_id, source, ref, text, published_at, embedding, location)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::vector, $7)
       ON CONFLICT (workspace_id, source, ref) DO UPDATE
         SET text = EXCLUDED.text,
             published_at = EXCLUDED.published_at,
             embedding = EXCLUDED.embedding,
             location = EXCLUDED.location`,
      [
        workspaceId,
        chunk.source,
        chunk.ref,
        chunk.text,
        chunk.publishedAt,
        `[${embedding.join(',')}]`,
        chunk.location ?? null,
      ],
    );
  }

  if (options.prune === false) return;
  const bySource = new Map<KnowledgeSource, string[]>();
  for (const chunk of chunks) {
    const refs = bySource.get(chunk.source) ?? [];
    refs.push(chunk.ref);
    bySource.set(chunk.source, refs);
  }
  for (const [source, refs] of bySource) {
    await pruneWorkspaceSource(db, workspaceId, source, refs);
  }
}

export async function writeWorkspaceChunks(
  db: Queryable,
  workspaceId: string,
  chunks: KnowledgeChunk[],
  embeddings: number[][],
  options: { prune?: boolean } = {},
): Promise<void> {
  // A pool has no transaction of its own, so give this write one: the shared gate and the
  // tombstone check then hold until the rows are committed, and a deletion cannot slip between.
  if ('totalCount' in db) {
    const client = await (db as Pool).connect();
    try {
      await client.query('begin');
      await writeWorkspaceChunksIn(client, workspaceId, chunks, embeddings, options);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  await writeWorkspaceChunksIn(db, workspaceId, chunks, embeddings, options);
}

/** Replace one workspace's source chunks in one transaction. */
async function writeSourceChunks(
  postgresUrl: string,
  workspaceId: string,
  source: KnowledgeSource,
  chunks: KnowledgeChunk[],
  embeddings: number[][],
): Promise<void> {
  const client = new Client({ connectionString: postgresUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await writeWorkspaceChunks(client, workspaceId, chunks, embeddings, { prune: false });
    await pruneWorkspaceSource(
      client,
      workspaceId,
      source,
      chunks.map((chunk) => chunk.ref),
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

interface ReadContext {
  tools: WorkspaceTools;
  /** Set only for the sample workspace: read just the scenario's seeded records. */
  scenario?: string;
  postgresUrl?: string;
}

/** Read one source's records for a workspace, or the sample's seeded records. */
async function readSource(source: KnowledgeSource, context: ReadContext): Promise<KnowledgeChunk[]> {
  const scenario = context.scenario;
  switch (source) {
    case 'wiki': {
      const settings = context.tools.wiki;
      if (settings === undefined) throw new Error('The wiki is not connected for this workspace');
      const seededPaths =
        scenario === undefined
          ? undefined
          : new Set(loadScenarioSeed(scenario).pages.map((page) => page.path));
      return (await fetchWikiPages(settings, seededPaths)).flatMap(wikiChunks);
    }
    case 'gitea': {
      const settings = context.tools.gitea;
      if (settings === undefined) throw new Error('Gitea is not connected for this workspace');
      const seededTitles =
        scenario === undefined
          ? undefined
          : new Set(loadScenarioSeed(scenario).gitea.issues.map((issue) => issue.title));
      const issues = await fetchGiteaIssues(settings, seededTitles);
      return issues.map((issue) =>
        giteaChunk(issue, settings.repo, scenario === undefined ? issue.date : undefined),
      );
    }
    case 'mattermost': {
      const settings = context.tools.mattermost;
      if (settings === undefined) throw new Error('Mattermost is not connected for this workspace');
      const seededChannels =
        scenario === undefined
          ? undefined
          : new Set(loadScenarioSeed(scenario).mattermost.channels.map((channel) => channel.name));
      const threads = await fetchMattermostThreads(settings, seededChannels);
      const dateOf =
        scenario === undefined
          ? (post: MattermostPostInput) => isoDay(new Date(post.create_at))
          : undefined;
      return threads.map((thread) =>
        mattermostThreadChunk(thread.channel, thread.root, thread.replies, thread.usernames, dateOf),
      );
    }
    case 'mail': {
      const settings = context.tools.email;
      if (settings === undefined) throw new Error('Email is not connected for this workspace');
      return (await fetchEmails(settings)).map(mailChunk);
    }
    case 'postgres': {
      if (context.postgresUrl === undefined) throw new Error('Postgres company records need POSTGRES_URL');
      return fetchPostgresChunks(context.postgresUrl);
    }
    case 'meeting':
      throw new Error('Meeting records are indexed from the meeting itself, not from a tool');
  }
}

function indexSummary(chunks: KnowledgeChunk[]): IndexSummary {
  const sources: Record<string, number> = {};
  for (const chunk of chunks) sources[chunk.source] = (sources[chunk.source] ?? 0) + 1;
  return { chunks: chunks.length, sources };
}

function requireGateway(gateway: GatewayConfig | undefined, env: NodeJS.ProcessEnv): GatewayConfig {
  if (gateway !== undefined) return gateway;
  const config = gatewayConfigFromEnv(env);
  if (config === undefined) {
    throw new Error(`Indexing needs ${missingGatewayEnv(env).join(' and ')}`);
  }
  return config;
}

export interface IndexWorkspaceSourceOptions {
  workspaceId: string;
  kind: WorkspaceToolKind;
  tools: WorkspaceTools;
  postgresUrl: string;
  gateway?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** Refresh one connected tool's records for one workspace. */
export async function indexWorkspaceSource(options: IndexWorkspaceSourceOptions): Promise<IndexSummary> {
  const log = options.log ?? ((message: string) => console.log(message));
  if (options.kind === 'calendar') {
    log(`  calendar: no searchable records`);
    return { chunks: 0, sources: {} };
  }
  const source = knowledgeSourceFor(options.kind) as KnowledgeSource;
  const env = options.env ?? process.env;
  const gateway = requireGateway(options.gateway, env);
  const chunks = await readSource(source, { tools: options.tools, postgresUrl: options.postgresUrl });
  const embeddings =
    chunks.length === 0 ? [] : await embedTexts(gateway, chunks.map((chunk) => chunk.text));
  await writeSourceChunks(options.postgresUrl, options.workspaceId, source, chunks, embeddings);
  log(`  ${source}: ${chunks.length} chunks for workspace ${options.workspaceId}`);
  return indexSummary(chunks);
}

/** Index the built-in sample workspace exactly as `npm run index:knowledge` always has. */
export async function indexSampleKnowledge(
  options: {
    env?: Env;
    gateway?: GatewayConfig;
    log?: (message: string) => void;
  } = {},
): Promise<IndexSummary> {
  const env = options.env ?? loadEnv();
  const log = options.log ?? ((message: string) => console.log(message));
  // The gateway credentials live in the process environment; `env` only carries the stack's URLs.
  const gateway = requireGateway(options.gateway, process.env);
  // The stack's URLs and tokens win; the rest (e.g. the Mattermost post channel) comes from the process.
  const tools = await createWorkspaceToolSource(createMemoryWorkspaceToolStore(), {
    ...process.env,
    ...env,
  }).toolsFor(SAMPLE_WORKSPACE_ID);

  const sources: KnowledgeSource[] = ['wiki', 'gitea', 'mattermost', 'mail', 'postgres'];
  const totals: Record<string, number> = {};
  let total = 0;
  for (const source of sources) {
    const chunks = await readSource(source, {
      tools,
      scenario: env.SCENARIO,
      postgresUrl: env.POSTGRES_URL,
    });
    log(`  ${source}: ${chunks.length} chunks`);
    const embeddings =
      chunks.length === 0 ? [] : await embedTexts(gateway, chunks.map((chunk) => chunk.text));
    await writeSourceChunks(env.POSTGRES_URL, SAMPLE_WORKSPACE_ID, source, chunks, embeddings);
    if (chunks.length > 0) {
      totals[source] = chunks.length;
      total += chunks.length;
    }
  }
  if (total === 0) throw new Error('Indexing found no company data');
  return { chunks: total, sources: totals };
}

/** Read every fake-company service and replace the sample workspace's chunks with fresh embeddings. */
export async function indexKnowledge(
  options: {
    env?: Env;
    gateway?: GatewayConfig;
    log?: (message: string) => void;
  } = {},
): Promise<IndexSummary> {
  return indexSampleKnowledge(options);
}

/**
 * Index an ended meeting's minutes and to-dos as one `meeting` chunk in its own workspace. The ref
 * is the meeting id, so re-indexing the same meeting replaces its record and never touches another
 * meeting's.
 */
export async function indexMeetingRecord(options: {
  db: Queryable;
  workspaceId: string;
  meetingId: string;
  title: string;
  text: string;
  publishedAt: string;
  gateway?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const gateway = requireGateway(options.gateway, options.env ?? process.env);
  const embedding = await embedText(gateway, options.text);
  await writeWorkspaceChunks(
    options.db,
    options.workspaceId,
    [
      {
        source: 'meeting',
        ref: `meeting:${options.meetingId}`,
        text: options.text,
        publishedAt: options.publishedAt,
        location: options.title,
      },
    ],
    [embedding],
    { prune: false },
  );
}

/** A small health probe so a failed service names itself before indexing starts. */
export async function probeServices(env: Env): Promise<void> {
  const probes: Array<[string, string]> = [
    ['Wiki.js', `${env.WIKI_URL}/`],
    ['Gitea', `${env.GITEA_URL}/api/healthz`],
    ['Mattermost', `${env.MATTERMOST_URL}/api/v4/system/ping`],
    ['Mailpit', `${env.MAILPIT_URL}/api/v1/info`],
  ];
  for (const [name, url] of probes) {
    const response = await request(url, {}, `${name} probe`);
    if (!response.ok) throw new Error(`${name} is not healthy (HTTP ${response.status})`);
  }
}
