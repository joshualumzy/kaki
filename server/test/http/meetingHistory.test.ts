import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
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

async function buildApp(): Promise<{
  base: string;
  store: AuthStore;
  meetings: ReturnType<typeof createMemoryMeetingStore>;
}> {
  const store = createMemoryAuthStore();
  const auth = createAuth({ store});
  const meetings = createMemoryMeetingStore();
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetings,
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, store, meetings };
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function endedMeetingWithMinutes(options: {
  store: AuthStore;
  meetings: ReturnType<typeof createMemoryMeetingStore>;
  owner: SignedIn;
  workspaceId: string;
  todos?: Array<{ id: string; title: string; owner: string; status: string; done: boolean }>;
}): Promise<string> {
  const meeting = await options.meetings.create({
    workspaceId: options.workspaceId,
    ownerUserId: options.owner.user.id,
    title: 'Weekly planning',
  });
  await options.meetings.markEnded?.(meeting.id, '2026-11-20T10:00:00.000Z');
  await options.meetings.saveMinutes?.(meeting.id, {
    minutes: '# Weekly planning\n\nWe agreed the rota.',
    todos: options.todos ?? [
      { id: 'task-1', title: 'Update the rota', owner: 'Chef', status: 'SUGGESTED', done: false },
    ],
  });
  return meeting.id;
}

describe('workspace meeting history API', () => {
  it('lists only ended meetings for a member, with their minutes and to-dos', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    const endedId = await endedMeetingWithMinutes({ store, meetings, owner: ada, workspaceId: workspace.workspace.id });
    await meetings.create({ workspaceId: workspace.workspace.id, ownerUserId: ada.user.id, title: 'Still open' });

    const list = await request(base, `/api/workspaces/${workspace.workspace.id}/meetings`, { cookie: ada.cookie });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{ id: string; title: string; date: string }>;
    expect(rows).toEqual([{ id: endedId, title: 'Weekly planning', date: '2026-11-20T10:00:00.000Z', status: 'ended' }]);

    const minutes = await request(
      base,
      `/api/workspaces/${workspace.workspace.id}/meetings/${endedId}/minutes`,
      { cookie: ada.cookie },
    );
    expect(minutes.status).toBe(200);
    expect(await minutes.json()).toMatchObject({
      id: endedId,
      title: 'Weekly planning',
      minutes: '# Weekly planning\n\nWe agreed the rota.',
      todos: [{ id: 'task-1', title: 'Update the rota', owner: 'Chef', done: false }],
      canEdit: true,
    });
  });

  it('keeps history to workspace members and refuses a signed-out caller', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    const endedId = await endedMeetingWithMinutes({ store, meetings, owner: ada, workspaceId: workspace.workspace.id });

    expect((await request(base, `/api/workspaces/${workspace.workspace.id}/meetings`)).status).toBe(401);
    expect(
      (await request(base, `/api/workspaces/${workspace.workspace.id}/meetings`, { cookie: ben.cookie })).status,
    ).toBe(404);
    expect(
      (
        await request(base, `/api/workspaces/${workspace.workspace.id}/meetings/${endedId}/minutes`, {
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('lets only the owner or a workspace admin tick a to-do done', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspace = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    await store.addWorkspaceMember({ workspaceId: workspace.workspace.id, userId: ben.user.id, role: 'member' });
    const endedId = await endedMeetingWithMinutes({ store, meetings, owner: ada, workspaceId: workspace.workspace.id });

    const done = await request(
      base,
      `/api/workspaces/${workspace.workspace.id}/meetings/${endedId}/todos/task-1`,
      { method: 'POST', cookie: ada.cookie, body: { done: true } },
    );
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ todos: [{ id: 'task-1', done: true }] });

    expect(
      (
        await request(base, `/api/workspaces/${workspace.workspace.id}/meetings/${endedId}/todos/task-1`, {
          method: 'POST',
          cookie: ben.cookie,
          body: { done: false },
        })
      ).status,
    ).toBe(403);

    await store.addWorkspaceMember({
      workspaceId: workspace.workspace.id,
      userId: ben.user.id,
      role: 'admin',
    });
    expect(
      (
        await request(base, `/api/workspaces/${workspace.workspace.id}/meetings/${endedId}/todos/task-1`, {
          method: 'POST',
          cookie: ben.cookie,
          body: { done: false },
        })
      ).status,
    ).toBe(200);
  });

  it('does not show one workspace’s meeting under another', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const first = await store.createWorkspace({ name: 'First', createdBy: ada.user.id });
    const second = await store.createWorkspace({ name: 'Second', createdBy: ada.user.id });
    const endedId = await endedMeetingWithMinutes({ store, meetings, owner: ada, workspaceId: first.workspace.id });

    const response = await request(
      base,
      `/api/workspaces/${second.workspace.id}/meetings/${endedId}/minutes`,
      { cookie: ada.cookie },
    );
    expect(response.status).toBe(404);
  });
});
