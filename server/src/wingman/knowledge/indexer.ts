import { Client } from 'pg';
import { loadEnv, type Env } from '../../../../docker/seed/env';
import { jsonRequest, request, sleep } from '../../../../docker/seed/http';
import { loadScenarioSeed } from '../../../../docker/seed/scenario';
import { isoDay, parseLongDay, shortDay } from './dates';
import { embedTexts, gatewayConfigFromEnv, missingGatewayEnv, type GatewayConfig } from './gateway';

/** One row of the searchable company knowledge. */
export interface KnowledgeChunk {
  source: 'wiki' | 'gitea' | 'mattermost' | 'mail' | 'postgres';
  ref: string;
  text: string;
  publishedAt: string;
}

export interface IndexSummary {
  chunks: number;
  sources: Record<string, number>;
}

export interface WikiPageInput {
  path: string;
  title: string;
  content: string;
}

export interface GiteaIssueInput {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string;
}

export interface MattermostPostInput {
  id: string;
  root_id?: string;
  user_id: string;
  message: string;
  props?: Record<string, string>;
  create_at: number;
  type?: string;
}

export interface MailMessageInput {
  messageId: string;
  subject: string;
  from: string;
  fromAddress: string;
  date: string;
  text: string;
}

/** One row from any seeded Postgres company table. */
export interface PostgresRow {
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

/** Make one chunk per wiki page section, with the page date in every header. */
export function wikiChunks(page: WikiPageInput): KnowledgeChunk[] {
  const updatedAt = parseWikiUpdatedAt(page.content, `Wiki page "${page.path}"`);
  const header = `[Wiki: ${page.title}, updated ${shortDay(updatedAt)}]`;
  return splitWikiSections(page.content).map((section, index) => ({
    source: 'wiki',
    ref: `${page.path}#${index + 1}-${slug(section.heading)}`,
    text: `${header}\n\n${section.heading}\n\n${section.body}`,
    publishedAt: updatedAt,
  }));
}

/** Make one chunk per Gitea issue. */
export function giteaChunk(issue: GiteaIssueInput, repo: string): KnowledgeChunk {
  const openedAt = parseIssueOpenedAt(issue.body, `Gitea issue #${issue.number}`);
  const labels = issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'Labels: none';
  return {
    source: 'gitea',
    ref: `#${issue.number}`,
    text: `[Gitea: ${repo} #${issue.number} "${issue.title}", opened ${shortDay(openedAt)}]\n\n${issue.title}\nState: ${issue.state}\n${labels}\n\n${issue.body}`,
    publishedAt: openedAt,
  };
}

/** Make one chunk per Mattermost thread, grouping a root post and its replies. */
export function mattermostThreadChunk(
  channelName: string,
  root: MattermostPostInput,
  replies: MattermostPostInput[],
  usernames: Map<string, string>,
): KnowledgeChunk {
  const posts = [root, ...replies].sort((a, b) => {
    const aDate = parseMattermostSentAt(a.props, `Mattermost post ${a.id}`).localeCompare(
      parseMattermostSentAt(b.props, `Mattermost post ${b.id}`),
    );
    return aDate === 0 ? a.create_at - b.create_at : aDate;
  });
  const latest = posts[posts.length - 1] as MattermostPostInput;
  const latestDate = parseMattermostSentAt(latest.props, `Mattermost post ${latest.id}`);
  const lines = posts.map((post) => {
    const sentAt = parseMattermostSentAt(post.props, `Mattermost post ${post.id}`);
    const author = usernames.get(post.user_id) ?? post.user_id;
    return `[${sentAt}] ${author}: ${post.message}`;
  });
  return {
    source: 'mattermost',
    ref: `#${channelName}/${root.id}`,
    text: `[Mattermost: #${channelName} thread, ${shortDay(latestDate)}]\n\n${lines.join('\n\n')}`,
    publishedAt: latestDate,
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
  };
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function wikiGraphQl<T>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
  jwt?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const result = await jsonRequest<GraphQlResponse<T>>(
    `${env.WIKI_URL}/graphql`,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) },
    'Wiki.js GraphQL',
  );
  if (result.errors?.length) {
    throw new Error(`Wiki.js GraphQL error: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  if (!result.data) throw new Error('Wiki.js GraphQL returned no data');
  return result.data;
}

async function wikiLogin(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const login = await wikiGraphQl<{
        authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message?: string } } };
      }>(
        env,
        `mutation Login($username: String!, $password: String!, $strategy: String!) {
          authentication {
            login(username: $username, password: $password, strategy: $strategy) {
              jwt
              responseResult { succeeded message }
            }
          }
        }`,
        { username: env.WIKI_ADMIN_EMAIL, password: env.WIKI_ADMIN_PASSWORD, strategy: 'local' },
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

async function fetchWikiPages(env: Env): Promise<WikiPageInput[]> {
  const seededPaths = new Set(loadScenarioSeed(env.SCENARIO).pages.map((page) => page.path));
  const jwt = await wikiLogin(env);

  const list = await wikiGraphQl<{ pages: { list: Array<{ path: string; title: string }> } }>(
    env,
    `query { pages { list { path title } } }`,
    {},
    jwt,
  );

  const pages: WikiPageInput[] = [];
  for (const page of list.pages.list) {
    if (!seededPaths.has(page.path)) continue;
    const detail = await wikiGraphQl<{ pages: { singleByPath: { content: string } | null } }>(
      env,
      `query Page($path: String!, $locale: String!) {
        pages { singleByPath(path: $path, locale: $locale) { content } }
      }`,
      { path: page.path, locale: 'en' },
      jwt,
    );
    const content = detail.pages.singleByPath?.content;
    if (content === undefined) throw new Error(`Wiki.js page "${page.path}" returned no content`);
    pages.push({ path: page.path, title: page.title, content });
  }
  return pages;
}

interface GiteaIssueResponse {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: Array<{ name: string }>;
}

async function fetchGiteaIssues(env: Env): Promise<GiteaIssueInput[]> {
  const seededTitles = new Set(loadScenarioSeed(env.SCENARIO).gitea.issues.map((issue) => issue.title));
  const issues = await jsonRequest<GiteaIssueResponse[]>(
    `${env.GITEA_URL}/api/v1/repos/${env.GITEA_ORG}/${env.GITEA_REPO}/issues?state=all&type=issues&limit=100`,
    { headers: { Authorization: `token ${env.GITEA_TOKEN}` } },
    'Gitea issues',
  );
  return issues
    .filter((issue) => seededTitles.has(issue.title))
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      body: issue.body,
    }));
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

async function mattermostJson<T>(env: Env, path: string): Promise<T> {
  return jsonRequest<T>(
    `${env.MATTERMOST_URL}/api/v4${path}`,
    { headers: { Authorization: `Bearer ${env.MATTERMOST_TOKEN}` } },
    `Mattermost ${path}`,
  );
}

async function fetchMattermostThreads(
  env: Env,
): Promise<Array<{ channel: string; root: MattermostPostInput; replies: MattermostPostInput[]; usernames: Map<string, string> }>> {
  const seededChannels = new Set(
    loadScenarioSeed(env.SCENARIO).mattermost.channels.map((channel) => channel.name),
  );
  const team = await mattermostJson<MattermostTeam>(
    env,
    `/teams/name/${encodeURIComponent(env.MATTERMOST_TEAM)}`,
  );
  const [channels, members] = await Promise.all([
    mattermostJson<MattermostChannel[]>(env, `/teams/${team.id}/channels`),
    mattermostJson<MattermostMember[]>(env, `/teams/${team.id}/members?per_page=200`),
  ]);
  const users = await Promise.all(
    members.map((member) => mattermostJson<MattermostUser>(env, `/users/${member.user_id}`)),
  );
  const usernames = new Map(users.map((user) => [user.id, user.username]));

  const threads: Array<{ channel: string; root: MattermostPostInput; replies: MattermostPostInput[]; usernames: Map<string, string> }> = [];
  for (const channel of channels) {
    if (!seededChannels.has(channel.name)) continue;
    const list = await mattermostJson<MattermostPostList>(
      env,
      `/channels/${channel.id}/posts?per_page=200&page=0`,
    );
    const posts = Object.values(list.posts).filter(
      (post) => !post.type && typeof post.props?.sent_at === 'string' && post.props.sent_at.trim() !== '',
    );
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

async function fetchEmails(env: Env): Promise<MailMessageInput[]> {
  const list = await jsonRequest<{ messages: MailSummary[] }>(
    `${env.MAILPIT_URL}/api/v1/messages`,
    {},
    'Mailpit messages',
  );
  const messages = await Promise.all(
    list.messages.map((summary) =>
      jsonRequest<MailMessage>(
        `${env.MAILPIT_URL}/api/v1/message/${encodeURIComponent(summary.ID)}`,
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

async function fetchPostgresChunks(env: Env): Promise<KnowledgeChunk[]> {
  const client = new Client({ connectionString: env.POSTGRES_URL, connectionTimeoutMillis: 5_000 });
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

/** Add the generated full-text column and its GIN index to an existing chunks table. */
async function ensureHybridSearchSchema(client: Client): Promise<void> {
  await client.query(
    `ALTER TABLE knowledge_chunks
       ADD COLUMN IF NOT EXISTS text_tsv tsvector
       GENERATED ALWAYS AS (to_tsvector('english', text)) STORED`,
  );
  await client.query(
    'CREATE INDEX IF NOT EXISTS knowledge_chunks_text_tsv_idx ON knowledge_chunks USING GIN (text_tsv)',
  );
}

async function writeChunks(env: Env, chunks: KnowledgeChunk[], embeddings: number[][]): Promise<void> {
  const client = new Client({ connectionString: env.POSTGRES_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await ensureHybridSearchSchema(client);
    await client.query('BEGIN');
    for (const [index, chunk] of chunks.entries()) {
      const embedding = embeddings[index];
      if (embedding === undefined) throw new Error(`No embedding for chunk ${chunk.source}:${chunk.ref}`);
      await client.query(
        `INSERT INTO knowledge_chunks (source, ref, text, published_at, embedding)
         VALUES ($1, $2, $3, $4::timestamptz, $5::vector)
         ON CONFLICT (source, ref) DO UPDATE
           SET text = EXCLUDED.text,
               published_at = EXCLUDED.published_at,
               embedding = EXCLUDED.embedding`,
        [chunk.source, chunk.ref, chunk.text, chunk.publishedAt, `[${embedding.join(',')}]`],
      );
    }

    const bySource = new Map<string, string[]>();
    for (const chunk of chunks) {
      const refs = bySource.get(chunk.source) ?? [];
      refs.push(chunk.ref);
      bySource.set(chunk.source, refs);
    }
    for (const [source, refs] of bySource) {
      await client.query(
        'DELETE FROM knowledge_chunks WHERE source = $1 AND NOT (ref = ANY($2::text[]))',
        [source, refs],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Read every fake-company service and replace the knowledge chunks with fresh embeddings. */
export async function indexKnowledge(options: {
  env?: Env;
  gateway?: GatewayConfig;
  log?: (message: string) => void;
} = {}): Promise<IndexSummary> {
  const env = options.env ?? loadEnv();
  const log = options.log ?? ((message: string) => console.log(message));
  const gateway = options.gateway ?? gatewayConfigFromEnv();
  if (gateway === undefined) {
    throw new Error(`Indexing needs ${missingGatewayEnv().join(' and ')}`);
  }

  const wikiPages = await fetchWikiPages(env);
  log(`  wiki: ${wikiPages.length} pages`);
  const issues = await fetchGiteaIssues(env);
  log(`  gitea: ${issues.length} issues`);
  const threads = await fetchMattermostThreads(env);
  log(`  mattermost: ${threads.length} threads`);
  const emails = await fetchEmails(env);
  log(`  mail: ${emails.length} emails`);
  const postgresChunks = await fetchPostgresChunks(env);
  log(`  postgres: ${postgresChunks.length} chunks`);

  const chunks: KnowledgeChunk[] = [
    ...wikiPages.flatMap(wikiChunks),
    ...issues.map((issue) => giteaChunk(issue, env.GITEA_REPO)),
    ...threads.map((thread) => mattermostThreadChunk(thread.channel, thread.root, thread.replies, thread.usernames)),
    ...emails.map(mailChunk),
    ...postgresChunks,
  ];
  if (chunks.length === 0) throw new Error('Indexing found no company data');

  log(`  embedding ${chunks.length} chunks with ${gateway.embedModel}`);
  const embeddings = await embedTexts(
    gateway,
    chunks.map((chunk) => chunk.text),
  );
  await writeChunks(env, chunks, embeddings);

  const sources: Record<string, number> = {};
  for (const chunk of chunks) sources[chunk.source] = (sources[chunk.source] ?? 0) + 1;
  return { chunks: chunks.length, sources };
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
