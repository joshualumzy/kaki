import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { SAMPLE_WORKSPACE_ID } from '../../src/workspace/constants';
import {
  createMemoryWorkspaceToolStore,
  type WorkspaceToolRecord,
  type WorkspaceToolStore,
} from '../../src/workspace/tools';
import { createTestApp, portOf } from '../helpers';

interface SignedIn {
  user: UserRecord;
  tokenHash: string;
  cookie: string;
}

function toolRecord(workspaceId: string): WorkspaceToolRecord {
  return {
    workspaceId,
    kind: 'mattermost',
    settings: { url: 'http://mattermost.test', team: 'kopitiam', channel: 'launch' },
    secret: Buffer.from('secret'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
    keyId: 'key-1',
    connectedBy: 'user-1',
    connectedAt: new Date('2026-11-01T00:00:00Z'),
    lastOkAt: null,
  };
}

describe('delete account', () => {
  let app: KakiApp;
  let store: AuthStore;
  let meetings: ReturnType<typeof createMemoryMeetingStore>;
  let workspaceTools: WorkspaceToolStore;
  let port: number;

  beforeEach(async () => {
    store = createMemoryAuthStore();
    meetings = createMemoryMeetingStore();
    workspaceTools = createMemoryWorkspaceToolStore();
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
    app = await createTestApp({
      auth,
      meetings,
      workspaceTools,
      serviceToken: 'runner-secret',
    });
    port = portOf(app);
  });

  afterEach(async () => {
    await app.close();
  });

  async function signIn(name: string, email: string): Promise<SignedIn> {
    const user = await store.createGoogleUser({
      googleSub: `google-${randomUUID()}`,
      name,
      email,
    });
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    await store.createSession({
      tokenHash,
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: name,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { user, tokenHash, cookie: `kaki_session=${encodeURIComponent(token)}` };
  }

  function request(
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function deleteAccount(cookie: string | undefined, body: unknown): Promise<Response> {
    return request('DELETE', '/api/account', {
      ...(cookie === undefined ? {} : { cookie }),
      body,
    });
  }

  async function createMeeting(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request('POST', '/api/meetings', {
      cookie,
      body: { workspaceId, title },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    return body.id;
  }

  it('deletes the user and everything they own', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const personal = (await store.listWorkspacesForUser(ada.user.id))[0]!.workspace;
    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    const meetingId = await createMeeting(ada.cookie, personal.id, 'Planning');
    await workspaceTools.save(toolRecord(personal.id));

    const response = await deleteAccount(ada.cookie, { confirm: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await store.findUserByEmail('ada@example.test')).toBeUndefined();
    expect(await store.findUserById(ada.user.id)).toBeUndefined();
    expect(await store.listWorkspacesForUser(ada.user.id)).toEqual([]);
    expect(await store.getWorkspace(personal.id)).toBeUndefined();
    expect(await store.getWorkspace(team.workspace.id)).toBeUndefined();
    expect(await store.findSession(ada.tokenHash)).toBeUndefined();
    expect(await meetings.get(meetingId)).toBeUndefined();
    expect(await workspaceTools.list(personal.id)).toEqual([]);
  });

  it('leaves another user and their data untouched', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const grace = await signIn('Grace Hopper', 'grace@example.test');
    const graceWorkspace = (await store.listWorkspacesForUser(grace.user.id))[0]!.workspace;
    const graceMeeting = await createMeeting(grace.cookie, graceWorkspace.id, 'Ship it');
    await workspaceTools.save(toolRecord(graceWorkspace.id));

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    expect(await store.findUserByEmail('grace@example.test')).toBeDefined();
    expect(await store.listWorkspacesForUser(grace.user.id)).toHaveLength(1);
    expect((await store.findSession(grace.tokenHash))?.userId).toBe(grace.user.id);
    expect((await meetings.get(graceMeeting))?.status).toBe('open');
    expect(await workspaceTools.list(graceWorkspace.id)).toHaveLength(1);

    const workspaces = await request('GET', '/api/workspaces', { cookie: grace.cookie });
    expect(workspaces.status).toBe(200);
  });

  it('refuses an unauthenticated request and deletes nothing', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');

    const response = await deleteAccount(undefined, { confirm: 'DELETE' });

    expect(response.status).toBe(401);
    expect(await store.findUserById(ada.user.id)).toBeDefined();
    expect(await store.findSession(ada.tokenHash)).toBeDefined();
  });

  it('refuses a cross-site request and deletes nothing', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');

    const response = await request('DELETE', '/api/account', {
      cookie: ada.cookie,
      body: { confirm: 'DELETE' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(response.status).toBe(403);
    expect(await store.findUserById(ada.user.id)).toBeDefined();
  });

  it('refuses a wrong or missing confirmation and deletes nothing', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');

    const wrongCase = await deleteAccount(ada.cookie, { confirm: 'delete' });
    expect(wrongCase.status).toBe(400);
    expect(await wrongCase.json()).toEqual({ error: 'Type DELETE to confirm.' });

    const missing = await deleteAccount(ada.cookie, {});
    expect(missing.status).toBe(400);

    expect(await store.findUserById(ada.user.id)).toBeDefined();
    expect(await store.findSession(ada.tokenHash)).toBeDefined();
  });

  it('ends owned meetings first and leaves other meetings open', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const grace = await signIn('Grace Hopper', 'grace@example.test');
    const adaWorkspace = (await store.listWorkspacesForUser(ada.user.id))[0]!.workspace;
    const graceWorkspace = (await store.listWorkspacesForUser(grace.user.id))[0]!.workspace;
    const adaMeeting = await createMeeting(ada.cookie, adaWorkspace.id, 'Ada open');
    const graceMeeting = await createMeeting(grace.cookie, graceWorkspace.id, 'Grace open');
    expect(await app.registry.get(adaMeeting)).toBeDefined();

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    expect(await meetings.get(adaMeeting)).toBeUndefined();
    expect(app.registry.openMeetings().some((meeting) => meeting.meetingId === adaMeeting)).toBe(
      false,
    );
    expect((await meetings.get(graceMeeting))?.status).toBe('open');
    expect(app.registry.openMeetings().some((meeting) => meeting.meetingId === graceMeeting)).toBe(
      false,
    );
  });

  it("keeps a team's data when a removed creator deletes their account", async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    const team = await store.createWorkspace({ name: 'Kitchen', createdBy: ada.user.id });
    await store.addWorkspaceMember({
      workspaceId: team.workspace.id,
      userId: ben.user.id,
      role: 'admin',
    });
    const benMeeting = await createMeeting(ben.cookie, team.workspace.id, 'Kitchen planning');
    await workspaceTools.save(toolRecord(team.workspace.id));
    await store.saveWorkspaceInvite({
      workspaceId: team.workspace.id,
      token: 'team-invite',
      createdBy: ada.user.id,
    });

    // Another admin removes the creator; their account must not carry the team away afterwards.
    expect(
      (
        await request('DELETE', `/api/workspaces/${team.workspace.id}/members/${ada.user.id}`, {
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(200);
    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    expect(await store.getWorkspace(team.workspace.id)).toBeDefined();
    expect(
      await store.getMembership({ workspaceId: team.workspace.id, userId: ben.user.id }),
    ).toBe('admin');
    expect(await meetings.get(benMeeting)).toBeDefined();
    expect(await workspaceTools.list(team.workspace.id)).toHaveLength(1);
    expect((await store.getWorkspaceInvite(team.workspace.id))?.createdBy).toBeNull();
  });

  it("keeps a team and its meetings when the creator was not its last member", async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    const team = await store.createWorkspace({ name: 'Ada team', createdBy: ada.user.id });
    await store.addWorkspaceMember({
      workspaceId: team.workspace.id,
      userId: ben.user.id,
      role: 'member',
    });
    const benMeeting = await createMeeting(ben.cookie, team.workspace.id, "Ben's meeting");
    // Load it, so the meeting is live in the registry when Ada deletes her account.
    expect(await app.registry.get(benMeeting)).toBeDefined();
    expect(app.registry.openMeetings().some((meeting) => meeting.meetingId === benMeeting)).toBe(
      true,
    );

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    // Another member remains, so the team and everything it holds stay; only attribution went null.
    const kept = await store.getWorkspace(team.workspace.id);
    expect(kept).toBeDefined();
    expect(kept?.createdBy).toBeNull();
    expect(await store.getMembership({ workspaceId: team.workspace.id, userId: ben.user.id })).toBe(
      'admin',
    );
    expect((await meetings.get(benMeeting))?.status).toBe('open');
    expect(app.registry.openMeetings().some((meeting) => meeting.meetingId === benMeeting)).toBe(
      true,
    );

    // Ben's account, session and own workspace are untouched.
    expect(await store.findUserById(ben.user.id)).toBeDefined();
    expect((await store.findSession(ben.tokenHash))?.userId).toBe(ben.user.id);
    expect(await store.listWorkspacesOwnedBy(ben.user.id)).toHaveLength(1);
  });

  it('refuses a guest session, a phone seat and the service token', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const personal = (await store.listWorkspacesForUser(ada.user.id))[0]!.workspace;
    const meetingId = await createMeeting(ada.cookie, personal.id, 'Ada open');

    const guestToken = randomBytes(32).toString('base64url');
    await store.createSession({
      tokenHash: hashToken(guestToken),
      kind: 'guest',
      role: null,
      meetingCode: null,
      meetingId,
      displayName: 'Visitor',
      userId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const guest = await deleteAccount(`kaki_session=${encodeURIComponent(guestToken)}`, {
      confirm: 'DELETE',
    });
    expect(guest.status).toBe(403);

    const phoneToken = randomBytes(32).toString('base64url');
    const phoneHash = hashToken(phoneToken);
    const seated = await store.enterSeat({
      session: {
        tokenHash: phoneHash,
        kind: 'participant',
        role: 'chef',
        meetingCode: null,
        meetingId,
        displayName: 'Phone',
        userId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      meetingId,
      role: 'chef',
    });
    expect(seated).toBe(true);
    const phone = await deleteAccount(`kaki_session=${encodeURIComponent(phoneToken)}`, {
      confirm: 'DELETE',
    });
    expect(phone.status).toBe(403);

    const service = await request('DELETE', '/api/account', {
      body: { confirm: 'DELETE' },
      headers: { authorization: 'Bearer runner-secret' },
    });
    expect(service.status).toBe(403);

    expect(await store.findUserById(ada.user.id)).toBeDefined();
    expect(await store.findSession(ada.tokenHash)).toBeDefined();
    expect(await meetings.get(meetingId)).toBeDefined();
  });

  it("deletes the account's own practice meetings and keeps other people's", async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    const adaPractice = await app.registry.createPractice({
      ownerUserId: ada.user.id,
      title: 'Ada practice',
    });
    const benPractice = await app.registry.createPractice({
      ownerUserId: ben.user.id,
      title: 'Ben practice',
    });
    await meetings.saveMinutes!(adaPractice.id, {
      minutes: 'Ada said this in her own practice.',
      todos: [
        { id: 'todo-1', title: 'Ada own to-do', owner: 'Ada', status: 'DRAFT_READY', done: false },
      ],
    });

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    // The deleted account's practice meeting carries their own words with it.
    expect(await meetings.get(adaPractice.id)).toBeUndefined();
    // Another person's practice meeting and the sample workspace itself stay untouched.
    expect(await meetings.get(benPractice.id)).toBeDefined();
    const workspaces = await request('GET', '/api/workspaces', { cookie: ben.cookie });
    const body = (await workspaces.json()) as Array<{ id: string }>;
    expect(body.some((workspace) => workspace.id === SAMPLE_WORKSPACE_ID)).toBe(true);
  });

  it("leaves the sample workspace and another visitor's practice meeting alone", async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    const practice = await app.registry.createPractice();

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    expect(app.registry.findPractice(practice.id)).toBeDefined();
    const workspaces = await request('GET', '/api/workspaces', { cookie: ben.cookie });
    expect(workspaces.status).toBe(200);
    const body = (await workspaces.json()) as Array<{ id: string }>;
    expect(body.some((workspace) => workspace.id === SAMPLE_WORKSPACE_ID)).toBe(true);
  });

  it('rejects the old cookie and closes an open socket once the account is gone', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    // Ada is only a member of Ben's team: the workspace and meeting must outlive her account.
    const benTeam = await store.createWorkspace({ name: 'Ben team', createdBy: ben.user.id });
    await store.addWorkspaceMember({
      workspaceId: benTeam.workspace.id,
      userId: ada.user.id,
      role: 'member',
    });
    const benMeeting = await createMeeting(ben.cookie, benTeam.workspace.id, 'Ben team meeting');
    expect(await app.registry.get(benMeeting)).toBeDefined();

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?meeting=${benMeeting}&audience=lifecycle`,
      { headers: { cookie: ada.cookie } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        resolve();
      }),
    );

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);
    await closed;
    socket.terminate();

    // Signed out is a normal state for auth/me: 200 with no session, never the deleted account.
    const me = await request('GET', '/api/auth/me', { cookie: ada.cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ kind: null });
    const workspaces = await request('GET', '/api/workspaces', { cookie: ada.cookie });
    expect(workspaces.status).toBe(401);

    // Ben's workspace survives with Ada's membership removed.
    expect(await store.getWorkspace(benTeam.workspace.id)).toBeDefined();
    expect(
      await store.getMembership({ workspaceId: benTeam.workspace.id, userId: ada.user.id }),
    ).toBeUndefined();
    expect((await meetings.get(benMeeting))?.ownerUserId).toBe(ben.user.id);
  });

  it("keeps an owned meeting in someone else's workspace and deletes one in its own", async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const ben = await signIn('Ben Bitdiddle', 'ben@example.test');
    const adaWorkspace = (await store.listWorkspacesForUser(ada.user.id))[0]!.workspace;
    const benWorkspace = (await store.listWorkspacesForUser(ben.user.id))[0]!.workspace;
    const inOwnWorkspace = await createMeeting(ada.cookie, adaWorkspace.id, 'Ada own');
    const inBenWorkspace = await app.registry.create({
      workspaceId: benWorkspace.id,
      ownerUserId: ada.user.id,
      title: 'Ada in Ben room',
    });

    expect((await deleteAccount(ada.cookie, { confirm: 'DELETE' })).status).toBe(200);

    expect(await meetings.get(inOwnWorkspace)).toBeUndefined();
    const kept = await meetings.get(inBenWorkspace.id);
    expect(kept?.ownerUserId).toBeNull();
    expect(kept?.status).toBe('ended');
    expect(await store.getWorkspace(benWorkspace.id)).toBeDefined();
    expect(await store.findUserById(ben.user.id)).toBeDefined();
  });

  it('removes nothing when the deletion cannot start', async () => {
    const ada = await signIn('Ada Lovelace', 'ada@example.test');
    const personal = (await store.listWorkspacesForUser(ada.user.id))[0]!.workspace;
    const meetingId = await createMeeting(ada.cookie, personal.id, 'Ada open');
    // A store that cannot delete meetings must fail loudly before any account data changes.
    const withoutDelete = { ...meetings, deleteByOwner: undefined };
    const broken = await createTestApp({
      auth: createAuth({
        store,
        offeredRoles: () => ['chef', 'cashier'],
      }),
      meetings: withoutDelete,
      workspaceTools,
    });
    try {
      const brokenPort = portOf(broken);
      const response = await fetch(`http://127.0.0.1:${brokenPort}/api/account`, {
        method: 'DELETE',
        headers: { cookie: ada.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      expect(response.status).toBe(500);

      // The broken app shares this store, so it must still hold everything.
      expect(await store.findUserById(ada.user.id)).toBeDefined();
      expect(await store.findSession(ada.tokenHash)).toBeDefined();
      expect(await store.getWorkspace(personal.id)).toBeDefined();
      expect(await meetings.get(meetingId)).toBeDefined();
    } finally {
      await broken.close();
    }
  });
});
