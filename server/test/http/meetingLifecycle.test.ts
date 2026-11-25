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

const future = (): string => new Date(Date.now() + 60 * 60_000).toISOString();
const past = (): string => new Date(Date.now() - 60 * 60_000).toISOString();

describe('meeting lifecycle API', () => {
  it('lets the owner or an admin edit a scheduled meeting, but not an ordinary member', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const admin = await signIn(store, 'Admin');
    const member = await signIn(store, 'Member');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: admin.user.id, role: 'admin' });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.user.id, role: 'member' });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: future(),
      agenda: [{ title: 'Budget', minutes: 10 }],
    });

    const edited = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: {
        title: 'Planning v2',
        agenda: [{ title: 'Budget', minutes: 15, ownerUserId: member.user.id }],
        pace: { quietCheckAfter: 90, comingUpBefore: 45 },
      },
    });
    expect(edited.status).toBe(200);
    const stored = await meetings.get(meeting.id);
    expect(stored).toMatchObject({
      title: 'Planning v2',
      agenda: [{ title: 'Budget', minutes: 15, ownerUserId: member.user.id }],
      pace: { quietCheckAfter: 90, comingUpBefore: 45 },
    });

    expect(
      (
        await request(base, `/api/meetings/${meeting.id}`, {
          method: 'PATCH',
          cookie: member.cookie,
          body: { title: 'Not allowed' },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await request(base, `/api/meetings/${meeting.id}`, {
          method: 'PATCH',
          cookie: admin.cookie,
          body: { title: 'Admin edit' },
        })
      ).status,
    ).toBe(200);
    expect((await meetings.get(meeting.id))?.title).toBe('Admin edit');
  });

  it('refuses an agenda owner who is not in the workspace', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const outsider = await signIn(store, 'Outsider');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: future(),
    });

    const response = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { agenda: [{ title: 'Budget', ownerUserId: outsider.user.id }] },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'That agenda owner is not a member of this workspace.',
    );
  });

  it('reschedules only into the future, and only a scheduled meeting', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: future(),
    });
    const next = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    expect(
      (
        await request(base, `/api/meetings/${meeting.id}`, {
          method: 'PATCH',
          cookie: owner.cookie,
          body: { scheduledFor: next },
        })
      ).status,
    ).toBe(200);
    expect((await meetings.get(meeting.id))?.scheduledFor).toBe(next);

    const pastResponse = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { scheduledFor: past() },
    });
    expect(pastResponse.status).toBe(400);
    expect(((await pastResponse.json()) as { error: string }).error).toBe(
      'Choose a future date and time.',
    );

    const open = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Open now',
    });
    const openResponse = await request(base, `/api/meetings/${open.id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { title: 'Changed' },
    });
    expect(openResponse.status).toBe(409);
  });

  it('turns an early-started scheduled meeting open, so it can no longer be edited or cancelled', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: future(),
      agenda: [{ title: 'Budget', minutes: 10 }],
    });

    const joined = await request(base, `/api/meetings/${meeting.id}/livekit/token`, {
      method: 'POST',
      cookie: owner.cookie,
      body: { participantName: 'Owner' },
    });
    expect(joined.status).toBe(200);
    // Joining takes the owner's seat and replaces their session cookie with the host seat session.
    const seatedCookie = joined.headers.get('set-cookie')?.split(';')[0] ?? owner.cookie;
    const started = await request(base, `/api/meetings/${meeting.id}/meeting/start`, {
      method: 'POST',
      cookie: seatedCookie,
    });
    expect(started.status).toBe(200);
    expect((await meetings.get(meeting.id))?.status).toBe('open');

    const edited = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: seatedCookie,
      body: { title: 'Not while live' },
    });
    expect(edited.status).toBe(409);
    const cancelled = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'DELETE',
      cookie: seatedCookie,
    });
    expect(cancelled.status).toBe(409);
    expect((await meetings.get(meeting.id))?.title).toBe('Planning');
  });

  it('cancels a scheduled meeting and takes its row and seat claim with it', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const member = await signIn(store, 'Member');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.user.id, role: 'member' });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Planning',
      status: 'scheduled',
      scheduledFor: future(),
    });
    await store.enterSeat({
      session: {
        tokenHash: 'seat-holder',
        kind: 'user',
        role: null,
        meetingCode: null,
        meetingId: meeting.id,
        userId: owner.user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
      meetingId: meeting.id,
      role: 'seat-1',
    });
    expect(await store.seatHeldBy({ meetingId: meeting.id, role: 'seat-1', holder: 'seat-holder' })).toBe(true);

    expect(
      (
        await request(base, `/api/meetings/${meeting.id}`, {
          method: 'DELETE',
          cookie: member.cookie,
        })
      ).status,
    ).toBe(403);

    const cancelled = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(cancelled.status).toBe(200);
    expect(await meetings.get(meeting.id)).toBeUndefined();
    expect(await store.seatHeldBy({ meetingId: meeting.id, role: 'seat-1', holder: 'seat-holder' })).toBe(false);
  });

  it('refuses to cancel an open meeting but ends it from the list', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const admin = await signIn(store, 'Admin');
    const member = await signIn(store, 'Member');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: admin.user.id, role: 'admin' });
    await store.addWorkspaceMember({ workspaceId: team.workspace.id, userId: member.user.id, role: 'member' });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Open now',
    });

    expect(
      (await request(base, `/api/meetings/${meeting.id}`, { method: 'DELETE', cookie: owner.cookie })).status,
    ).toBe(409);
    expect(
      (await request(base, `/api/meetings/${meeting.id}/end`, { method: 'POST', cookie: member.cookie })).status,
    ).toBe(403);

    const ended = await request(base, `/api/meetings/${meeting.id}/end`, {
      method: 'POST',
      cookie: admin.cookie,
    });
    expect(ended.status).toBe(200);
    expect((await meetings.get(meeting.id))?.status).toBe('ended');
    expect((await meetings.get(meeting.id))?.endedAt).not.toBeNull();
  });

  it('will not end a scheduled meeting and says to cancel it instead', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const meeting = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Later',
      status: 'scheduled',
      scheduledFor: future(),
    });

    const response = await request(base, `/api/meetings/${meeting.id}/end`, {
      method: 'POST',
      cookie: owner.cookie,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'This meeting is scheduled. Cancel it instead.',
    );
  });

  it('keeps the pace chosen when the meeting was created', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const pace = { quietCheckAfter: 90, comingUpBefore: 45 };

    const response = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: owner.cookie,
      body: { workspaceId: team.workspace.id, title: 'Paced', pace },
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect((await meetings.get(id))?.pace).toEqual(pace);
  });

  it('shows a past scheduled meeting as not started and counts each meeting’s to-dos', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const overdue = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Overdue',
      status: 'scheduled',
      scheduledFor: past(),
    });
    const ended = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Finished',
    });
    await meetings.markEnded?.(ended.id, '2026-11-20T10:00:00.000Z');
    await meetings.saveMinutes?.(ended.id, {
      minutes: 'We agreed.',
      todos: [
        { id: 'task-1', title: 'One', owner: 'Ada', status: 'SUGGESTED', done: false },
        { id: 'task-2', title: 'Two', owner: 'Ben', status: 'SUGGESTED', done: true },
      ],
    });

    const response = await request(base, `/api/workspaces/${team.workspace.id}`, {
      cookie: owner.cookie,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      meetings: Array<{ id: string; status: string; todoCount: number }>;
      counts: { todos: number };
    };
    const overdueRow = body.meetings.find((meeting) => meeting.id === overdue.id);
    const endedRow = body.meetings.find((meeting) => meeting.id === ended.id);
    // Never started, so it stays scheduled (the UI shows "Didn't start"); the clock does not open it.
    expect(overdueRow?.status).toBe('scheduled');
    expect(endedRow).toMatchObject({ status: 'ended', todoCount: 2 });
    expect(body.counts.todos).toBe(2);
  });

  it('keeps an overdue meeting that never started editable and cancellable', async () => {
    const { base, store, meetings } = await buildApp();
    const owner = await signIn(store, 'Owner');
    const team = await store.createWorkspace({ name: 'Team', createdBy: owner.user.id });
    const overdue = await meetings.create({
      workspaceId: team.workspace.id,
      ownerUserId: owner.user.id,
      title: 'Never started',
      status: 'scheduled',
      scheduledFor: past(),
    });

    const edited = await request(base, `/api/meetings/${overdue.id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: { title: 'Still editable' },
    });
    expect(edited.status).toBe(200);
    expect((await meetings.get(overdue.id))?.title).toBe('Still editable');

    const cancelled = await request(base, `/api/meetings/${overdue.id}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(cancelled.status).toBe(200);
    expect(await meetings.get(overdue.id)).toBeUndefined();
  });
});
