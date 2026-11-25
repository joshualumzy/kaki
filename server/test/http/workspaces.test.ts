import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

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

async function buildApp(): Promise<{ base: string; store: AuthStore }> {
  const store = createMemoryAuthStore();
  const auth = createAuth({ store});
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetings: createMemoryMeetingStore(),
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, store };
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

describe('workspaces API', () => {
  it('lists my personal workspace plus the sample workspace', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');

    const response = await request(base, '/api/workspaces', { cookie: ada.cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ id: string; name: string; kind: string; role: string }>;
    expect(body.map((workspace) => workspace.name)).toEqual(['My workspace', 'Nanyang Kopi (sample)']);
    expect(body.find((workspace) => workspace.kind === 'personal')).toMatchObject({ role: 'admin' });
    expect(body.find((workspace) => workspace.id === SAMPLE_WORKSPACE_ID)).toMatchObject({
      kind: 'sample',
      role: 'member',
    });
  });

  it('refuses deleting a personal workspace or the sample workspace', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const list = (await (await request(base, '/api/workspaces', { cookie: ada.cookie })).json()) as Array<{
      id: string;
      kind: string;
    }>;
    const personal = list.find((workspace) => workspace.kind === 'personal');
    expect(personal).toBeDefined();

    const personalDelete = await request(base, `/api/workspaces/${personal?.id ?? ''}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'My workspace' },
    });
    expect(personalDelete.status).toBe(403);
    expect(await personalDelete.json()).toMatchObject({
      error: 'A personal workspace is deleted together with your account.',
    });

    const sampleDelete = await request(base, `/api/workspaces/${SAMPLE_WORKSPACE_ID}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'Nanyang Kopi (sample)' },
    });
    expect(sampleDelete.status).toBe(403);
  });

  it('creates a team workspace with the caller as admin', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');

    const created = await request(base, '/api/workspaces', {
      method: 'POST',
      cookie: ada.cookie,
      body: { name: '  Kitchen team  ' },
    });
    expect(created.status).toBe(200);
    const workspace = (await created.json()) as { id: string; name: string; kind: string; role: string };
    expect(workspace).toMatchObject({ name: 'Kitchen team', kind: 'team', role: 'admin' });
    expect(await store.getMembership({ workspaceId: workspace.id, userId: ada.user.id })).toBe('admin');

    const listed = (await (await request(base, '/api/workspaces', { cookie: ada.cookie })).json()) as Array<{
      id: string;
    }>;
    expect(listed.map((entry) => entry.id)).toContain(workspace.id);
  });

  it('answers 404 for a non-member and shows the sample as read-only', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = (await (
      await request(base, '/api/workspaces', { method: 'POST', cookie: ada.cookie, body: { name: 'Team' } })
    ).json()) as { id: string };

    expect((await request(base, `/api/workspaces/${team.id}`, { cookie: ben.cookie })).status).toBe(404);

    const sample = await request(base, `/api/workspaces/${SAMPLE_WORKSPACE_ID}`, { cookie: ben.cookie });
    expect(sample.status).toBe(200);
    expect(await sample.json()).toMatchObject({
      name: 'Nanyang Kopi (sample)',
      readOnly: true,
      people: [],
      tools: [],
      meetings: [],
      counts: { meetings: 0, todos: 0, records: 0 },
    });
  });

  it('refuses a sample rename, refuses a member, and lets an admin rename', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = (await (
      await request(base, '/api/workspaces', { method: 'POST', cookie: ada.cookie, body: { name: 'Team' } })
    ).json()) as { id: string };
    await store.addWorkspaceMember({ workspaceId: team.id, userId: ben.user.id, role: 'member' });

    expect(
      (await request(base, `/api/workspaces/${SAMPLE_WORKSPACE_ID}`, {
        method: 'PATCH',
        cookie: ada.cookie,
        body: { name: 'Nope' },
      })).status,
    ).toBe(403);

    expect(
      (await request(base, `/api/workspaces/${team.id}`, {
        method: 'PATCH',
        cookie: ben.cookie,
        body: { name: 'Ben team' },
      })).status,
    ).toBe(403);

    const renamed = await request(base, `/api/workspaces/${team.id}`, {
      method: 'PATCH',
      cookie: ada.cookie,
      body: { name: 'Ada team' },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: team.id, name: 'Ada team', role: 'admin' });

    const detail = (await (
      await request(base, `/api/workspaces/${team.id}`, { cookie: ben.cookie })
    ).json()) as { name: string; people: Array<{ name: string; role: string }> };
    expect(detail.name).toBe('Ada team');
    expect(detail.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Ada', role: 'admin' }),
        expect.objectContaining({ name: 'Ben', role: 'member' }),
      ]),
    );
  });
});
