import nodemailer from 'nodemailer';
import { Client } from 'pg';
import { loadEnv } from './seed/env';
import { jsonRequest } from './seed/http';
import { loadScenarioSeed } from './seed/scenario';

interface GiteaIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
}

interface MattermostUser {
  id: string;
  username: string;
}

interface MattermostTeam {
  id: string;
  name: string;
}

interface MattermostChannel {
  id: string;
  name: string;
}

interface MattermostPost {
  id: string;
  message: string;
  root_id?: string;
}

interface MattermostPosts {
  order: string[];
  posts: Record<string, MattermostPost>;
}

interface MailSummary {
  ID: string;
  Subject: string;
}

interface MailMessage {
  ID: string;
  Subject: string;
  Text: string;
}

const env = loadEnv();
const seed = loadScenarioSeed(process.env.SCENARIO ?? env.SCENARIO);

const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as Promise<T>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function gitea<T>(path: string): Promise<T> {
  return jsonRequest<T>(
    `${env.GITEA_URL}/api/v1${path}`,
    { headers: { Authorization: `token ${env.GITEA_TOKEN}` } },
    `Gitea ${path}`,
  );
}

function mattermost<T>(path: string): Promise<T> {
  return jsonRequest<T>(
    `${env.MATTERMOST_URL}/api/v4${path}`,
    { headers: { Authorization: `Bearer ${env.MATTERMOST_TOKEN}` } },
    `Mattermost ${path}`,
  );
}

async function wikiGraphQl<T>(query: string, variables: Record<string, unknown>, jwt?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const result = await jsonRequest<{ data?: T; errors?: Array<{ message: string }> }>(
    `${env.WIKI_URL}/graphql`,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) },
    'Wiki.js GraphQL',
  );
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  assert(result.data, 'Wiki.js returned no data');
  return result.data;
}

async function wikiPages(): Promise<Map<string, string>> {
  const login = await wikiGraphQl<{
    authentication: { login: { jwt?: string; responseResult: { succeeded: boolean; message?: string } } };
  }>(
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
  const jwt = login.authentication.login.jwt;
  assert(login.authentication.login.responseResult.succeeded && jwt, `Wiki.js login failed: ${login.authentication.login.responseResult.message ?? 'no jwt'}`);

  const pages = new Map<string, string>();
  for (const page of seed.pages) {
    const result = await wikiGraphQl<{ pages: { singleByPath: { content: string } | null } }>(
      `query Page($path: String!, $locale: String!) {
        pages { singleByPath(path: $path, locale: $locale) { content } }
      }`,
      { path: page.path, locale: 'en' },
      jwt,
    );
    const content = result.pages.singleByPath?.content;
    if (content) pages.set(page.path, content);
  }
  return pages;
}

async function giteaIssues(): Promise<GiteaIssue[]> {
  return gitea<GiteaIssue[]>(`/repos/${env.GITEA_ORG}/${env.GITEA_REPO}/issues?state=all&type=issues&limit=50`);
}

async function mailMessages(): Promise<MailMessage[]> {
  const list = await jsonRequest<{ messages: MailSummary[] }>(
    `${env.MAILPIT_URL}/api/v1/messages`,
    {},
    'Mailpit messages',
  );
  return Promise.all(
    list.messages.map((message) =>
      jsonRequest<MailMessage>(
        `${env.MAILPIT_URL}/api/v1/message/${encodeURIComponent(message.ID)}`,
        {},
        'Mailpit message',
      ),
    ),
  );
}

async function mattermostPosts(): Promise<MattermostPost[]> {
  const team = await mattermost<MattermostTeam>(`/teams/name/${encodeURIComponent(env.MATTERMOST_TEAM)}`);
  const channel = await mattermost<MattermostChannel>(
    `/teams/${team.id}/channels/name/playtest-feedback`,
  );
  const posts = await mattermost<MattermostPosts>(`/channels/${channel.id}/posts?per_page=200&page=0`);
  return Object.values(posts.posts);
}

async function postgresData() {
  const client = new Client({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const extension = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    const stats = await client.query<{ level: number; quit_rate: string }>(
      'SELECT level, quit_rate FROM playtest_quit_stats ORDER BY level',
    );
    const chunks = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM knowledge_chunks');
    const embedding = await client.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'",
    );
    const chunkColumns = await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'knowledge_chunks'",
    );
    const seedDates = await client.query<{ table_name: string; count: number }>(
      `SELECT 'playtest_quit_stats' AS table_name, count(*) FILTER (WHERE updated_on IS NOT NULL)::int AS count FROM playtest_quit_stats
       UNION ALL
       SELECT 'launch_budget', count(*) FILTER (WHERE updated_on IS NOT NULL)::int FROM launch_budget`,
    );
    const wishlists = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM wishlist_counts');
    const budget = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM launch_budget');
    return {
      extensions: extension.rows.map((row) => row.extname),
      stats: stats.rows.map((row) => ({ level: row.level, quitRate: Number(row.quit_rate) })),
      chunkCount: chunks.rows[0]?.count ?? -1,
      embeddingType: embedding.rows[0]?.udt_name ?? 'missing',
      chunkColumns: chunkColumns.rows,
      seedDates: seedDates.rows,
      wishlistRows: wishlists.rows[0]?.count ?? -1,
      budgetRows: budget.rows[0]?.count ?? -1,
    };
  } finally {
    await client.end();
  }
}

