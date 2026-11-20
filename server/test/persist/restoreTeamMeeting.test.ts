import { afterEach, describe, expect, it } from 'vitest';
import {
  blankMeetingSetup,
  defaultMeetingSetup,
  parseScenario,
  type MeetingSetup,
} from '@kaki/shared';
import { createApp, type KakiApp, type CreateAppOptions } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingModule } from '../../src/host/meeting';
import { createMeetingCodeSource } from '../../src/meetingCode';
import { createMeetingPersistence } from '../../src/persist/persistence';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from '../../src/persist/postgres';
import {
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import { connectClient, portOf, waitForEvent, type TestClient } from '../helpers';
import { testScenario } from '../fixtures/scenario';
import { createPostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

const HOST_EMAIL = 'owner@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';

class MemoryStore implements MeetingStateStore {
  saved: StoredMeeting | undefined;

  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }

  async save(meeting: StoredMeeting): Promise<void> {
    this.saved = meeting;
  }

  async clear(): Promise<void> {
    this.saved = undefined;
  }
}

/** A plan a real team typed from a blank setup: its own roles, topics and people, no pack cast. */
function teamSetup(): MeetingSetup {
  return {
    ...blankMeetingSetup(),
    title: 'Team playtest meeting',
    roles: [
      { id: 'role_1', label: 'Role one', facilitator: false },
      { id: 'role_2', label: 'Role two', facilitator: false },
    ],
    agenda: [
      { id: 'agenda-1', title: 'Topic one', minutes: 5, ownerRoleId: 'role_1' },
      { id: 'agenda-2', title: 'Topic two', minutes: 5, ownerRoleId: 'role_2' },
    ],
    seats: [
      { displayName: 'Mira', roleId: 'role_1', kind: 'person' },
      { displayName: 'Noah', roleId: 'role_2', kind: 'person' },
    ],
  };
}

const apps: KakiApp[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.close();
});

function startApp(
  persistence: ReturnType<typeof createMeetingPersistence>,
  options: Omit<CreateAppOptions, 'scenario' | 'modules' | 'persistence'> = {},
): Promise<KakiApp> {
  return createApp({
    speechRecognition: 'browser',
    scenario: testScenario,
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    persistence,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...options,
  }).then((app) => {
    apps.push(app);
    return app;
  });
}

