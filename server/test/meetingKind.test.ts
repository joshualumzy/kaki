import { afterEach, describe, expect, it } from 'vitest';
import { defaultMeetingSetup, joinSeatRoles, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { loadScenario } from '../src/core/loadScenario';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { portOf } from './helpers';

const CODE = 'K7M2Q9';
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
    meetingCode: createMeetingCodeSource(CODE),
    rejoinGraceMs: 60_000,
    rejoinPollMs: 20,
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function authModeApp(options: { roomRoster?: () => Promise<Array<{ name: string }>> } = {}): Promise<{
  app: KakiApp;
  port: number;
}> {
  const store = createMemoryAuthStore();
  await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
  const meetingCode = createMeetingCodeSource(CODE);
  const auth = createAuth({
    store,
    offeredRoles: () => joinSeatRoles(pack).map((role) => role.id),
    meetingCode,
  });
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    auth,
    meetingCode,
    serviceToken: TOKEN,
    roomRoster: options.roomRoster ?? (async () => []),
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    startAckTimeoutMs: 2_000,
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function loginHost(port: number): Promise<string> {
  return cookieFrom(
    await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
  );
}

describe('one practice meeting per visitor', () => {
  it('offers the pack seats on a visitor’s own practice meeting, whatever the owner draft says', async () => {
    const { app, port } = await authModeApp();
    const base = defaultMeetingSetup(pack);
    app.session.setDraft({
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

describe('the legacy demo meeting', () => {
  it('refuses a plain join until the owner opens, then records the meeting as real', async () => {
    const { app, port } = await openModeApp();

    const refused = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'No team meeting is open right now. Ask the meeting owner for the invite link.',
    );

    expect((await request(port, '/api/meeting/open', 'POST')).status).toBe(200);
    const legacy = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
    });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { started: boolean }).started).toBe(false);
    expect(app.session.kind()).toBe('real');
  });

  it('refuses a practice join: practice has its own page now', async () => {
    const { port } = await openModeApp();
    const refused = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Alice',
      participantRole: 'operations_director',
      kind: 'practice',
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('practice-moved');
  });

  it('joins, never resets, the meeting the owner just opened when a friend is first into the empty lobby', async () => {
    let people: Array<{ name: string }> = [];
    const { app, port } = await authModeApp({ roomRoster: async () => people });
    const host = await loginHost(port);
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const generation = app.session.generation();
    const meetingId = app.session.snapshot().meetingId;

    // The owner is still on /setup: nobody is seated yet, so the room reads empty. The first
    // friend with the code joins that meeting; a reset here would wipe the opened lobby.
    const friend = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Cara',
      participantRole: 'operations_director',
      meetingCode: CODE,
    });
    expect(friend.status).toBe(200);
    expect(app.session.kind()).toBe('real');
    expect(app.session.phase()).toBe('lobby');
    expect(app.session.generation()).toBe(generation);
    expect(app.session.snapshot().meetingId).toBe(meetingId);
    expect(app.session.holders().map((holder) => holder.name)).toEqual(['cara']);
    people = [];
  });
});