const checks: Array<{ name: string; run: () => Promise<string> }> = [];
function check(name: string, run: () => Promise<string>): void {
  checks.push({ name, run });
}

check('Gitea API answers with the seed token', async () => {
  const user = await gitea<{ login: string }>('/user');
  return `logged in as ${user.login}`;
});

check('Gitea has the closed save-file corruption bug', async () => {
  const issues = await once('gitea-issues', giteaIssues);
  const bug = issues.find((issue) => /save-file corruption/i.test(issue.title));
  assert(bug, 'save-file corruption issue is missing');
  assert(bug.state === 'closed', `save-file corruption issue is ${bug.state}`);
  return `issue #${bug.number}, ${issues.length} issues in total`;
});

check('Mattermost API answers with the PAT', async () => {
  const user = await mattermost<MattermostUser>('/users/me');
  return `logged in as ${user.username}`;
});

check('Mailpit API lists the seeded emails', async () => {
  const messages = await once('mail', mailMessages);
  assert(messages.length === seed.emails.length, `expected ${seed.emails.length} emails, found ${messages.length}`);
  return `${messages.length} emails`;
});

check('Mailpit SMTP accepts a connection', async () => {
  const transport = nodemailer.createTransport({
    host: env.MAILPIT_SMTP_HOST,
    port: Number(env.MAILPIT_SMTP_PORT),
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 10_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
  return `${env.MAILPIT_SMTP_HOST}:${env.MAILPIT_SMTP_PORT}`;
});

check('Postgres has the vector extension', async () => {
  const data = await once('postgres', postgresData);
  assert(data.extensions.includes('vector'), 'vector extension is missing');
  return 'SELECT extname ... returned vector';
});

check('Postgres has the knowledge_chunks table with a vector(1024) column and published_at', async () => {
  const data = await once('postgres', postgresData);
  assert(data.embeddingType === 'vector', `embedding column is ${data.embeddingType}`);
  const publishedAt = data.chunkColumns.find((column) => column.column_name === 'published_at');
  assert(publishedAt, 'published_at column is missing');
  assert(publishedAt.is_nullable === 'NO', 'published_at must be NOT NULL');
  return `vector column and published_at present, ${data.chunkCount} rows`;
});

check('Postgres seed rows carry reliable dates', async () => {
  const data = await once('postgres', postgresData);
  const stats = data.seedDates.find((row) => row.table_name === 'playtest_quit_stats');
  const budget = data.seedDates.find((row) => row.table_name === 'launch_budget');
  assert(stats && stats.count === 10, `playtest_quit_stats has ${stats?.count ?? 0} dated rows`);
  assert(budget && budget.count === 5, `launch_budget has ${budget?.count ?? 0} dated rows`);
  return '10 quit rows, 5 budget rows dated';
});

check('Postgres shows the level 5 quit spike', async () => {
  const data = await once('postgres', postgresData);
  const level5 = data.stats.find((row) => row.level === 5);
  assert(level5, 'level 5 row is missing');
  const otherMax = Math.max(...data.stats.filter((row) => row.level !== 5).map((row) => row.quitRate));
  assert(level5.quitRate > 50 && level5.quitRate > otherMax, `level 5 quit rate ${level5.quitRate}% is not the spike`);
  return `level 5 ${level5.quitRate}%, next highest ${otherMax}%`;
});

check('Postgres has wishlist and budget data', async () => {
  const data = await once('postgres', postgresData);
  assert(data.wishlistRows >= 3, `wishlist_counts has ${data.wishlistRows} rows`);
  assert(data.budgetRows >= 4, `launch_budget has ${data.budgetRows} rows`);
  return `${data.wishlistRows} wishlist rows, ${data.budgetRows} budget rows`;
});

check('Wiki contract says the final build is due on 20 November 2026', async () => {
  const pages = await once('wiki', wikiPages);
  const contract = pages.get('hawker-heroes/publisher-contract');
  assert(contract, 'publisher contract page is missing');
  assert(/20 November 2026/.test(contract), 'the contract page does not show 20 November 2026');
  return 'wiki page shows the 20th';
});

check('Wiki contract has the late-delivery penalty clause', async () => {
  const pages = await once('wiki', wikiPages);
  const contract = pages.get('hawker-heroes/publisher-contract');
  assert(contract, 'publisher contract page is missing');
  assert(/5% of the\s+milestone payment/.test(contract), 'the 5% penalty clause is missing');
  return 'clause 4.2 present';
});

check('Wiki booth rules still say 3m x 3m', async () => {
  const pages = await once('wiki', wikiPages);
  const booth = pages.get('hawker-heroes/booth-rules');
  assert(booth, 'booth rules page is missing');
  assert(/3m x 3m/.test(booth), 'the stale 3m x 3m booth size is missing');
  return 'stale wiki size present';
});

check('Starfruit email says the final build is due on 17 November 2026', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /final build date moved up/i.test(message.Subject));
  assert(email, 'Starfruit build date email is missing');
  assert(/17 November 2026/.test(email.Text), 'the Starfruit email does not show 17 November 2026');
  return 'email shows the 17th';
});

