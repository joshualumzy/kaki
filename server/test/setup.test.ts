import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingSetup, Scenario } from '@kaki/shared';
import type { KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { createMeetingCodeSource } from '../src/meetingCode';
import { createTestApp, portOf } from './helpers';

interface SetupResponse {
  setup: MeetingSetup;
  started: boolean;
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  return pair === undefined || pair === '' ? undefined : pair;
}

describe('setup API', () => {
  let app: KakiApp;
  let base: string;

  beforeEach(async () => {
    app = await createTestApp({ roomRoster: async () => [] });
    base = `http://127.0.0.1:${portOf(app)}`;
  });

  afterEach(async () => {
    await app.close();
  });

  async function getSetup(): Promise<SetupResponse> {
    const response = await fetch(`${base}/api/setup`);
    expect(response.status).toBe(200);
    return (await response.json()) as SetupResponse;
  }

  function putSetup(setup: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base}/api/setup`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(setup),
    });
  }

  it('serves the scenario default before anyone edits it', async () => {
    const { setup, started } = await getSetup();
    expect(started).toBe(false);
    expect(setup.title).toBe('Lunch service readiness');
    expect(setup.source.title).toBe('demo pack');
    expect(setup.agenda).toHaveLength(1);
    expect(setup.seats).toEqual([
      { displayName: 'Ada', roleId: 'chef', kind: 'person' },
      { displayName: 'Bao', roleId: 'cashier', kind: 'person' },
    ]);
  });

  it('stores a valid edited setup', async () => {
    const { setup } = await getSetup();
    setup.title = 'Friday lunch readiness';
    setup.source.title = 'typed';

    const response = await putSetup(setup);
    expect(response.status).toBe(200);
    const stored = (await response.json()) as SetupResponse;
    expect(stored.setup.title).toBe('Friday lunch readiness');
    expect((await getSetup()).setup.title).toBe('Friday lunch readiness');
  });

  it('shows the saved plan title and person seats before the meeting starts', async () => {
    const { setup } = await getSetup();
    setup.title = 'Friday lunch readiness';
    setup.source.title = 'typed';
    setup.roles = setup.roles.map((role, index) => ({
      ...role,
      label: index === 0 ? 'Owner' : 'Ana',
    }));
    expect((await putSetup(setup)).status).toBe(200);

    const response = await fetch(`${base}/api/scenario`);
    expect(response.status).toBe(200);
    const scenario = (await response.json()) as Scenario;
    expect(scenario.meetingTitle).toBe('Friday lunch readiness');
    expect(scenario.joinSeats).toEqual(setup.roles.map((role) => role.id));
    expect(scenario.roles.map((role) => role.label)).toEqual(['Owner', 'Ana']);
    expect(scenario.agenda.map((item) => item.title)).toEqual(setup.agenda.map((item) => item.title));
  });

  it('returns field-specific errors and keeps the previous draft', async () => {
    const { setup } = await getSetup();
    setup.agenda[0]!.minutes = 0;

    const response = await putSetup(setup);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      errors: Array<{ field: string; message: string }>;
    };
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'agenda[0].minutes' }),
    );
    expect((await getSetup()).setup.agenda[0]!.minutes).toBe(5);
  });

  it('refuses changes after the meeting has started', async () => {
    expect((await fetch(`${base}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const joined = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Cook', participantRole: 'chef' }),
    });
    expect(joined.status).toBe(200);
    const started = await fetch(`${base}/api/meeting/start`, { method: 'POST' });
    expect(started.status).toBe(200);

    const { setup } = await getSetup();
    const response = await putSetup(setup);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The meeting has started; setup can't change now.",
    });
  });

  it('keeps an unconsumed edited draft across a new meeting', async () => {
    const { setup } = await getSetup();
    setup.title = 'Edited before reset';
    setup.source.title = 'typed';
    expect((await putSetup(setup)).status).toBe(200);

    app.session.reset();

    expect((await getSetup()).setup.title).toBe('Edited before reset');
  });
});

describe('setup authorization', () => {
  const MEETING_CODE = 'K7M2Q9';
  let app: KakiApp;
  let base: string;

  beforeEach(async () => {
    const store = createMemoryAuthStore();
    await store.createUser({
      email: 'host@example.com',
      passwordHash: await hashPassword('correct-horse-battery'),
    });
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createTestApp({ auth, meetingCode });
    base = `http://127.0.0.1:${portOf(app)}`;
  });

  afterEach(async () => {
    await app.close();
  });

  async function getSetup(cookie?: string): Promise<Response> {
    return fetch(
      `${base}/api/setup`,
      cookie === undefined ? undefined : { headers: { cookie } },
    );
  }

  function putSetup(setup: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base}/api/setup`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(setup),
    });
  }

  async function signInAsHost(): Promise<string> {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'host@example.com', password: 'correct-horse-battery' }),
    });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Login did not set a cookie');
    return cookie;
  }

  async function joinAs(role: string): Promise<string> {
    const host = await signInAsHost();
    expect((await fetch(`${base}/api/meeting/open`, { method: 'POST', headers: { cookie: host } })).status).toBe(200);
    const response = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: MEETING_CODE, role }),
    });
    expect(response.status).toBe(200);
    const cookie = cookieFrom(response);
    if (cookie === undefined) throw new Error('Join did not set a cookie');
    return cookie;
  }

  it('lets the host edit and a participant only read', async () => {
    const participant = await joinAs('chef');
    const read = await getSetup(participant);
    expect(read.status).toBe(200);
    const { setup } = (await read.json()) as SetupResponse;

    const refused = await putSetup(setup, participant);
    expect(refused.status).toBe(403);

    const host = await signInAsHost();
    const allowed = await putSetup(setup, host);
    expect(allowed.status).toBe(200);
  });

  it('refuses an anonymous reader when auth is on', async () => {
    expect((await getSetup()).status).toBe(401);
  });
});
