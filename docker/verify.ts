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
    const pricing = await client.query<{
      old_kopi_price_sgd: string;
      new_kopi_price_sgd: string;
      cost_per_cup_sgd: string;
      regulars_most_mornings: number;
    }>('SELECT old_kopi_price_sgd, new_kopi_price_sgd, cost_per_cup_sgd, regulars_most_mornings FROM regulars_pricing ORDER BY effective_on DESC LIMIT 1');
    const counts = await client.query<{ table_name: string; count: number }>(
      `SELECT 'regulars_pricing' AS table_name, count(*)::int AS count FROM regulars_pricing
       UNION ALL SELECT 'floor_morning_counts', count(*)::int FROM floor_morning_counts
       UNION ALL SELECT 'food_safety_incident', count(*)::int FROM food_safety_incident
       UNION ALL SELECT 'delivery_commission_tiers', count(*)::int FROM delivery_commission_tiers
       UNION ALL SELECT 'launch_budget', count(*)::int FROM launch_budget`,
    );
    return {
      extensions: extension.rows.map((row) => row.extname),
      chunkCount: chunks.rows[0]?.count ?? -1,
      embeddingType: embedding.rows[0]?.udt_name ?? 'missing',
      chunkColumns: chunkColumns.rows,
      pricing: pricing.rows[0],
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
  for (const table of ['regulars_pricing', 'floor_morning_counts', 'food_safety_incident', 'delivery_commission_tiers', 'launch_budget']) {
    assert((data.tableCounts[table] ?? 0) > 0, `${table} has no rows`);
  }
  return `${Object.values(data.tableCounts).reduce((sum, count) => sum + count, 0)} rows`;
});

check('Postgres shows the old and new kopi prices and the cost per cup', async () => {
  const data = await once('postgres', postgresData);
  assert(data.pricing, 'regulars pricing row is missing');
  assert(Number(data.pricing.old_kopi_price_sgd) === 1.3, `old kopi price is ${data.pricing.old_kopi_price_sgd}`);
  assert(Number(data.pricing.new_kopi_price_sgd) === 2.4, `new kopi price is ${data.pricing.new_kopi_price_sgd}`);
  assert(Number(data.pricing.cost_per_cup_sgd) === 1.6, `cost per cup is ${data.pricing.cost_per_cup_sgd}`);
  return `${data.pricing.regulars_most_mornings} regulars, $1.30 to $2.40`;
});

check('Wiki staffing page carries the counter cover and rest-day rule', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/staffing-plan');
  assert(page, 'staffing page is missing');
  assert(/two counter staff/i.test(page) && /double pay/i.test(page), 'the counter cover or rest-day rule is missing');
  assert(/Auntie Mary/.test(page) && /15 minutes/.test(page), 'Auntie Mary or the till login is missing');
  return 'staffing page present';
});

check('Wiki seating page carries the seat crunch and laptop facts', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/seating-house-rules');
  assert(page, 'seating page is missing');
  assert(/28 seats/.test(page) && /16 of the 28/.test(page) && /420/.test(page), 'the seat crunch numbers are missing');
  assert(/10 window-bar stools/.test(page) && /45 minutes/.test(page), 'the stools or Wi-Fi code is missing');
  return 'seating page present';
});

check('Wiki delivery page carries the 32% commission, margins and tray stock', async () => {
  const pages = await once('wiki', wikiPages);
  const page = pages.get('kopitiam/delivery-pricing');
  assert(page, 'delivery page is missing');
  assert(/32%/.test(page) && /0\.50/.test(page) && /2,400|2400/.test(page), 'the delivery commission numbers are missing');
  assert(/\$5 profit/.test(page) && /30 trays/.test(page), 'the platter margin or tray stock is missing');
  assert(/10%/.test(page), 'the 10% price rule is missing');
  return 'delivery page present';
});

check('Food-agency email carries the 9:00 AM inspection and the logs', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /Food Hygiene Inspection/i.test(message.Subject));
  assert(email, 'inspection email is missing');
  assert(/9:00 AM/.test(email.Text) && /disposal log/i.test(email.Text), 'the inspection time or disposal log is missing');
  return 'inspection email present';
});

check('GrabFood email carries the 32% commission and launch banner terms', async () => {
  const messages = await once('mail', mailMessages);
  const email = messages.find((message) => /featured banner/i.test(message.Subject));
  assert(email, 'GrabFood launch email is missing');
  assert(/32%/.test(email.Text) && /10%/.test(email.Text), 'the commission or price rule is missing');
  return 'GrabFood launch email present';
});

check('Mattermost has the undecided opening-morning thread', async () => {
  const posts = await once('mattermost-posts', mattermostPosts);
  const root = posts.find((post) => !post.root_id && /counter staff texted at 6:45/i.test(post.message));
  assert(root, 'opening-morning root post is missing');
  const replies = posts.filter((post) => post.root_id === root.id);
  assert(replies.length >= 1, `opening-morning thread has only ${replies.length} replies`);
  const text = replies.map((post) => post.message).join('\n');
  assert(/free kopi|200/i.test(text), 'the opening-morning thread does not carry the flyer fact');
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
