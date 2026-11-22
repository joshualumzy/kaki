import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreateAppOptions, type KakiApp } from '../../src/app';
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

async function buildApp(
  options: Omit<CreateAppOptions, 'scenario' | 'speechRecognition' | 'auth' | 'meetingCode' | 'meetings'> = {},
): Promise<{
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
    ...options,
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

  it('allows the sample workspace but refuses non-members, bad titles and bad dates', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    const sample = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: { workspaceId: SAMPLE_WORKSPACE_ID, title: 'Nanyang sync' },
    });
    expect(sample.status).toBe(200);
    expect((await sample.json()) as { id: string }).toMatchObject({ id: expect.any(String) });

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
      guestId: expect.any(String),
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

  it('finds an open meeting by its code, and answers 404 plainly for a wrong or ended one', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Kitchen team', createdBy: ada.user.id });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Weekly planning');

    const instance = await apps[apps.length - 1]!.registry.get(meeting.id);
    const code = instance!.meetingCode();

    const found = await request(base, `/api/meetings/by-code/${code.toLowerCase()}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ id: meeting.id });

    const wrong = await request(base, '/api/meetings/by-code/NOPE22');
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "We couldn't find a meeting with that code. Check it, or open the invite link.",
    );

    await meetings.markEnded?.(meeting.id, new Date().toISOString());
    expect((await request(base, `/api/meetings/by-code/${code}`)).status).toBe(404);
  });

  it('gives every real meeting its own code even when a practice code is pinned', async () => {
    const previous = process.env.KAKI_MEETING_CODE;
    process.env.KAKI_MEETING_CODE = 'PINNED';
    try {
      const { base, store } = await buildApp();
      const ada = await signIn(store, 'Ada');
      const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
      const registry = apps[apps.length - 1]!.registry;
      const first = await createMeeting(base, ada.cookie, team.workspace.id, 'One');
      const second = await createMeeting(base, ada.cookie, team.workspace.id, 'Two');
      const codeOne = (await registry.get(first.id))!.meetingCode();
      const codeTwo = (await registry.get(second.id))!.meetingCode();
      expect(codeOne).not.toBe('PINNED');
      expect(codeOne).not.toBe(codeTwo);
      const found = await request(base, `/api/meetings/by-code/${codeTwo}`);
      expect(await found.json()).toEqual({ id: second.id });
    } finally {
      if (previous === undefined) delete process.env.KAKI_MEETING_CODE;
      else process.env.KAKI_MEETING_CODE = previous;
    }
  });

  it('lets the owner of an ended sample-workspace meeting read its minutes, and no one else', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const meeting = await createMeeting(base, ada.cookie, SAMPLE_WORKSPACE_ID, 'Sample chat');
    await meetings.markEnded!(meeting.id, new Date().toISOString());
    await meetings.saveMinutes!(meeting.id, { minutes: 'We agreed.', todos: [] });
    const path = `/api/workspaces/${SAMPLE_WORKSPACE_ID}/meetings/${meeting.id}/minutes`;

    const owner = await request(base, path, { cookie: ada.cookie });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ minutes: 'We agreed.', canEdit: false });
    expect((await request(base, path, { cookie: ben.cookie })).status).toBe(404);

    const benMeeting = await createMeeting(base, ben.cookie, SAMPLE_WORKSPACE_ID, 'Ben chat');
    await meetings.markEnded!(benMeeting.id, new Date().toISOString());
    const listPath = `/api/workspaces/${SAMPLE_WORKSPACE_ID}/meetings`;
    const adaList = await request(base, listPath, { cookie: ada.cookie });
    expect(adaList.status).toBe(200);
    expect((await adaList.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: meeting.id, title: 'Sample chat', status: 'ended' }),
    ]);
    const benList = await request(base, listPath, { cookie: ben.cookie });
    expect((await benList.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: benMeeting.id, title: 'Ben chat', status: 'ended' }),
    ]);
    // The sample workspace stays read-only otherwise: its to-dos cannot be edited.
    expect(
      (await request(
        base,
        `/api/workspaces/${SAMPLE_WORKSPACE_ID}/meetings/${meeting.id}/todos/any`,
        { method: 'POST', cookie: ada.cookie, body: { done: true } },
      )).status,
    ).toBe(403);
  });

  it('caps how many real meetings one owner keeps open at once, and frees a slot when one is unloaded', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const first = await createMeeting(base, ada.cookie, team.workspace.id, 'One');
    const second = await createMeeting(base, ada.cookie, team.workspace.id, 'Two');
    const third = await createMeeting(base, ada.cookie, team.workspace.id, 'Three');
    const state = (id: string) =>
      request(base, `/api/meetings/${id}/meeting/state`);

    expect((await state(first.id)).status).toBe(200);
    expect((await state(second.id)).status).toBe(200);
    const blocked = await state(third.id);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({
      error: 'busy',
      message: 'You already have 2 meetings open. End one to start another.',
    });

    const app = apps[apps.length - 1]!;
    await app.registry.unload(first.id);
    expect((await state(third.id)).status).toBe(200);
  });

  it('caps how many meetings one owner creates in a day, without limiting another owner', async () => {
    const { base, store } = await buildApp({ maxMeetingsPerDay: 2 });
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    await createMeeting(base, ada.cookie, team.workspace.id, 'One');
    await createMeeting(base, ada.cookie, team.workspace.id, 'Two');

    const blocked = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: { workspaceId: team.workspace.id, title: 'Three' },
    });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({
      error: 'busy',
      message: 'You can create up to 2 meetings a day. Try again tomorrow.',
    });

    expect(
      (await request(base, '/api/meetings', {
        method: 'POST',
        cookie: ben.cookie,
        body: { workspaceId: SAMPLE_WORKSPACE_ID, title: 'Ben one' },
      })).status,
    ).toBe(200);
  });

  it('opens the shared demo Mattermost sign-in only in the sample workspace', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Real work');
    const target = encodeURIComponent('http://mattermost.test/kopitiam/channels/town-square');

    const denied = await request(base, `/api/meetings/${meeting.id}/mattermost/open?url=${target}`, {
      cookie: ada.cookie,
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain('sample workspace');
  });

  it('refuses a guest join for an ended meeting without giving a name cookie', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });
    const meeting = await createMeeting(base, ada.cookie, team.workspace.id, 'Weekly planning');
    await meetings.markEnded!(meeting.id, new Date().toISOString());
    const response = await request(base, `/api/meetings/${meeting.id}/join`, {
      method: 'POST',
      body: { name: 'Sam' },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('This meeting has ended');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