check('Indie Arcade email says the booth is 3m x 2m', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /booth allocation/i.test(message.Subject));
  assert(email, 'booth allocation email is missing');
  assert(/3m x 2m/.test(email.Text), 'the organiser email does not show 3m x 2m');
  return 'organiser email shows the smaller booth';
});

check('Mattermost has the undecided level 5 thread', async () => {
  const posts = await once('mattermost-posts', mattermostPosts);
  const root = posts.find((post) => !post.root_id && /level 5/i.test(post.message));
  assert(root, 'level 5 root post is missing');
  const replies = posts.filter((post) => post.root_id === root.id);
  assert(replies.length >= 2, `level 5 thread has only ${replies.length} replies`);
  const text = replies.map((post) => post.message).join('\n');
  assert(/that's the point/i.test(text), "the thread is missing Mei's \"that's the point\" reply");
  assert(/park it/i.test(text) || /no decision/i.test(text), 'the thread does not look undecided');
  return `${replies.length} replies, no decision`;
});

async function main(): Promise<void> {
  let failures = 0;
  for (const entry of checks) {
    try {
      const detail = await entry.run();
      console.log(`PASS ${entry.name}${detail ? ` (${detail})` : ''}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${checks.length} checks failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${checks.length} checks passed.`);
}

main().catch((error: unknown) => {
  console.error(`Verify crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
