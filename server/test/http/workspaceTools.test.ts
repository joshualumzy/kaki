import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { decryptSecret, parseSecretKey, SECRET_KEY_MISSING_MESSAGE } from '../../src/workspace/secrets';
import { createMemoryWorkspaceToolStore, type WorkspaceToolStore } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const apps: KakiApp[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

function newKey(): string {
  return randomBytes(32).toString('base64');
}

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

async function signIn(store: AuthStore, name: string): Promise<SignedIn> {
  const email = `${randomUUID()}@example.com`;
  const user = await store.createGoogleUser({ googleSub: randomUUID(), name, email });
  const token = randomUUID();
  await store.createSession({
    tokenHash: hashToken(token),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: name,
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { user, cookie: `kaki_session=${token}` };
}

async function buildApp(
  store: AuthStore,
  workspaceTools: WorkspaceToolStore,
): Promise<{ base: string; workspaceTools: WorkspaceToolStore }> {
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({ store, meetingCode });
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings: createMemoryMeetingStore(),
    workspaceTools,
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, workspaceTools };
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function mattermostServer(): Promise<{ url: string; auth: string[] }> {
  const auth: string[] = [];
  const server = createServer((req, res) => {
    auth.push(String(req.headers.authorization ?? ''));
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v4/users/me') {
      res.end(JSON.stringify({ username: 'kaki-bot' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v4/teams/name/kopitiam') {
      res.end(JSON.stringify({ id: 'team-1' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v4/users/me/teams/team-1/channels') {
      res.end(JSON.stringify([{ name: 'launch' }, { name: 'ops' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return { url: await listen(server), auth };
}

async function giteaServer(): Promise<{ url: string }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v1/user') {
      res.end(JSON.stringify({ login: 'kaki-bot' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/user/repos?limit=50') {
      res.end(JSON.stringify([{ full_name: 'kopitiam/pos' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return { url: await listen(server) };
}

async function createTeam(base: string, cookie: string): Promise<string> {
  const response = await request(base, '/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Kitchen' },
  });
  const workspace = (await response.json()) as { id: string };
  return workspace.id;
}

describe('workspace tools API', () => {
  it('lists five disconnected tools, tests, saves without returning the secret, and deletes', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const workspaceTools = createMemoryWorkspaceToolStore();
    const { base } = await buildApp(store, workspaceTools);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const mattermost = await mattermostServer();

    const initial = await request(base, `/api/workspaces/${workspaceId}/tools`, { cookie: ada.cookie });
    expect(initial.status).toBe(200);
    const statuses = (await initial.json()) as Array<{ kind: string; connected: boolean; settings: unknown }>;
    expect(statuses.map((status) => status.kind)).toEqual([
      'mattermost',
      'gitea',
      'wiki',
      'email',
      'calendar',
    ]);
    expect(statuses.every((status) => !status.connected)).toBe(true);

    const settings = { url: mattermost.url, team: 'kopitiam', channel: 'launch' };
    const test = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost/test`, {
      method: 'POST',
      cookie: ada.cookie,
      body: { settings, token: 'bot-token' },
    });
    expect(test.status).toBe(200);
    expect(await test.json()).toMatchObject({ ok: true });
    expect(mattermost.auth).toContain('Bearer bot-token');

    const saved = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost`, {
      method: 'PUT',
      cookie: ada.cookie,
      body: { settings, token: 'bot-token' },
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.text();
    expect(savedBody).not.toContain('bot-token');

    const record = await workspaceTools.get(workspaceId, 'mattermost');
    expect(record).toBeDefined();
    const key = parseSecretKey(process.env.KAKI_SECRET_KEY);
    expect(decryptSecret(record!, key)).toBe('bot-token');

    const listed = await request(base, `/api/workspaces/${workspaceId}/tools`, { cookie: ada.cookie });
    const listedBody = await listed.text();
    expect(listedBody).not.toContain('bot-token');
    expect(JSON.parse(listedBody)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mattermost',
          connected: true,
          settings,
        }),
      ]),
    );

    const deleted = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(deleted.status).toBe(200);
    expect(await workspaceTools.get(workspaceId, 'mattermost')).toBeUndefined();
  });

  it('reports a channel that is not in the account as a failed test', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store, createMemoryWorkspaceToolStore());
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const mattermost = await mattermostServer();

    const response = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost/test`, {
      method: 'POST',
      cookie: ada.cookie,
      body: { settings: { url: mattermost.url, team: 'kopitiam', channel: 'missing' }, token: 'bot-token' },
    });
    const body = (await response.json()) as { ok: boolean } & Record<string, unknown>;
    expect(body).toMatchObject({ ok: false });
    expect(body).not.toHaveProperty('token');
  });

  it('tests a Gitea repository exists before saving', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store, createMemoryWorkspaceToolStore());
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const gitea = await giteaServer();

    const missing = await request(base, `/api/workspaces/${workspaceId}/tools/gitea/test`, {
      method: 'POST',
      cookie: ada.cookie,
      body: { settings: { url: gitea.url, owner: 'kopitiam', repo: 'absent' }, token: 'bot-token' },
    });
    expect(await missing.json()).toMatchObject({ ok: false });

    const found = await request(base, `/api/workspaces/${workspaceId}/tools/gitea/test`, {
      method: 'POST',
      cookie: ada.cookie,
      body: { settings: { url: gitea.url, owner: 'kopitiam', repo: 'pos' }, token: 'bot-token' },
    });
    expect(await found.json()).toMatchObject({ ok: true });
  });

  it('never writes the saved token to a log', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store, createMemoryWorkspaceToolStore());
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const mattermost = await mattermostServer();
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((value) => String(value)).join(' '));
      }),
    );
    try {
      await request(base, `/api/workspaces/${workspaceId}/tools/mattermost`, {
        method: 'PUT',
        cookie: ada.cookie,
        body: {
          settings: { url: mattermost.url, team: 'kopitiam', channel: 'launch' },
          token: 'bot-token',
        },
      });
      await request(base, `/api/workspaces/${workspaceId}/tools`, { cookie: ada.cookie });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain('bot-token');
  });

  it('refuses the sample workspace, members and non-members', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store, createMemoryWorkspaceToolStore());
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });
    const outsider = await signIn(store, 'Cara');

    const sample = await request(base, `/api/workspaces/${SAMPLE_WORKSPACE_ID}/tools`, {
      cookie: ada.cookie,
    });
    expect(sample.status).toBe(403);
    expect(await sample.json()).toEqual({ error: "The sample workspace's tools are built in" });

    const member = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost/test`, {
      method: 'POST',
      cookie: ben.cookie,
      body: { settings: {}, token: 'token' },
    });
    expect(member.status).toBe(403);

    const stranger = await request(base, `/api/workspaces/${workspaceId}/tools`, {
      cookie: outsider.cookie,
    });
    expect(stranger.status).toBe(404);
  });

  it('answers 503 with the setup message when KAKI_SECRET_KEY is missing', async () => {
    vi.stubEnv('KAKI_SECRET_KEY', '');
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store, createMemoryWorkspaceToolStore());
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const mattermost = await mattermostServer();

    const response = await request(base, `/api/workspaces/${workspaceId}/tools/mattermost`, {
      method: 'PUT',
      cookie: ada.cookie,
      body: {
        settings: { url: mattermost.url, team: 'kopitiam', channel: 'launch' },
        token: 'bot-token',
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: SECRET_KEY_MISSING_MESSAGE });
  });

  it('reports a tool saved under another key without leaking it', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const workspaceTools = createMemoryWorkspaceToolStore();
    const { base } = await buildApp(store, workspaceTools);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const mattermost = await mattermostServer();
    const settings = { url: mattermost.url, team: 'kopitiam', channel: 'launch' };

    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/tools/mattermost`, {
          method: 'PUT',
          cookie: ada.cookie,
          body: { settings, token: 'bot-token' },
        })
      ).status,
    ).toBe(200);

    vi.stubEnv('KAKI_SECRET_KEY', newKey());
    const listed = await request(base, `/api/workspaces/${workspaceId}/tools`, { cookie: ada.cookie });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as Array<{ kind: string; error?: string }>;
    expect(body.find((entry) => entry.kind === 'mattermost')?.error).toBe(
      'this tool was saved with another key; reconnect it',
    );
    expect(JSON.stringify(body)).not.toContain('bot-token');
  });
});
