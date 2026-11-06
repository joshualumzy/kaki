import { execFileSync } from 'node:child_process';
import type { Env } from './env';
import { COMPOSE_FILE } from './env';
import { basicAuth, jsonBody, jsonRequest, request, waitFor } from './http';
import type { GiteaIssueSeed, GiteaSeed } from './scenario';

const TOKEN_NAME = 'kaki-seed';

interface GiteaToken {
  id: number;
  name: string;
  sha1?: string;
  token?: string;
}

interface GiteaLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
}

interface GiteaIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: GiteaLabel[];
}

function tokenAuth(token: string): string {
  return `token ${token}`;
}

function headers(auth: string, json = false): Record<string, string> {
  return {
    Authorization: auth,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function api<T>(env: Env, path: string, auth: string, init: RequestInit = {}): Promise<T> {
  return jsonRequest<T>(`${env.GITEA_URL}/api/v1${path}`, { ...init, headers: headers(auth, init.body !== undefined) }, `Gitea ${path}`);
}

async function checkAdmin(env: Env, auth: string): Promise<number> {
  const response = await request(`${env.GITEA_URL}/api/v1/user`, { headers: headers(auth) }, 'Gitea admin check');
  return response.status;
}

function createUser(env: Env, username: string, email: string, admin = false): void {
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        '--user',
        'git',
        'gitea',
        'gitea',
        'admin',
        'user',
        'create',
        '--username',
        username,
        '--password',
        env.GITEA_ADMIN_PASSWORD,
        '--email',
        email,
        ...(admin ? ['--admin'] : []),
        '--must-change-password=false',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    if (/already exists|email is already used/i.test(stderr)) return;
    throw new Error(`Could not create Gitea user "${username}": ${stderr || (error instanceof Error ? error.message : String(error))}`, {
      cause: error,
    });
  }
}

function createAdmin(env: Env): void {
  console.log('  creating the Gitea admin user');
  createUser(env, env.GITEA_ADMIN_USER, env.GITEA_ADMIN_EMAIL, true);
}

function ensureTeamUsers(env: Env): void {
  for (const [username, email] of [
    ['arjun', 'arjun@team.example'],
    ['mei', 'mei@team.example'],
    ['daniel', 'daniel@team.example'],
    ['sam', 'sam@team.example'],
  ] as const) {
    createUser(env, username, email, true);
  }
}

async function ensureAdmin(env: Env): Promise<string> {
  await waitFor('Gitea', async () => {
    const response = await request(`${env.GITEA_URL}/api/healthz`, {}, 'Gitea health');
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
  });

  const auth = basicAuth(env.GITEA_ADMIN_USER, env.GITEA_ADMIN_PASSWORD);
  let status = await checkAdmin(env, auth);
  if (status === 401) {
    createAdmin(env);
    status = await checkAdmin(env, auth);
  }
  if (status !== 200) {
    throw new Error(`Gitea admin "${env.GITEA_ADMIN_USER}" is not usable (HTTP ${status})`);
  }
  return auth;
}

async function ensureToken(env: Env, basic: string): Promise<string> {
  if (env.GITEA_TOKEN) {
    const response = await request(
      `${env.GITEA_URL}/api/v1/user`,
      { headers: headers(tokenAuth(env.GITEA_TOKEN)) },
      'Gitea token check',
    );
    if (response.ok) return env.GITEA_TOKEN;
  }

  const tokens = await api<GiteaToken[]>(env, `/users/${env.GITEA_ADMIN_USER}/tokens`, basic);
  for (const token of tokens.filter((entry) => entry.name === TOKEN_NAME)) {
    const response = await request(
      `${env.GITEA_URL}/api/v1/users/${env.GITEA_ADMIN_USER}/tokens/${encodeURIComponent(token.name)}`,
      { method: 'DELETE', headers: headers(basic) },
      'Gitea token delete',
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not delete the old Gitea seed token (HTTP ${response.status})`);
    }
  }

  const created = await api<GiteaToken>(
    env,
    `/users/${env.GITEA_ADMIN_USER}/tokens`,
    basic,
    jsonBody('POST', { name: TOKEN_NAME, scopes: ['all'] }),
  );
  const token = created.sha1 || created.token;
  if (!token) throw new Error('Gitea did not return a token');
  return token;
}

async function ensureOrg(env: Env, token: string): Promise<void> {
  const auth = tokenAuth(token);
  const existing = await request(`${env.GITEA_URL}/api/v1/orgs/${env.GITEA_ORG}`, { headers: headers(auth) }, 'Gitea org');
  if (existing.ok) return;
  if (existing.status !== 404) throw new Error(`Could not read Gitea org "${env.GITEA_ORG}" (HTTP ${existing.status})`);
  console.log(`  creating the Gitea org ${env.GITEA_ORG}`);
  await api(
    env,
    '/orgs',
    auth,
    jsonBody('POST', {
      username: env.GITEA_ORG,
      full_name: 'Lah Studios',
      visibility: 'public',
    }),
  );
}

async function ensureRepo(env: Env, token: string, seed: GiteaSeed): Promise<string> {
  const repo = seed.repository.name;
  const auth = tokenAuth(token);
  const path = `/repos/${env.GITEA_ORG}/${repo}`;
  const existing = await request(`${env.GITEA_URL}/api/v1${path}`, { headers: headers(auth) }, 'Gitea repo');
  if (existing.ok) return repo;
  if (existing.status !== 404) throw new Error(`Could not read Gitea repo "${env.GITEA_ORG}/${repo}" (HTTP ${existing.status})`);

  console.log(`  creating the Gitea repo ${env.GITEA_ORG}/${repo}`);
  await api(
    env,
    `/orgs/${env.GITEA_ORG}/repos`,
    auth,
    jsonBody('POST', {
      name: repo,
      description: seed.repository.description,
      private: seed.repository.private,
      auto_init: true,
      default_branch: 'main',
    }),
  );
  return repo;
}

async function ensureLabels(env: Env, token: string, repo: string, seed: GiteaSeed): Promise<Map<string, number>> {
  const auth = tokenAuth(token);
  const labels = await api<GiteaLabel[]>(env, `/repos/${env.GITEA_ORG}/${repo}/labels?limit=50`, auth);
  const byName = new Map(labels.map((label) => [label.name, label]));

  for (const label of seed.labels) {
    const existing = byName.get(label.name);
    if (!existing) {
      const created = await api<GiteaLabel>(
        env,
        `/repos/${env.GITEA_ORG}/${repo}/labels`,
        auth,
        jsonBody('POST', { name: label.name, color: label.color, description: label.description ?? '' }),
      );
      byName.set(created.name, created);
    } else if (existing.color !== label.color || (existing.description ?? '') !== (label.description ?? '')) {
      const updated = await api<GiteaLabel>(
        env,
        `/repos/${env.GITEA_ORG}/${repo}/labels/${existing.id}`,
        auth,
        jsonBody('PATCH', { color: label.color, description: label.description ?? '' }),
      );
      byName.set(updated.name, updated);
    }
  }

  return new Map([...byName.entries()].map(([name, label]) => [name, label.id]));
}

function issueBody(issue: GiteaIssueSeed): string {
  return `${issue.body.trimEnd()}\n\nOpened: ${issue.date}`;
}

function labelIds(names: string[], labels: Map<string, number>, issue: GiteaIssueSeed): number[] {
  return names.map((name) => {
    const id = labels.get(name);
    if (id === undefined) throw new Error(`Issue "${issue.title}" references unknown label "${name}"`);
    return id;
  });
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}

async function ensureIssues(env: Env, token: string, repo: string, seed: GiteaSeed, labels: Map<string, number>): Promise<void> {
  const auth = tokenAuth(token);
  const base = `/repos/${env.GITEA_ORG}/${repo}`;
  const existing = await api<GiteaIssue[]>(env, `${base}/issues?state=all&type=issues&limit=50`, auth);
  const byTitle = new Map(existing.map((issue) => [issue.title, issue]));

  for (const issue of seed.issues) {
    const ids = labelIds(issue.labels, labels, issue);
    const current = byTitle.get(issue.title);

    if (!current) {
      const created = await api<GiteaIssue>(
        env,
        `${base}/issues`,
        auth,
        jsonBody('POST', { title: issue.title, body: issueBody(issue), labels: ids }),
      );
      if (issue.state === 'closed') {
        await api(env, `${base}/issues/${created.number}`, auth, jsonBody('PATCH', { state: 'closed' }));
      }
      console.log(`  created issue #${created.number}: ${issue.title}`);
      continue;
    }

    const currentIds = current.labels.map((label) => label.id);
    const body = issueBody(issue);
    const needsUpdate =
      current.state !== issue.state ||
      current.body.trim() !== body.trim() ||
      !sameIds(currentIds, ids);
    if (!needsUpdate) continue;

    await api(
      env,
      `${base}/issues/${current.number}`,
      auth,
      jsonBody('PATCH', { title: issue.title, body, labels: ids, state: issue.state }),
    );
    console.log(`  updated issue #${current.number}: ${issue.title}`);
  }
}

export async function seedGitea(env: Env, seed: GiteaSeed): Promise<{ repo: string; token: string }> {
  const basic = await ensureAdmin(env);
  ensureTeamUsers(env);
  const token = await ensureToken(env, basic);
  await ensureOrg(env, token);
  const repo = await ensureRepo(env, token, seed);
  const labels = await ensureLabels(env, token, repo, seed);
  await ensureIssues(env, token, repo, seed, labels);
  return { repo, token };
}
