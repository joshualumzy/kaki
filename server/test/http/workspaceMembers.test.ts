import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import { testScenario } from '../fixtures/scenario';
import { portOf, settle } from '../helpers';

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
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
  meetings: MeetingStore;
}> {
  const store = createMemoryAuthStore();
  const auth = createAuth({ store });
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

async function createTeam(base: string, cookie: string, name = 'Kitchen'): Promise<string> {
  const response = await request(base, '/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name },
  });
  const workspace = (await response.json()) as { id: string };
  return workspace.id;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw == null ? [] : [raw];
}

function cookiePair(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0];
}

async function seat(
  base: string,
  meetingId: string,
  cookie: string,
  name: string,
): Promise<{ cookie: string; seat: string }> {
  const response = await request(base, `/api/meetings/${meetingId}/livekit/token`, {
    method: 'POST',
    cookie,
    body: { participantName: name },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { participantRole?: string };
  return {
    seat: body.participantRole ?? '',
    cookie: cookiePair(setCookies(response), 'kaki_session') ?? cookie,
  };
}

function connect(base: string, meetingId: string, audience: string, cookie: string): Promise<WebSocket> {
  const port = new URL(base).port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?meeting=${meetingId}&audience=${audience}`,
    { headers: { cookie } },
  );
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(ws.readyState);
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('workspace membership API', () => {
  it('lets an invite link add a member, never an admin, and a reset invalidates the old link', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);

    const invite = await request(base, `/api/workspaces/${workspaceId}/invite`, {
      cookie: ada.cookie,
    });
    expect(invite.status).toBe(200);
    const first = (await invite.json()) as { token: string; path: string };
    expect(first.path).toBe(`/join-workspace/${encodeURIComponent(first.token)}`);

    // Viewing the link again shows the same one; only a reset rotates it.
    const again = await request(base, `/api/workspaces/${workspaceId}/invite`, {
      cookie: ada.cookie,
    });
    expect(((await again.json()) as { token: string }).token).toBe(first.token);

    const joined = await request(base, `/api/workspace-invites/${encodeURIComponent(first.token)}`, {
      method: 'POST',
      cookie: ben.cookie,
    });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ id: workspaceId, role: 'member' });
    expect(await store.getMembership({ workspaceId, userId: ben.user.id })).toBe('member');

    // Opening the same reusable link again changes nothing.
    await request(base, `/api/workspace-invites/${encodeURIComponent(first.token)}`, {
      method: 'POST',
      cookie: ben.cookie,
    });
    expect(await store.getMembership({ workspaceId, userId: ben.user.id })).toBe('member');

    const reset = await request(base, `/api/workspaces/${workspaceId}/invite/reset`, {
      method: 'POST',
      cookie: ada.cookie,
    });
    expect(reset.status).toBe(200);
    const second = (await reset.json()) as { token: string };
    expect(second.token).not.toBe(first.token);

    const old = await request(base, `/api/workspace-invites/${encodeURIComponent(first.token)}`, {
      method: 'POST',
      cookie: ben.cookie,
    });
    expect(old.status).toBe(404);
    expect(await old.json()).toEqual({ error: 'This invite link is not valid.' });
  });

  it('never invites into a personal or sample workspace, and only admins see the link', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });

    expect(
      (await request(base, `/api/workspaces/${SAMPLE_WORKSPACE_ID}/invite`, { cookie: ada.cookie }))
        .status,
    ).toBe(403);
    const personal = (await store.listWorkspacesForUser(ada.user.id)).find(
      (entry) => entry.workspace.kind === 'personal',
    );
    if (personal === undefined) throw new Error('Ada has no personal workspace');
    expect(
      (await request(base, `/api/workspaces/${personal.workspace.id}/invite`, { cookie: ada.cookie }))
        .status,
    ).toBe(403);
    expect(
      (await request(base, `/api/workspaces/${workspaceId}/invite`, { cookie: ben.cookie })).status,
    ).toBe(403);
  });

  it('lists members, promotes, demotes, removes, and keeps the last admin', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const cara = await signIn(store, 'Cara');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });
    await store.addWorkspaceMember({ workspaceId, userId: cara.user.id, role: 'member' });

    const detail = (await (
      await request(base, `/api/workspaces/${workspaceId}`, { cookie: ben.cookie })
    ).json()) as { people: Array<{ id: string; name: string; role: string }> };
    expect(detail.people).toEqual(
      expect.arrayContaining([
        { id: ada.user.id, name: 'Ada', role: 'admin' },
        { id: ben.user.id, name: 'Ben', role: 'member' },
        { id: cara.user.id, name: 'Cara', role: 'member' },
      ]),
    );

    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/members/${ada.user.id}`, {
          method: 'PATCH',
          cookie: ada.cookie,
          body: { role: 'member' },
        })
      ).status,
    ).toBe(409);

    const promoted = await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
      method: 'PATCH',
      cookie: ada.cookie,
      body: { role: 'admin' },
    });
    expect(promoted.status).toBe(200);
    expect(await store.getMembership({ workspaceId, userId: ben.user.id })).toBe('admin');

    // Ada is no longer the last admin, so she may step down.
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/members/${ada.user.id}`, {
          method: 'PATCH',
          cookie: ada.cookie,
          body: { role: 'member' },
        })
      ).status,
    ).toBe(200);

    // Ben is now the only admin and cannot leave or be demoted.
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/leave`, {
          method: 'POST',
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
          method: 'DELETE',
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(409);

    // A plain member may leave.
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/leave`, {
          method: 'POST',
          cookie: cara.cookie,
        })
      ).status,
    ).toBe(200);
    expect(await store.getMembership({ workspaceId, userId: cara.user.id })).toBeUndefined();
  });

  it('refuses to remove a member who owns an open meeting in the workspace', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });
    const meeting = await meetings.create({
      workspaceId,
      ownerUserId: ben.user.id,
      title: 'Live planning',
    });

    const blocked = await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'This person owns an open meeting in this workspace. End it before removing them.',
    });
    expect(await store.getMembership({ workspaceId, userId: ben.user.id })).toBe('member');

    await meetings.markEnded?.(meeting.id, new Date().toISOString());
    const removed = await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(removed.status).toBe(200);
    expect(await store.getMembership({ workspaceId, userId: ben.user.id })).toBeUndefined();
  });

  it('takes removed members out of the workspace at once: minutes and live sockets', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });

    const ended = await meetings.create({
      workspaceId,
      ownerUserId: ada.user.id,
      title: 'Past planning',
    });
    await meetings.markEnded?.(ended.id, new Date().toISOString());
    await meetings.saveMinutes?.(ended.id, {
      minutes: 'We agreed the rota.',
      todos: [{ id: 'task-1', title: 'Update the rota', owner: 'Chef', status: 'SUGGESTED', done: false }],
    });
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/meetings/${ended.id}/minutes`, {
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(200);

    const live = await meetings.create({
      workspaceId,
      ownerUserId: ada.user.id,
      title: 'Live planning',
    });
    const benSeat = await seat(base, live.id, ben.cookie, 'Ben');
    const benSocket = await connect(base, live.id, 'participant', benSeat.cookie);
    await settle();

    const removed = await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(removed.status).toBe(200);

    // The live socket is closed, and the removed member's session kept no workspace access.
    expect(await closed(benSocket)).toBe(4001);
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/meetings/${ended.id}/minutes`, {
          cookie: benSeat.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}`, {
          cookie: benSeat.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('keeps a removed member’s name on the history they already wrote', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });
    const ended = await meetings.create({
      workspaceId,
      ownerUserId: ben.user.id,
      title: 'Ben’s planning',
    });
    await meetings.markEnded?.(ended.id, new Date().toISOString());
    await meetings.saveMinutes?.(ended.id, {
      minutes: 'Ben wrote this.',
      todos: [{ id: 'task-1', title: 'Ben’s follow-up', owner: 'Ben', status: 'SUGGESTED', done: false }],
    });

    expect(
      (
        await request(base, `/api/workspaces/${workspaceId}/members/${ben.user.id}`, {
          method: 'DELETE',
          cookie: ada.cookie,
        })
      ).status,
    ).toBe(200);

    const minutes = await request(
      base,
      `/api/workspaces/${workspaceId}/meetings/${ended.id}/minutes`,
      { cookie: ada.cookie },
    );
    expect(minutes.status).toBe(200);
    expect(await minutes.json()).toMatchObject({
      minutes: 'Ben wrote this.',
      todos: [{ id: 'task-1', owner: 'Ben', title: 'Ben’s follow-up' }],
    });
  });
});
