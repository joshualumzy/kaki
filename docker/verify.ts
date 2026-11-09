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
  const posts: MattermostPost[] = [];
  for (const channelSeed of seed.mattermost.channels) {
    const channel = await mattermost<MattermostChannel>(
      `/teams/${team.id}/channels/name/${encodeURIComponent(channelSeed.name)}`,
    );
    const channelPosts = await mattermost<MattermostPosts>(
      `/channels/${channel.id}/posts?per_page=200&page=0`,
    );
    posts.push(...Object.values(channelPosts.posts));
  }
  return posts;
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
    const chunks = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM knowledge_chunks');
    const embedding = await client.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding'",
    );
    const chunkColumns = await client.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'knowledge_chunks'",
    );
    const kiosk = await client.query<{
      first_time_users: number;
      froze_at_kopi_o_kosong: number;
      missed_language_toggle_pct: string;
    }>('SELECT first_time_users, froze_at_kopi_o_kosong, missed_language_toggle_pct FROM kiosk_trial_stats ORDER BY trial_date DESC LIMIT 1');
    const counts = await client.query<{ table_name: string; count: number }>(
      `SELECT 'kiosk_trial_stats' AS table_name, count(*)::int AS count FROM kiosk_trial_stats
       UNION ALL SELECT 'floor_morning_counts', count(*)::int FROM floor_morning_counts
       UNION ALL SELECT 'sfa_egg_batches', count(*)::int FROM sfa_egg_batches
       UNION ALL SELECT 'delivery_commission_tiers', count(*)::int FROM delivery_commission_tiers
       UNION ALL SELECT 'launch_budget', count(*)::int FROM launch_budget`,
    );
    return {
      extensions: extension.rows.map((row) => row.extname),
      chunkCount: chunks.rows[0]?.count ?? -1,
      embeddingType: embedding.rows[0]?.udt_name ?? 'missing',
      chunkColumns: chunkColumns.rows,
      kiosk: kiosk.rows[0],
      tableCounts: Object.fromEntries(counts.rows.map((row) => [row.table_name, row.count])),
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

check('Gitea has every seeded issue in the right state', async () => {
  const issues = await once('gitea-issues', giteaIssues);
  for (const seeded of seed.gitea.issues) {
    const found = issues.find((issue) => issue.title === seeded.title);
    assert(found, `issue "${seeded.title}" is missing`);
    assert(found.state === seeded.state, `issue "${seeded.title}" is ${found.state}, expected ${seeded.state}`);
  }
  return `${seed.gitea.issues.length} issues in ${issues.length} total`;
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

check('Postgres has the seeded company tables', async () => {
  const data = await once('postgres', postgresData);
  for (const table of ['kiosk_trial_stats', 'floor_morning_counts', 'sfa_egg_batches', 'delivery_commission_tiers', 'launch_budget']) {
    assert((data.tableCounts[table] ?? 0) > 0, `${table} has no rows`);
  }
  return `${Object.values(data.tableCounts).reduce((sum, count) => sum + count, 0)} rows`;
});

check('Postgres shows the kiosk trial freeze and missed toggle', async () => {
  const data = await once('postgres', postgresData);
  assert(data.kiosk, 'kiosk trial row is missing');
  assert(data.kiosk.froze_at_kopi_o_kosong === 19, `kiosk freeze count is ${data.kiosk.froze_at_kopi_o_kosong}`);
  assert(Number(data.kiosk.missed_language_toggle_pct) > 70, `missed toggle rate is ${data.kiosk.missed_language_toggle_pct}`);
  return `${data.kiosk.froze_at_kopi_o_kosong} of ${data.kiosk.first_time_users} froze`;
});

check('Wiki kiosk page carries the trial numbers and docket constraint', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/kiosk-menu-sop');
  assert(page, 'kiosk menu page is missing');
  assert(/(?:19\s+of\s+28|28[^\n]{0,180}\b19\b)/.test(page) && /72%/.test(page), 'the kiosk trial numbers are missing');
  assert(/kitchen (thermal )?docket/i.test(page), 'the kitchen docket constraint is missing');
  return 'kiosk page present';
});

check('Wiki floor page carries the seat crunch and Auntie Mary constraint', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/supplier-contingency');
  assert(page, 'floor page is missing');
  assert(/28 seats/.test(page) && /420/.test(page), 'the seat crunch numbers are missing');
  assert(/Auntie Mary/.test(page), 'Auntie Mary is missing');
  return 'floor page present';
});

check('Wiki delivery and costing page carries the 32% commission and remaining budget', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/mall-promo-rules');
  assert(page, 'delivery & costing page is missing');
  assert(/32%/.test(page) && /2,400|2400/.test(page), 'the delivery commission numbers are missing');
  assert(/750/.test(page), 'the remaining budget is missing');
  return 'delivery & costing page present';
});

check('SFA inspection email carries the 9:00 AM inspection and 63°C holding requirement', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /Food Hygiene Inspection/i.test(message.Subject));
  assert(email, 'SFA inspection email is missing');
  assert(/63°C/.test(email.Text), 'the 63°C requirement is missing');
  return 'SFA email present';
});

check('GrabFood email carries the 32% commission tier notice', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /Commission Tier/i.test(message.Subject));
  assert(email, 'GrabFood commission email is missing');
  assert(/32%/.test(email.Text), 'the 32% commission is missing');
  return 'GrabFood email present';
});

check('Mattermost has the undecided SFA hygiene thread', async () => {
  const posts = await once('mattermost-posts', mattermostPosts);
  const root = posts.find((post) => !post.root_id && /Heads up team: SFA just emailed an inspection notice/i.test(post.message));
  assert(root, 'SFA hygiene root post is missing');
  const replies = posts.filter((post) => post.root_id === root.id);
  assert(replies.length >= 1, `SFA hygiene thread has only ${replies.length} replies`);
  const text = replies.map((post) => post.message).join('\n');
  assert(/hygiene/i.test(text) && /still haven't decided|haven't agreed|not decided/i.test(text), 'the SFA hygiene thread does not look undecided');
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
