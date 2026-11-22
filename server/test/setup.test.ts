import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMeetingScenario, parseScenario, type MeetingSetup, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { createTestApp, portOf } from './helpers';
import { testScenario } from './fixtures/scenario';

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

describe('scenario shown for a touched draft', () => {
  const scenarioWithPairs: Scenario = {
    id: 'test-pairs',
    organisation: 'Test Kitchen',
    meetingTitle: 'Lunch service readiness',
    roles: [
      { id: 'chef', label: 'Chef' },
      { id: 'cashier', label: 'Cashier' },
    ],
    attendees: [
      { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
      { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
    ],
    agenda: [
      {
        title: 'Prep',
        minutes: 5,
        canWait: false,
        deadline: 'before service',
        ownerRole: 'chef',
        links: [{ with: 'Restock', effect: 'Restocking waits until prep is done.' }],
      },
      { title: 'Restock', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'cashier' },
      { title: 'Service', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' },
    ],
    excludedPairs: [
      ['Prep', 'Restock'],
      ['Restock', 'Service'],
    ],
  };
  let app: KakiApp;
  let base: string;

  beforeEach(async () => {
    app = await createApp({ scenario: scenarioWithPairs, speechRecognition: 'browser', roomRoster: async () => [] });
    base = `http://127.0.0.1:${portOf(app)}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('drops excluded pairs and links that named an agenda item the draft removed', async () => {
    const loaded = await fetch(`${base}/api/setup`);
    expect(loaded.status).toBe(200);
    const { setup } = (await loaded.json()) as SetupResponse;
    setup.title = 'Friday lunch readiness';
    setup.source.title = 'typed';
    setup.agenda = [setup.agenda[0]!];
    const saved = await fetch(`${base}/api/setup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setup),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(`${base}/api/scenario`);
    expect(response.status).toBe(200);
    const visible = (await response.json()) as Scenario;
    expect(() => parseScenario(visible)).not.toThrow();
    expect(visible.agenda.map((item) => item.title)).toEqual(['Prep']);
    expect(visible.excludedPairs).toBeUndefined();
    expect(visible.agenda[0]?.links).toBeUndefined();
  });

  it('keeps the live agenda while the draft is blank', async () => {
    const blank = await fetch(`${base}/api/setup/blank`, { method: 'POST' });
    expect(blank.status).toBe(200);

    const response = await fetch(`${base}/api/scenario`);
    expect(response.status).toBe(200);
    const visible = (await response.json()) as Scenario;
    expect(() => parseScenario(visible)).not.toThrow();
    expect(visible.agenda.map((item) => item.title)).toEqual(scenarioWithPairs.agenda.map((item) => item.title));
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

describe('scenario after an ended team meeting', () => {
  let app: KakiApp;
  let base: string;

  beforeEach(async () => {
    const store = createMemoryAuthStore();
    await store.createUser({
      email: 'host@example.com',
      passwordHash: await hashPassword('correct-horse-battery'),
    });
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier', 'runner'], meetingCode });
    app = await createTestApp({ auth, meetingCode, roomRoster: async () => [] });
    base = `http://127.0.0.1:${portOf(app)}`;
  });

  afterEach(async () => {
    await app.close();
  });

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

  it('serves the setup plan while the owner starts a blank plan after an ended meeting', async () => {
    const cookie = await signInAsHost();
    expect((await fetch(`${base}/api/meeting/open`, { method: 'POST', headers: { cookie } })).status).toBe(200);

    const loaded = await fetch(`${base}/api/setup`, { headers: { cookie } });
    expect(loaded.status).toBe(200);
    const { setup } = (await loaded.json()) as SetupResponse;
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.agenda.push({ id: 'agenda-2', title: 'Runner handover', minutes: 2, ownerRoleId: 'runner' });
    setup.seats.push({ displayName: 'Rina', roleId: 'runner', kind: 'person' });
    const saved = await fetch(`${base}/api/setup`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(setup),
    });
    expect(saved.status).toBe(200);

    const derived = deriveMeetingScenario(testScenario, setup);
    if (!derived.ok) throw new Error(`The setup should describe a meeting: ${JSON.stringify(derived.errors)}`);
    app.session.beginStart(derived.scenario, setup);
    app.session.commitStart(new Date().toISOString());
    app.session.end();
    // The owner has published the minutes: the ended review is over, and the next plan is blank.
    app.session.finishReview();

    const blank = await fetch(`${base}/api/setup/blank`, { method: 'POST', headers: { cookie } });
    expect(blank.status).toBe(200);

    const response = await fetch(`${base}/api/scenario`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const scenario = (await response.json()) as Scenario;
    expect(() => parseScenario(scenario)).not.toThrow();
    // The role the ended meeting used stays in the served plan while the blank draft has none.
    expect(scenario.roles.map((role) => role.id)).toContain('runner');
  });
});
