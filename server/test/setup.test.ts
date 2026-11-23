import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMeetingScenario, parseScenario, type MeetingSetup, type Scenario } from '@kaki/shared';
import type { KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { realBaseScenario } from '../src/meeting/realMeeting';
import type { MeetingRow } from '../src/meeting/types';
import {
  createPracticeTestApp,
  createRealTestApp,
  createTestApp,
  meetingUrl,
  type TestAppWithMeeting,
} from './helpers';
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

/** A signed-in product account; a real meeting's owner is an account, not a password host. */
async function signInGoogle(store: AuthStore, name: string): Promise<{ userId: string; cookie: string }> {
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
  return { userId: user.id, cookie: `kaki_session=${token}` };
}

interface RealSetup {
  app: TestAppWithMeeting;
  row: MeetingRow;
  ownerCookie: string;
}

async function realAuthApp(store: AuthStore): Promise<RealSetup> {
  const owner = await signInGoogle(store, 'Ada Owner');
  const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier']});
  const app = (await createTestApp({
    auth,
    roomRoster: async () => [],
  })) as TestAppWithMeeting;
  const row = await app.registry.create({
    workspaceId: 'workspace-1',
    ownerUserId: owner.userId,
    title: 'Lunch service readiness',
    agenda: testScenario.agenda.map((item) => ({
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: 'everyone',
    })),
  });
  const instance = await app.registry.get(row.id);
  if (instance === undefined) throw new Error(`the real meeting ${row.id} did not load`);
  Object.assign(app, {
    id: instance.id,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
    meetingId: row.id,
  });
  return { app, row, ownerCookie: owner.cookie };
}

describe('setup API', () => {
  let app: TestAppWithMeeting;
  let meetings: KakiApp[];

  beforeEach(async () => {
    meetings = [];
    app = await createPracticeTestApp({ roomRoster: async () => [] });
    meetings.push(app);
  });

  afterEach(async () => {
    for (const meeting of meetings.splice(0)) await meeting.close();
  });

  async function getSetup(): Promise<SetupResponse> {
    const response = await fetch(meetingUrl(app, app.meetingId, '/api/setup'));
    expect(response.status).toBe(200);
    return (await response.json()) as SetupResponse;
  }

  function putSetup(setup: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
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
    const joined = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie! },
      body: JSON.stringify({ participantName: 'Cook', participantRole: 'chef', kind: 'practice' }),
    });
    expect(joined.status).toBe(200);
    const started = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
      method: 'POST',
      headers: { cookie: app.cookie! },
    });
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

describe('a saved plan shown before the meeting starts', () => {
  it('shows the saved plan title and person seats', async () => {
    const app = await createRealTestApp(
      { roomRoster: async () => [] },
      { title: 'Lunch service readiness', agenda: [{ title: 'Prep', minutes: 5 }] },
    );
    const meetings: KakiApp[] = [app];
    try {
      const loaded = await fetch(meetingUrl(app, app.meetingId, '/api/setup'));
      expect(loaded.status).toBe(200);
      const { setup } = (await loaded.json()) as SetupResponse;
      setup.title = 'Friday lunch readiness';
      setup.source.title = 'typed';
      setup.roles = setup.roles.map((role, index) => ({
        ...role,
        label: index === 0 ? 'Owner' : 'Ana',
      }));
      const saved = await fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(setup),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario'));
      expect(response.status).toBe(200);
      const scenario = (await response.json()) as Scenario;
      expect(scenario.meetingTitle).toBe('Friday lunch readiness');
      expect(scenario.joinSeats).toEqual(setup.seats.map((seat) => seat.roleId));
      expect(scenario.roles.map((role) => role.label)).toEqual(['Owner', 'Ana']);
      expect(scenario.agenda.map((item) => item.title)).toEqual(setup.agenda.map((item) => item.title));
    } finally {
      for (const meeting of meetings.splice(0)) await meeting.close();
    }
  });
});

describe('scenario shown for a touched draft', () => {
  const agenda = [
    { title: 'Prep', minutes: 5 },
    { title: 'Restock', minutes: 5 },
    { title: 'Service', minutes: 5 },
  ];
  let app: TestAppWithMeeting;
  let meetings: KakiApp[];

  beforeEach(async () => {
    meetings = [];
    app = await createRealTestApp(
      { roomRoster: async () => [] },
      { title: 'Lunch service readiness', agenda },
    );
    meetings.push(app);
  });

  afterEach(async () => {
    for (const meeting of meetings.splice(0)) await meeting.close();
  });

  it('drops agenda items the draft removed from the visible plan', async () => {
    const loaded = await fetch(meetingUrl(app, app.meetingId, '/api/setup'));
    expect(loaded.status).toBe(200);
    const { setup } = (await loaded.json()) as SetupResponse;
    setup.title = 'Friday lunch readiness';
    setup.source.title = 'typed';
    setup.agenda = [setup.agenda[0]!];
    const saved = await fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setup),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario'));
    expect(response.status).toBe(200);
    const visible = (await response.json()) as Scenario;
    expect(() => parseScenario(visible, { requireOrganisation: false })).not.toThrow();
    expect(visible.agenda.map((item) => item.title)).toEqual(['Prep']);
    expect(visible.excludedPairs).toBeUndefined();
    expect(visible.agenda[0]?.links).toBeUndefined();
  });

  it('keeps the live agenda while the draft is blank', async () => {
    const blank = await fetch(meetingUrl(app, app.meetingId, '/api/setup/blank'), { method: 'POST' });
    expect(blank.status).toBe(200);

    const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario'));
    expect(response.status).toBe(200);
    const visible = (await response.json()) as Scenario;
    expect(() => parseScenario(visible, { requireOrganisation: false })).not.toThrow();
    expect(visible.agenda.map((item) => item.title)).toEqual(agenda.map((item) => item.title));
  });
});