function baseUrl(app: KakiApp): string {
  return `http://127.0.0.1:${portOf(app)}`;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function hostAuth(): { auth: ReturnType<typeof createAuth>; store: ReturnType<typeof createMemoryAuthStore> } {
  const store = createMemoryAuthStore();
  const auth = createAuth({
    store,
    offeredRoles: () => ['role_1', 'role_2'],
    meetingCode: createMeetingCodeSource(MEETING_CODE),
  });
  return { auth, store };
}

/** Sign the owner in on the restarted app and keep their cookie for the private routes. */
async function hostCookie(
  app: KakiApp,
  store: ReturnType<typeof createMemoryAuthStore>,
): Promise<string> {
  await store.createUser({
    email: HOST_EMAIL,
    passwordHash: await hashPassword(HOST_PASSWORD),
  });
  const response = await post(
    `${baseUrl(app)}/api/auth/login`,
    { email: HOST_EMAIL, password: HOST_PASSWORD },
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('host login did not set a cookie');
  return cookie;
}

async function createMeeting(app: KakiApp, setup: MeetingSetup): Promise<void> {
  const base = baseUrl(app);
  expect(
    (
      await fetch(`${base}/api/setup`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(setup),
      })
    ).status,
  ).toBe(200);
  expect((await fetch(`${base}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
  const joined = await post(`${base}/api/livekit/token`, {
    participantName: 'Mira',
    participantRole: 'role_1',
  });
  expect(joined.status).toBe(200);
  expect((await fetch(`${base}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
}

async function endMeeting(app: KakiApp): Promise<void> {
  const screen = await connectClient(portOf(app), 'screen');
  clients.push(screen);
  screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
  await waitForEvent(
    screen,
    (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
    'the meeting to end',
  );
}

function expectOwnTeamScenario(scenario: unknown): void {
  const parsed = parseScenario(scenario, { requireOrganisation: false });
  expect(parsed.meetingTitle).toBe('Team playtest meeting');
  expect(parsed.roles.map((role) => role.id)).toEqual(expect.arrayContaining(['role_1', 'role_2']));
  expect(parsed.agenda.map((item) => `${item.title}:${item.ownerRole}`)).toEqual([
    'Topic one:role_1',
    'Topic two:role_2',
  ]);
  expect(parsed.attendees.map((attendee) => attendee.name).sort()).toEqual(['Mira', 'Noah']);
}

describe('restoring a real team meeting from its own setup', () => {
  it('serves the meeting it ran after END, and still offers the owner setup', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);
    await createMeeting(app1, teamSetup());
    await endMeeting(app1);
    // The owner starts the next meeting from a blank plan before the restart: the saved draft is
    // empty while the meeting that ran is still the one being reviewed.
    expect((await fetch(`${baseUrl(app1)}/api/setup/blank`, { method: 'POST' })).status).toBe(200);
    await first.flush();
    expect(store.saved?.phase).toBe('ended');
    expect(store.saved?.draft.title).toBe('');
    expect(store.saved?.sealed?.roles.map((role) => role.id)).toEqual(['role_1', 'role_2']);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const { auth, store: authStore } = hostAuth();
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { auth });
    const cookie = await hostCookie(app2, authStore);

    const scenarioResponse = await fetch(`${baseUrl(app2)}/api/scenario`, {
      headers: { cookie },
    });
    expect(scenarioResponse.status).toBe(200);
    expectOwnTeamScenario(await scenarioResponse.json());

    const setupResponse = await fetch(`${baseUrl(app2)}/api/setup`, {
      headers: { cookie },
    });
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as { setup: MeetingSetup; phase: string };
    expect(setup.phase).toBe('ended');
    // The blank next-meeting draft is reachable and editable; it never leaks into the live scenario.
    expect(setup.setup.title).toBe('');
    expect(app2.session.phase()).toBe('ended');
  });

  it('shows a screen after the restart that the ended meeting is over, not a running clock', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);
    await createMeeting(app1, teamSetup());
    await endMeeting(app1);
    await first.flush();
    expect(store.saved?.phase).toBe('ended');

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second);
    expect(app2.session.phase()).toBe('ended');

    // A screen that connects after the restart sees the frozen record marked ended, so the page
    // shows the meeting as over instead of a running clock with an "End meeting" button.
    const screen = await connectClient(portOf(app2), 'screen');
    clients.push(screen);
    const record = await waitForEvent(
      screen,
      (event) => event.type === 'MEETING_RECORD_UPDATED',
      'the restored meeting record',
    );
    expect(
      (record as Extract<typeof record, { type: 'MEETING_RECORD_UPDATED' }>).payload.ended,
    ).toBe(true);
  });

  it('serves the same own setup from a restart in the middle of the meeting', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);
    await createMeeting(app1, teamSetup());
    await first.flush();
    expect(store.saved?.phase).toBe('running');

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const { auth, store: authStore } = hostAuth();
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { auth });
    const cookie = await hostCookie(app2, authStore);

    const response = await fetch(`${baseUrl(app2)}/api/scenario`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expectOwnTeamScenario(await response.json());
    expect(app2.session.phase()).toBe('running');

    const setup = (await (
      await fetch(`${baseUrl(app2)}/api/setup`, { headers: { cookie } })
    ).json()) as { setup: MeetingSetup; started: boolean };
    expect(setup.started).toBe(true);
    expect(setup.setup.title).toBe('Team playtest meeting');
    expect(setup.setup.roles.map((role) => role.id)).toEqual(['role_1', 'role_2']);
  });

  it('restores a practice meeting from the pack, never from a team setup', async () => {
    const setup = defaultMeetingSetup(structuredClone(testScenario));
    const saved: StoredMeeting = {
      schemaVersion: MEETING_STATE_SCHEMA_VERSION,
      meetingId: 'practice-1',
      phase: 'running',
      kind: 'practice',
      sealedKind: 'practice',
      draft: setup,
      draftTouched: false,
      sealed: setup,
      holders: [{ name: 'ben', seat: 'chef' }],
      meetingCode: 'AB12CD',
      startedAt: '2026-01-01T00:00:00.000Z',
      savedAt: '2026-01-01T00:05:00.000Z',
      state: {
        clock: {
          started: true,
          ended: false,
          paused: false,
          agendaIndex: 0,
          itemElapsedSeconds: 30,
          meetingElapsedSeconds: 30,
        },
        notetaker: {
          pending: [],
          inFlight: [],
          recentGrounded: [],
          contextAgendaIndex: 0,
          agendaContext: [],
          openQuestions: [],
          questionCount: 0,
          status: 'ok',
          talkByItem: [],
          talkTotals: [],
          talkTotal: 0,
        },
        tasks: [],
      },
    };
    const store = new MemoryStore();
    store.saved = saved;
    const persistence = createMeetingPersistence({ store, saved, log: () => undefined });
    const app = await startApp(persistence);

    const response = await fetch(`${baseUrl(app)}/api/scenario?kind=practice`);
    expect(response.status).toBe(200);
    const scenario = parseScenario(await response.json());
    expect(scenario.meetingTitle).toBe(testScenario.meetingTitle);
    expect(scenario.roles.map((role) => role.id)).toEqual(testScenario.roles.map((role) => role.id));
  });
});

describe.skipIf(connectionString === undefined)('restoring a team meeting from Postgres', () => {
  it('serves the ended team meeting and its setup after a real store round trip', async () => {
    if (connectionString === undefined) throw new Error('POSTGRES_URL is missing');
    const postgres = await createPostgresTestSchema(connectionString);
    try {
      await ensureMeetingStateSchema(postgres.pool);
      const store = createPostgresMeetingStateStore(postgres.pool);
      const first = createMeetingPersistence({ store, log: () => undefined });
      const app1 = await startApp(first);
      await createMeeting(app1, teamSetup());
      await endMeeting(app1);
      await first.flush();
      expect((await store.load())?.phase).toBe('ended');

      await app1.close();
      apps.splice(apps.indexOf(app1), 1);

      const { auth, store: authStore } = hostAuth();
      const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
      const app2 = await startApp(second, { auth });
      const cookie = await hostCookie(app2, authStore);

      const response = await fetch(`${baseUrl(app2)}/api/scenario`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expectOwnTeamScenario(await response.json());
      expect((await fetch(`${baseUrl(app2)}/api/setup`, { headers: { cookie } })).status).toBe(200);
    } finally {
      await postgres.dispose();
    }
  });
});
