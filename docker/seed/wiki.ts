import { execFileSync } from 'node:child_process';
import type { Env } from './env';
import { COMPOSE_FILE } from './env';
import { jsonBody, jsonRequest, request, sleep, waitFor } from './http';
import type { WikiPageSeed } from './scenario';

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LoginData {
  authentication: {
    login: {
      jwt?: string;
      responseResult: { succeeded: boolean; message?: string };
    };
  };
}

interface PageLookupData {
  pages: {
    singleByPath: {
      id: number;
      title: string;
      description: string;
      content: string;
    } | null;
  };
}

interface PageListData {
  pages: {
    list: Array<{
      id: number;
      path: string;
      title: string;
    }>;
  };
}

interface PageDeleteData {
  pages: {
    delete?: { responseResult: { succeeded: boolean; message?: string } };
  };
}

interface PageWriteData {
  pages: {
    create?: { responseResult: { succeeded: boolean; message?: string } };
    update?: { responseResult: { succeeded: boolean; message?: string } };
  };
}

async function graphql<T>(
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

async function login(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await graphql<LoginData>(
        env,
        `mutation Login($username: String!, $password: String!, $strategy: String!) {
          authentication {
            login(username: $username, password: $password, strategy: $strategy) {
              jwt
              responseResult { succeeded message }
            }
          }
        }`,
        {
          username: env.WIKI_ADMIN_EMAIL,
          password: env.WIKI_ADMIN_PASSWORD,
          strategy: 'local',
        },
      );
      const result = data.authentication.login;
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

async function ensurePage(env: Env, jwt: string, page: WikiPageSeed): Promise<'created' | 'updated' | 'unchanged'> {
  let existing: PageLookupData['pages']['singleByPath'] = null;
  try {
    const current = await graphql<PageLookupData>(
      env,
      `query Page($path: String!, $locale: String!) {
        pages {
          singleByPath(path: $path, locale: $locale) { id title description content }
        }
      }`,
      { path: page.path, locale: 'en' },
      jwt,
    );
    existing = current.pages.singleByPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/This page does not exist/i.test(message)) throw error;
  }

  if (!existing) {
    const data = await graphql<PageWriteData>(
      env,
      `mutation Create($content: String!, $description: String!, $path: String!, $title: String!) {
        pages {
          create(
            content: $content
            description: $description
            editor: "markdown"
            isPublished: true
            isPrivate: false
            locale: "en"
            path: $path
            tags: []
            title: $title
          ) {
            responseResult { succeeded message }
          }
        }
      }`,
      {
        content: page.content,
        description: page.description,
        path: page.path,
        title: page.title,
      },
      jwt,
    );
    const result = data.pages.create?.responseResult;
    if (!result?.succeeded) throw new Error(`Wiki.js could not create page "${page.path}": ${result?.message ?? 'unknown error'}`);
    return 'created';
  }

  if (
    existing.title === page.title &&
    existing.description === page.description &&
    existing.content.trim() === page.content.trim()
  ) {
    return 'unchanged';
  }

  const data = await graphql<PageWriteData>(
    env,
    `mutation Update($id: Int!, $content: String!, $description: String!, $title: String!) {
      pages {
        update(id: $id, content: $content, description: $description, isPublished: true, tags: [], title: $title) {
          responseResult { succeeded message }
        }
      }
    }`,
    {
      id: existing.id,
      content: page.content,
      description: page.description,
      title: page.title,
    },
    jwt,
  );
  const result = data.pages.update?.responseResult;
  if (!result?.succeeded) throw new Error(`Wiki.js could not update page "${page.path}": ${result?.message ?? 'unknown error'}`);
  return 'updated';
}

function graphqlProbe(env: Env): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  };
}

function syncWikiDemoAdmin(env: Env): void {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'wiki',
        'node',
        '-e',
        `const sqlite3 = require("sqlite3"); const bcrypt = require("bcryptjs"); const db = new sqlite3.Database("/wiki/data/wiki.db"); const hash = bcrypt.hashSync(${JSON.stringify(env.WIKI_ADMIN_PASSWORD)}, 10); db.run("UPDATE users SET email = ?, password = ? WHERE id = 1", [${JSON.stringify(env.WIKI_ADMIN_EMAIL)}, hash]);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    // Best-effort sync.
  }
}

/** Completes Wiki.js setup when needed, then writes the scenario pages and removes stale ones. */
export async function seedWiki(env: Env, pages: WikiPageSeed[]): Promise<void> {
  await waitFor('Wiki.js', async () => {
    const root = await request(`${env.WIKI_URL}/`, {}, 'Wiki.js setup page');
    if (!root.ok) throw new Error(`Wiki.js is not answering (root ${root.status})`);
  });

  const probe = await request(`${env.WIKI_URL}/graphql`, graphqlProbe(env), 'Wiki.js GraphQL probe');
  if (probe.status === 404) {
    console.log('  completing the Wiki.js setup wizard');
    const setup = await jsonRequest<{ ok: boolean; error?: string }>(
      `${env.WIKI_URL}/finalize`,
      jsonBody('POST', {
        siteUrl: env.WIKI_URL,
        adminEmail: 'admin@nanyangkopitiam.example',
        adminPassword: 'demopassword',
        telemetry: false,
      }),
      'Wiki.js setup',
    );
    if (!setup.ok) throw new Error(`Wiki.js setup failed: ${setup.error ?? 'unknown error'}`);
  } else if (!probe.ok) {
    throw new Error(`Wiki.js GraphQL probe returned HTTP ${probe.status}`);
  }

  await waitFor('Wiki.js after setup', async () => {
    const data = await graphql<{ authentication: { activeStrategies: Array<{ key: string }> } }>(
      env,
      `query { authentication { activeStrategies(enabledOnly: true) { key } } }`,
      {},
    );
    if (!data.authentication.activeStrategies.some((strategy) => strategy.key === 'local')) {
      throw new Error('the local authentication strategy is not ready');
    }
  });

  syncWikiDemoAdmin(env);
  const jwt = await login(env);

  const homePage: WikiPageSeed = {
    path: 'home',
    title: 'Nanyang Kopi & Toast — Team Wiki',
    description: 'Standard Operating Procedures (SOPs), Floor Protocols & Launch Costing for Raffles Place Flagship (#B1-14).',
    content: [
      '# Nanyang Kopi & Toast — Team Wiki',
      '',
      'Welcome to the internal knowledge base for our **Raffles Place Flagship (#B1-14)** launch.',
      '',
      '## Active Operations & Launch SOPs',
      ...pages.map((p) => `- **[${p.title}](/en/${p.path})** — ${p.description}`),
      '',
      '---',
      '*End-of-meeting minutes and action updates published by Kaki appear under `/en/meetings/`.*',
    ].join('\n'),
  };

  const allSeedPages = [homePage, ...pages];
  const validPaths = new Set(allSeedPages.map((p) => p.path));

  try {
    const existingList = await graphql<PageListData>(
      env,
      `query { pages { list { id path title } } }`,
      {},
      jwt,
    );
    for (const item of existingList.pages.list) {
      if (!validPaths.has(item.path)) {
        await graphql<PageDeleteData>(
          env,
          `mutation Delete($id: Int!) { pages { delete(id: $id) { responseResult { succeeded message } } } }`,
          { id: item.id },
          jwt,
        ).catch(() => undefined);
      }
    }
  } catch {
    // Best-effort cleanup of stale pages.
  }

  for (const page of allSeedPages) {
    const result = await ensurePage(env, jwt, page);
    console.log(`  ${result}: ${page.path}`);
  }
}