describe('setup authorization', () => {
  let store: AuthStore;
  let app: TestAppWithMeeting;
  let ownerCookie: string;
  let meetings: KakiApp[];

  beforeEach(async () => {
    meetings = [];
    store = createMemoryAuthStore();
    ({ app, ownerCookie } = await realAuthApp(store));
    meetings.push(app);
  });

  afterEach(async () => {
    for (const meeting of meetings.splice(0)) await meeting.close();
  });

  async function getSetup(cookie?: string): Promise<Response> {
    return fetch(
      meetingUrl(app, app.meetingId, '/api/setup'),
      cookie === undefined ? undefined : { headers: { cookie } },
    );
  }

  function putSetup(setup: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
      method: 'PUT',
      headers,
      body: JSON.stringify(setup),
    });
  }

  async function joinAsGuest(name: string): Promise<string> {
    const joined = await fetch(meetingUrl(app, app.meetingId, '/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    if (guest === undefined) throw new Error('Guest join did not set a cookie');
    const seated = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guest },
      body: JSON.stringify({ participantName: name }),
    });
    expect(seated.status).toBe(200);
    const participant = cookieFrom(seated);
    if (participant === undefined) throw new Error('Taking a seat did not set a cookie');
    return participant;
  }

  it('lets the host edit and a participant only read', async () => {
    const participant = await joinAsGuest('Bao');
    const read = await getSetup(participant);
    expect(read.status).toBe(200);
    const { setup } = (await read.json()) as SetupResponse;

    const refused = await putSetup(setup, participant);
    expect(refused.status).toBe(403);

    const allowed = await putSetup(setup, ownerCookie);
    expect(allowed.status).toBe(200);
  });

  it('refuses an anonymous reader when auth is on', async () => {
    expect((await getSetup()).status).toBe(401);
  });
});

describe('scenario after an ended team meeting', () => {
  let store: AuthStore;
  let app: TestAppWithMeeting;
  let row: MeetingRow;
  let ownerCookie: string;
  let meetings: KakiApp[];

  beforeEach(async () => {
    meetings = [];
    store = createMemoryAuthStore();
    ({ app, row, ownerCookie } = await realAuthApp(store));
    meetings.push(app);
  });

  afterEach(async () => {
    for (const meeting of meetings.splice(0)) await meeting.close();
  });

  it('serves the setup plan while the owner starts a blank plan after an ended meeting', async () => {
    expect((await fetch(meetingUrl(app, app.meetingId, '/api/meeting/open'), {
      method: 'POST',
      headers: { cookie: ownerCookie },
    })).status).toBe(200);

    const loaded = await fetch(meetingUrl(app, app.meetingId, '/api/setup'), { headers: { cookie: ownerCookie } });
    expect(loaded.status).toBe(200);
    const { setup } = (await loaded.json()) as SetupResponse;
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.agenda.push({ id: 'agenda-2', title: 'Runner handover', minutes: 2, ownerRoleId: 'runner' });
    setup.seats.push({ displayName: 'Rina', roleId: 'runner', kind: 'person' });
    const saved = await fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify(setup),
    });
    expect(saved.status).toBe(200);

    const derived = deriveMeetingScenario(realBaseScenario(row), setup);
    if (!derived.ok) throw new Error(`The setup should describe a meeting: ${JSON.stringify(derived.errors)}`);
    app.session.beginStart(derived.scenario, setup);
    app.session.commitStart(new Date().toISOString());
    app.session.end();
    // The owner has published the minutes: the ended review is over, and the next plan is blank.
    app.session.finishReview();

    const blank = await fetch(meetingUrl(app, app.meetingId, '/api/setup/blank'), {
      method: 'POST',
      headers: { cookie: ownerCookie },
    });
    expect(blank.status).toBe(200);

    const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario'), { headers: { cookie: ownerCookie } });
    expect(response.status).toBe(200);
    const scenario = (await response.json()) as Scenario;
    expect(() => parseScenario(scenario, { requireOrganisation: false })).not.toThrow();
    // The role the ended meeting used stays in the served plan while the blank draft has none.
    expect(scenario.roles.map((role) => role.id)).toContain('runner');
  });
});
