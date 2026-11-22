import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth, type Auth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
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

async function buildApp(): Promise<{
  base: string;
  store: AuthStore;
  auth: Auth;
  meetings: ReturnType<typeof createMemoryMeetingStore>;
}> {
  const store = createMemoryAuthStore();
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({ store, meetingCode });
  const meetings = createMemoryMeetingStore();
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings,
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, store, auth, meetings };
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

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw == null ? [] : [raw];
}

function cookiePair(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0];
}

async function createMeeting(
  base: string,
  cookie: string,
  workspaceId: string,
  title: string,
  scheduledFor?: string,
): Promise<{ id: string; link: string }> {
  const response = await request(base, '/api/meetings', {
    method: 'POST',
    cookie,
    body: {
      workspaceId,
      title,
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; link: string };
}

function fakeRequest(cookie: string): IncomingMessage {
  return { headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

describe('meetings API', () => {
  it('creates a meeting, returns its link, and publishes only its public info', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Kitchen team', createdBy: ada.user.id });

    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, '  Weekly planning  ');
    expect(meeting.link).toBe(`/m/${meeting.id}`);
    expect(await store.getWorkspace(team.workspace.id)).toBeDefined();

    const info = await request(base, `/api/meetings/${meeting.id}/info`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as Record<string, unknown>;
    expect(body).toEqual({
      title: 'Weekly planning',
      workspaceName: 'Kitchen team',
      scheduledFor: null,
      status: 'open',
      ownerName: 'Ada',
      historyWorkspaceId: null,
    });
  });

  it('tells the link an ended meeting is over and points only its members at the notes', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const outsider = await signIn(store, 'Outsider');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: ben.user.id, role: 'member' });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Weekly planning');
    await meetings.markEnded!(meeting.id, new Date().toISOString());

    const guest = (await (await request(base, `/api/meetings/${meeting.id}/info`)).json()) as Record<string, unknown>;
    expect(guest).toMatchObject({ status: 'ended', historyWorkspaceId: null });

    const owner = (await (
      await request(base, `/api/meetings/${meeting.id}/info`, { cookie: ada.cookie })
    ).json()) as Record<string, unknown>;
    expect(owner.historyWorkspaceId).toBe(team.workspace.id);

    const member = (await (
      await request(base, `/api/meetings/${meeting.id}/info`, { cookie: ben.cookie })
    ).json()) as Record<string, unknown>;
    expect(member.historyWorkspaceId).toBe(team.workspace.id);

    const stranger = (await (
      await request(base, `/api/meetings/${meeting.id}/info`, { cookie: outsider.cookie })
    ).json()) as Record<string, unknown>;
    expect(stranger.historyWorkspaceId).toBeNull();
  });

  it('marks a future meeting as scheduled and a past one as open', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    const future = await createMeeting(
      base,
      ada.cookie,
      team.workspace.id,
      'Next week',
      new Date(Date.now() + 60 * 60_000).toISOString(),
    );
    const futureInfo = (await (
      await request(base, `/api/meetings/${future.id}/info`)
    ).json()) as { status: string };
    expect(futureInfo.status).toBe('scheduled');

    const past = await createMeeting(
      base,
      ada.cookie,
      team.workspace.id,
      'Yesterday',
      new Date(Date.now() - 60 * 60_000).toISOString(),
    );
    const pastInfo = (await (
      await request(base, `/api/meetings/${past.id}/info`)
    ).json()) as { status: string };
    expect(pastInfo.status).toBe('open');
  });

  it('refuses the sample workspace, non-members, bad titles and bad dates', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    expect(
      (await request(base, '/api/meetings', {
        method: 'POST',
        cookie: ada.cookie,
        body: { workspaceId: SAMPLE_WORKSPACE_ID, title: 'Nope' },
      })).status,
    ).toBe(403);

    expect(
      (await request(base, '/api/meetings', {
        method: 'POST',
        cookie: ben.cookie,
        body: { workspaceId: team.workspace.id, title: 'Nope' },
      })).status,
    ).toBe(403);

    expect(
      (await request(base, '/api/meetings', {
        method: 'POST',
        cookie: ada.cookie,
        body: { workspaceId: team.workspace.id, title: '   ' },
      })).status,
    ).toBe(400);

    expect(
      (await request(base, '/api/meetings', {
        method: 'POST',
        cookie: ada.cookie,
        body: { workspaceId: team.workspace.id, title: 'Meeting', scheduledFor: 'not-a-date' },
      })).status,
    ).toBe(400);
  });

  it('answers 404 for an unknown meeting', async () => {
    const { base } = await buildApp();
    const response = await request(base, '/api/meetings/does-not-exist/info');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'meeting-not-found' });
  });

  it('makes the owner and a workspace admin host, but not an ordinary member', async () => {
    const { base, store } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const admin = await signIn(store, 'Admin');
    const member = await signIn(store, 'Member');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: admin.user.id, role: 'admin' });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.user.id, role: 'member' });
    const meeting = await createMeeting(base, owner.cookie, team.workspace.id, 'Meeting');

    const participants = `/api/meetings/${meeting.id}/meeting/participants`;
    expect((await request(base, participants, { cookie: owner.cookie })).status).toBe(200);
    expect((await request(base, participants, { cookie: admin.cookie })).status).toBe(200);
    expect((await request(base, participants, { cookie: member.cookie })).status).toBe(403);
  });

  it('gives a guest a cookie for one meeting only', async () => {
    const { base, store, auth } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const meetingA = await createMeeting(base, ada.cookie, team.workspace.id, 'A');
    const meetingB = await createMeeting(base, ada.cookie, team.workspace.id, 'B');

    const joined = await request(base, `/api/meetings/${meetingA.id}/join`, {
      method: 'POST',
      body: { name: '  Guest  ' },
    });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ ok: true, name: 'Guest' });
    const cookie = cookiePair(setCookies(joined), 'kaki_session');
    expect(cookie).toBeDefined();

    expect(await auth.resolvePrincipal(fakeRequest(cookie!), meetingA.id)).toEqual({
      kind: 'guest',
      meetingId: meetingA.id,
      name: 'Guest',
    });
    expect(await auth.resolvePrincipal(fakeRequest(cookie!), meetingB.id)).toBeUndefined();
    // A guest is not a legacy-meeting participant either.
    expect((await request(base, '/api/setup', { cookie: cookie! })).status).toBe(401);
  });

  it('lets a signed-in user join without a name and without a guest session', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Meeting');

    const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
      method: 'POST',
      cookie: ben.cookie,
    });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ ok: true, name: 'Ben' });
    expect(cookiePair(setCookies(joined), 'kaki_session')).toBeUndefined();
  });

  it('rejects an empty or overlong guest name', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Meeting');

    expect(
      (await request(base, `/api/meetings/${meeting.id}/join`, {
        method: 'POST',
        body: { name: '   ' },
      })).status,
    ).toBe(400);
    expect(
      (await request(base, `/api/meetings/${meeting.id}/join`, {
        method: 'POST',
        body: { name: 'x'.repeat(41) },
      })).status,
    ).toBe(400);
  });
});
