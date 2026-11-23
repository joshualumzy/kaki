import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMeetingSetup, joinSeatRoles, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword, hashToken } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { loadScenario } from '../src/core/loadScenario';
import { meetingPath, openRealMeeting, portOf } from './helpers';

const TOKEN = 'local-test-runner-token';
const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'host-password';
const pack: Scenario = await loadScenario('kopitiam');

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

async function request(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function openModeApp(options: { roomRoster?: () => Promise<Array<{ name: string }>> } = {}): Promise<{
  app: KakiApp;
  port: number;
}> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    roomRoster: options.roomRoster ?? (async () => []),
    rejoinGraceMs: 60_000,
    rejoinPollMs: 20,
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function authModeApp(options: { roomRoster?: () => Promise<Array<{ name: string }>> } = {}): Promise<{
  app: KakiApp;
  port: number;
  store: ReturnType<typeof createMemoryAuthStore>;
}> {
  const store = createMemoryAuthStore();
  await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
  const auth = createAuth({
    store,
    offeredRoles: () => joinSeatRoles(pack).map((role) => role.id),
  });
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    auth,
    serviceToken: TOKEN,
    roomRoster: options.roomRoster ?? (async () => []),
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    startAckTimeoutMs: 2_000,
  });
  apps.push(app);
  return { app, port: portOf(app), store };
}

/** A signed-in product account; a real meeting's owner is an account, not a password host. */
async function signInGoogle(store: ReturnType<typeof createMemoryAuthStore>): Promise<{
  userId: string;
  cookie: string;
}> {
  const email = `${randomUUID()}@example.com`;
  const user = await store.createGoogleUser({ googleSub: randomUUID(), name: 'Ada', email });
  const token = randomUUID();
  await store.createSession({
    tokenHash: hashToken(token),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: 'Ada',
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { userId: user.id, cookie: `kaki_session=${token}` };
}

describe('one practice meeting per visitor', () => {
  it('offers the pack seats on a visitor’s own practice meeting, whatever the owner draft says', async () => {
    const { app, port } = await authModeApp();
    const base = defaultMeetingSetup(pack);
    const real = await openRealMeeting(app, { title: 'Owner draft' });
    real.session.setDraft({
      ...base,
      roles: [{ id: 'owner_only', label: 'Owner only', facilitator: false }],
      seats: [{ displayName: 'Only', roleId: 'owner_only', kind: 'person' }],
      agenda: [{ id: 'agenda-1', title: 'Only item', minutes: 5, ownerRoleId: 'owner_only' }],
    });

    const created = await request(port, '/api/practice', 'POST');
    expect(created.status).toBe(200);
    const { meetingId } = (await created.json()) as { meetingId: string };
    const response = await request(port, `/api/meetings/${meetingId}/scenario?kind=practice`);
    expect(response.status).toBe(200);
    const offered = joinSeatRoles((await response.json()) as Scenario).map((role) => role.id);
    expect(offered).toEqual(joinSeatRoles(pack).map((role) => role.id));
    expect(offered).not.toContain('owner_only');
  });

  it('keeps who has joined off the public state and off the visitor’s owner route', async () => {
    const { app, port } = await authModeApp();
    const created = await request(port, '/api/practice', 'POST');
    const cookie = cookieFrom(created);
    const { meetingId } = (await created.json()) as { meetingId: string };
    const joined = await request(
      port,
      `/api/meetings/${meetingId}/livekit/token`,
      'POST',
      { participantName: 'Alice', participantRole: 'operations_director', kind: 'practice' },
      cookie,
    );
    expect(joined.status).toBe(200);

    const publicState = (await (
      await request(port, `/api/meetings/${meetingId}/meeting/state`)
    ).json()) as Record<string, unknown>;
    expect(publicState).not.toHaveProperty('participants');
    expect((await request(port, `/api/meetings/${meetingId}/meeting/participants`)).status).toBe(401);
    // A practice visitor is not the meeting owner: the participants list stays closed to them.
    expect(
      (await request(port, `/api/meetings/${meetingId}/meeting/participants`, 'GET', undefined, cookie)).status,
    ).toBe(403);
    expect(app.registry.findPractice(meetingId)?.session.holders()).toHaveLength(1);
  });
});

describe('a real meeting refuses a practice join', () => {
  it('refuses a practice join: practice has its own page now', async () => {
    const { app, port } = await openModeApp();
    const meeting = await openRealMeeting(app);
    const refused = await request(port, meetingPath(meeting, '/api/livekit/token'), 'POST', {
      participantName: 'Alice',
      kind: 'practice',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'This is a real meeting; practice has its own page.',
    );
  });
});

describe('a real meeting keeps its opened lobby', () => {
  it('joins, never resets, the meeting the owner just opened when a friend is first into the empty lobby', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port, store } = await authModeApp({ roomRoster: async () => people });
    const owner = await signInGoogle(store);
    const meeting = await openRealMeeting(app, { ownerUserId: owner.userId, title: 'Test meeting' });
    expect((await request(port, meetingPath(meeting, '/api/meeting/open'), 'POST', undefined, owner.cookie)).status).toBe(200);
    const generation = meeting.session.generation();
    const meetingId = meeting.session.snapshot().meetingId;

    // The owner is still on /setup: nobody is seated yet, so the room reads empty. The first
    // friend joins that meeting; a reset here would wipe the opened lobby.
    const joined = await request(port, meetingPath(meeting, '/join'), 'POST', { name: 'Cara' });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    const friend = await request(
      port,
      meetingPath(meeting, '/api/livekit/token'),
      'POST',
      { participantName: 'Cara' },
      guest,
    );
    expect(friend.status).toBe(200);
    expect(meeting.session.kind()).toBe('real');
    expect(meeting.session.phase()).toBe('lobby');
    expect(meeting.session.generation()).toBe(generation);
    expect(meeting.session.snapshot().meetingId).toBe(meetingId);
    expect(meeting.session.holders().map((holder) => holder.name)).toEqual(['cara']);
    people = [];
  });
});
