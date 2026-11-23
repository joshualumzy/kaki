import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import {
  createMemoryWorkspaceToolStore,
  type WorkspaceToolRecord,
  type WorkspaceToolStore,
} from '../../src/workspace/tools';
import { createTestApp, portOf } from '../helpers';

const MEETING_CODE = 'K7M2Q9';

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
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createTestApp({ auth, meetingCode, meetings, workspaceTools });
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

  it("ends and removes a member's meeting in a deleted workspace but keeps the member", async () => {
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

    // The workspace went with Ada, so the meeting row went with it, and no ghost stays loaded.
    expect(await store.getWorkspace(team.workspace.id)).toBeUndefined();
    expect(await meetings.get(benMeeting)).toBeUndefined();
    expect(app.registry.openMeetings().some((meeting) => meeting.meetingId === benMeeting)).toBe(
      false,
    );

    // Ben's account, session and own workspace are untouched.
    expect(await store.findUserById(ben.user.id)).toBeDefined();
    expect((await store.findSession(ben.tokenHash))?.userId).toBe(ben.user.id);
    expect(await store.listWorkspacesOwnedBy(ben.user.id)).toHaveLength(1);
  });
});
