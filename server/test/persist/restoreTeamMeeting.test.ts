import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEETING_PACE, parseScenario, type MeetingSetup } from '@kaki/shared';
import type { CreateAppOptions, KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { createMeetingModule } from '../../src/host/meeting';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import type { MeetingRow } from '../../src/meeting/types';
import { createMeetingPersistence } from '../../src/persist/persistence';
import { createPostgresMeetingStateStore, ensureMeetingStateSchema } from '../../src/persist/postgres';
import type { MeetingStateStore, StoredMeeting } from '../../src/persist/state';
import {
  createPracticeTestApp,
  createTestApp,
  connectMeetingClient,
  meetingUrl,
  portOf,
  realModulesWith,
  waitFor,
  type TestAppWithMeeting,
  type TestMeeting,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';
import { createPostgresTestSchema } from '../postgresTestSchema';

const connectionString = process.env.POSTGRES_URL;

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

/** A plan a real team plays: its own title, topics and people, no pack cast. */
function teamRow(ownerUserId = 'test-owner'): Parameters<MeetingStore['create']>[0] {
  return {
    workspaceId: 'workspace-1',
    ownerUserId,
    title: 'Team playtest meeting',
    agenda: [
      { title: 'Topic one', minutes: 5 },
      { title: 'Topic two', minutes: 5 },
    ],
  };
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

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function startApp(
  meetings: MeetingStore,
  persistence: ReturnType<typeof createMeetingPersistence>,
  options: Omit<CreateAppOptions, 'scenario' | 'modules' | 'persistence'> = {},
): Promise<TestAppWithMeeting> {
  const app = (await createTestApp({
    speechRecognition: 'browser',
    scenario: testScenario,
    meetings,
    meetingModules: realModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    persistenceFor: async () => persistence,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...options,
  })) as TestAppWithMeeting;
  apps.push(app);
  return app;
}

function attach(app: TestAppWithMeeting, instance: TestMeeting, row: MeetingRow): void {
  Object.assign(app, {
    id: instance.id,
    instance: instance.instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
    meetingId: row.id,
  });
}

async function openMeeting(app: TestAppWithMeeting, row: MeetingRow): Promise<TestMeeting> {
  const instance = await app.registry.get(row.id);
  if (instance === undefined) throw new Error(`the real meeting ${row.id} did not load`);
  const meeting: TestMeeting = {
    id: instance.id,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
  };
  attach(app, meeting, row);
  return meeting;
}

async function joinPerson(app: TestAppWithMeeting, meeting: TestMeeting, name: string): Promise<string> {
  const response = await fetch(meetingUrl(app, meeting.id, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantName: name }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { participantRole: string }).participantRole;
}

async function startMeeting(app: TestAppWithMeeting, meeting: TestMeeting): Promise<string[]> {
  const seats = [
    await joinPerson(app, meeting, 'Mira'),
    await joinPerson(app, meeting, 'Noah'),
  ];
  const started = await fetch(meetingUrl(app, meeting.id, '/api/meeting/start'), { method: 'POST' });
  expect(started.status).toBe(200);
  return seats;
}

async function endMeeting(app: TestAppWithMeeting, meeting: TestMeeting): Promise<void> {
  const screen = await connectMeetingClient(portOf(app), meeting.id);
  screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
  await waitFor(() => (meeting.session.phase() === 'ended' ? true : undefined), 'the meeting to end');
  screen.close();
}

function expectOwnTeamScenario(scenario: unknown, seats: string[]): void {
  const parsed = parseScenario(scenario, { requireOrganisation: false });
  expect(parsed.meetingTitle).toBe('Team playtest meeting');
  expect(parsed.roles.map((role) => role.id)).toEqual(expect.arrayContaining(seats));
  expect(parsed.agenda.map((item) => item.title)).toEqual(['Topic one', 'Topic two']);
  expect(parsed.attendees.map((attendee) => attendee.name).sort()).toEqual(['Mira', 'Noah']);
}

describe('restoring a real team meeting from its own setup', () => {
  it('serves the meeting it ran after END, and still offers the owner setup', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const authStore = createMemoryAuthStore();
    const owner = await signInGoogle(authStore, 'Ada Owner');
    const row = await meetings.create(teamRow(owner.userId));
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(meetings, first);
    const meeting1 = await openMeeting(app1, row);
    const seats = await startMeeting(app1, meeting1);
    await endMeeting(app1, meeting1);
    // The owner starts the next meeting from a blank plan before the restart: the saved draft is
    // empty while the meeting that ran is still the one being reviewed.
    expect((await fetch(meetingUrl(app1, meeting1.id, '/api/setup/blank'), { method: 'POST' })).status).toBe(200);
    await first.flush();
    expect(store.saved?.phase).toBe('ended');
    expect(store.saved?.draft.title).toBe('');
    expect(store.saved?.sealed?.roles.map((role) => role.id)).toEqual(expect.arrayContaining(seats));

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const auth = createAuth({
      store: authStore,
      offeredRoles: () => seats,
    });
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(meetings, second, { auth });
    const meeting2 = await openMeeting(app2, row);

    const scenarioResponse = await fetch(meetingUrl(app2, meeting2.id, '/api/scenario'), {
      headers: { cookie: owner.cookie },
    });
    expect(scenarioResponse.status).toBe(200);
    expectOwnTeamScenario(await scenarioResponse.json(), seats);

    const setupResponse = await fetch(meetingUrl(app2, meeting2.id, '/api/setup'), {
      headers: { cookie: owner.cookie },
    });
    expect(setupResponse.status).toBe(200);
    const setup = (await setupResponse.json()) as { setup: MeetingSetup; phase: string };
    expect(setup.phase).toBe('ended');
    // The blank next-meeting draft is reachable and editable; it never leaks into the live scenario.
    expect(setup.setup.title).toBe('');
    expect(meeting2.session.phase()).toBe('ended');
  });

  it('shows a screen after the restart that the ended meeting is over, not a running clock', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create(teamRow());
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(meetings, first);
    const meeting1 = await openMeeting(app1, row);
    await startMeeting(app1, meeting1);
    await endMeeting(app1, meeting1);
    await first.flush();
    expect(store.saved?.phase).toBe('ended');

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(meetings, second);
    const meeting2 = await openMeeting(app2, row);

    // A screen that connects after the restart sees the frozen record marked ended, so the page
    // shows the meeting as over instead of a running clock with an "End meeting" button.
    const screen = await connectMeetingClient(portOf(app2), meeting2.id);
    const record = await waitFor(
      () => screen.messages.find((event) => event.type === 'MEETING_RECORD_UPDATED'),
      'the restored meeting record',
    );
    expect(
      (record as Extract<typeof record, { type: 'MEETING_RECORD_UPDATED' }>).payload.ended,
    ).toBe(true);
    screen.close();
  });

  it('serves the same own setup from a restart in the middle of the meeting', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const authStore = createMemoryAuthStore();
    const owner = await signInGoogle(authStore, 'Ada Owner');
    const row = await meetings.create({ ...teamRow(owner.userId) });
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(meetings, first);
    const meeting1 = await openMeeting(app1, row);
    const seats = await startMeeting(app1, meeting1);
    await first.flush();
    expect(store.saved?.phase).toBe('running');

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const auth = createAuth({
      store: authStore,
      offeredRoles: () => seats,
    });
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(meetings, second, { auth });
    const meeting2 = await openMeeting(app2, row);

    const response = await fetch(meetingUrl(app2, meeting2.id, '/api/scenario'), {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
    expectOwnTeamScenario(await response.json(), seats);
    expect(meeting2.session.phase()).toBe('running');

    const setup = (await (
      await fetch(meetingUrl(app2, meeting2.id, '/api/setup'), { headers: { cookie: owner.cookie } })
    ).json()) as { setup: MeetingSetup; started: boolean };
    expect(setup.started).toBe(true);
    expect(setup.setup.title).toBe('Team playtest meeting');
    expect(setup.setup.roles.map((role) => role.id)).toEqual(expect.arrayContaining(seats));
  });

  it('restores a practice meeting from the pack, never from a team setup', async () => {
    const app = await createPracticeTestApp({ roomRoster: async () => [] });
    apps.push(app);
    const teamSetup: MeetingSetup = {
      title: 'Team playtest meeting',
      agenda: [{ id: 'agenda-1', title: 'Topic one', minutes: 5, ownerRoleId: 'role_1' }],
      roles: [
        { id: 'role_1', label: 'Role one', facilitator: false },
        { id: 'role_2', label: 'Role two', facilitator: false },
      ],
      seats: [
        { displayName: 'Mira', roleId: 'role_1', kind: 'person' },
        { displayName: 'Noah', roleId: 'role_2', kind: 'person' },
      ],
      pace: { ...DEFAULT_MEETING_PACE },
      source: { title: 'typed', agenda: 'typed', roles: 'typed', seats: 'typed', pace: 'typed' },
    };
    app.session.setDraft(teamSetup);

    const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario?kind=practice'));
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
      const meetings = createMemoryMeetingStore();
      const authStore = createMemoryAuthStore();
      const owner = await signInGoogle(authStore, 'Ada Owner');
      const row = await meetings.create(teamRow(owner.userId));
      const store = createPostgresMeetingStateStore(postgres.pool, row.id);
      const first = createMeetingPersistence({ store, log: () => undefined });
      const app1 = await startApp(meetings, first);
      const meeting1 = await openMeeting(app1, row);
      const seats = await startMeeting(app1, meeting1);
      await endMeeting(app1, meeting1);
      await first.flush();
      expect((await store.load())?.phase).toBe('ended');

      await app1.close();
      apps.splice(apps.indexOf(app1), 1);

      const auth = createAuth({
        store: authStore,
        offeredRoles: () => seats,
      });
      const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
      const app2 = await startApp(meetings, second, { auth });
      const meeting2 = await openMeeting(app2, row);

      const response = await fetch(meetingUrl(app2, meeting2.id, '/api/scenario'), {
        headers: { cookie: owner.cookie },
      });
      expect(response.status).toBe(200);
      expectOwnTeamScenario(await response.json(), seats);
      expect((await fetch(meetingUrl(app2, meeting2.id, '/api/setup'), {
        headers: { cookie: owner.cookie },
      })).status).toBe(200);
    } finally {
      await postgres.dispose();
    }
  });
});
