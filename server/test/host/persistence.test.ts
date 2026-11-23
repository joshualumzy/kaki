import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultMeetingSetup, type KakiEvent, type MeetingSetup, type Task } from '@kaki/shared';
import type { KakiApp, CreateAppOptions } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
import { loadScenario } from '../../src/core/loadScenario';
import { createFakeLlm } from '../../src/services/llm';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import type { MeetingRow } from '../../src/meeting/types';
import type { KakiModule } from '../../src/core/modules';
import { createMeetingPersistence, type MeetingPersistence } from '../../src/persist/persistence';
import {
  assertCompatibleSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import {
  connectMeetingClient,
  createTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  waitFor,
  waitForEvent,
  type TestAppWithMeeting,
  type TestClient,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';

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

class FailingClearStore extends MemoryStore {
  clearFailures = 0;
  events: string[] = [];

  override async clear(): Promise<void> {
    if (this.clearFailures > 0) {
      this.clearFailures -= 1;
      this.events.push('clear:failed');
      throw new Error('database is down');
    }
    this.events.push('clear');
    await super.clear();
  }
}

class GatedClearStore extends MemoryStore {
  readonly clearStarted: Promise<void>;
  private beginClear!: () => void;
  private releaseClear!: () => void;

  constructor() {
    super();
    this.clearStarted = new Promise<void>((resolve) => {
      this.beginClear = resolve;
    });
  }

  override async clear(): Promise<void> {
    this.beginClear();
    await new Promise<void>((resolve) => {
      this.releaseClear = resolve;
    });
    await super.clear();
  }

  finishClear(): void {
    this.releaseClear();
  }
}

function setupWithAgenda(agenda: string[]): MeetingSetup {
  const base = defaultMeetingSetup(testScenario);
  return {
    ...base,
    agenda: agenda.map((title, index) => ({ id: `agenda-${index + 1}`, title, minutes: 5, ownerRoleId: 'chef' })),
  };
}

function savedState({
  agenda,
  agendaIndex = 0,
  tasks = [],
}: {
  agenda: string[];
  agendaIndex?: number;
  tasks?: Task[];
}): StoredMeeting {
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: 'meeting-1',
    phase: 'running',
    draft: setupWithAgenda(agenda),
    draftTouched: true,
    sealed: setupWithAgenda(agenda),
    holders: [],
    meetingCode: 'AB12CD',
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:05:00.000Z',
    state: {
      clock: {
        started: true,
        ended: false,
        paused: false,
        agendaIndex,
        itemElapsedSeconds: 30,
        meetingElapsedSeconds: 90,
      },
      notetaker: {
        pending: [],
        inFlight: [],
        recentGrounded: [],
        contextAgendaIndex: agendaIndex,
        agendaContext: [],
        openQuestions: [],
        questionCount: 0,
        status: 'ok',
        talkByItem: [],
        talkTotals: [],
        talkTotal: 0,
      },
      tasks,
    },
  };
}

const apps: KakiApp[] = [];
const clients: TestClient[] = [];

// These tests drive the task lifecycle themselves; Sam must not dispatch the cards underneath them.
beforeAll(() => {
  process.env.KAKI_AUTO_DISPATCH = '0';
});

afterAll(() => {
  delete process.env.KAKI_AUTO_DISPATCH;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.close();
});

interface StartOptions {
  meetings: MeetingStore;
  meetingId?: string;
  title?: string;
  agenda?: MeetingRow['agenda'];
  modules?: KakiModule[];
  app?: Omit<CreateAppOptions, 'scenario' | 'meetingModules' | 'persistenceFor'>;
}

/** Start a server that owns real meetings, creating or reopening the one this test acts on. */
async function startApp(
  persistence: MeetingPersistence | undefined,
  options: StartOptions,
): Promise<TestAppWithMeeting> {
  const app = (await createTestApp({
    meetings: options.meetings,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...(persistence === undefined ? {} : { persistenceFor: async () => persistence }),
    meetingModules: realModulesWith(options.modules ?? [createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    ...options.app,
  })) as TestAppWithMeeting;
  apps.push(app);
  let meetingId = options.meetingId;
  if (meetingId === undefined) {
    const row = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'test-owner',
      title: options.title ?? 'Test meeting',
      ...(options.agenda === undefined ? {} : { agenda: options.agenda }),
    });
    meetingId = row.id;
  }
  const instance = await app.registry.get(meetingId);
  if (instance === undefined) throw new Error(`the real meeting ${meetingId} did not load`);
  return Object.assign(app, {
    meetingId,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
  });
}

/** Start a server without loading a meeting, for tests that seed a saved row before it opens. */
async function bootApp(
  persistence: MeetingPersistence,
  options: Omit<StartOptions, 'meetingId'>,
): Promise<TestAppWithMeeting> {
  const app = (await createTestApp({
    meetings: options.meetings,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    persistenceFor: async () => persistence,
    meetingModules: realModulesWith(options.modules ?? [createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    ...options.app,
  })) as TestAppWithMeeting;
  apps.push(app);
  return app;
}

/** The roles the real meeting's own scenario offers, used so talk time is attributed. */
function talkRoles(app: TestAppWithMeeting): { first: string; second: string } {
  const roles = app.session.active().roles.map((role) => role.id);
  const first = roles.includes('everyone') ? 'everyone' : roles[0]!;
  const second = roles.find((role) => role !== first) ?? first;
  return { first, second };
}

function meetingStateUrl(app: TestAppWithMeeting, path: string): string {
  return meetingUrl(app, app.meetingId, path);
}

async function readSetup(app: TestAppWithMeeting): Promise<MeetingSetup> {
  const response = await fetch(meetingStateUrl(app, '/api/setup'));
  expect(response.status).toBe(200);
  return ((await response.json()) as { setup: MeetingSetup }).setup;
}

async function putSetup(app: TestAppWithMeeting, setup: MeetingSetup): Promise<Response> {
  return fetch(meetingStateUrl(app, '/api/setup'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
}

function editedSetup(setup: MeetingSetup): MeetingSetup {
  return {
    ...setup,
    title: 'Friday lunch readiness',
    agenda: setup.agenda.map((item) => ({ ...item, minutes: 17 })),
    roles: setup.roles.map((role, index) => (index === 0 ? { ...role, label: 'Head Chef' } : role)),
    pace: { ownerQuietBelow: 20, quietCheckAfter: 90, comingUpBefore: 45 },
    source: {
      title: 'typed',
      agenda: 'typed',
      roles: 'typed',
      seats: 'typed',
      pace: 'typed',
    },
  };
}

async function meetingState(app: TestAppWithMeeting): Promise<{ meetingId: string; started: boolean; startedAt?: string }> {
  const response = await fetch(meetingStateUrl(app, '/api/meeting/state'));
  expect(response.status).toBe(200);
  return (await response.json()) as { meetingId: string; started: boolean; startedAt?: string };
}

async function meetingCode(app: TestAppWithMeeting): Promise<string> {
  const response = await fetch(meetingStateUrl(app, '/api/meeting-code'));
  expect(response.status).toBe(200);
  return ((await response.json()) as { code: string }).code;
}

async function joinReal(app: TestAppWithMeeting, name: string): Promise<Response> {
  return fetch(meetingStateUrl(app, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantName: name }),
  });
}

async function connectScreen(app: TestAppWithMeeting): Promise<TestClient> {
  const client = await connectMeetingClient(portOf(app), app.meetingId, 'screen');
  clients.push(client);
  return client;
}

function say(app: TestAppWithMeeting, speaker: string, text: string, speakerRole?: string): void {
  app.hub.publish({
    type: 'MEETING_STARTED',
    audience: { kind: 'all' },
    payload: { meetingId: app.meetingId, startedAt: new Date().toISOString() },
  });
  app.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: {
      speaker,
      text,
      timestamp: new Date().toISOString(),
      ...(speakerRole === undefined ? {} : { speakerRole }),
    },
  });
}

function isRecord(event: KakiEvent): boolean {
  return event.type === 'MEETING_RECORD_UPDATED';
}

describe('meeting persistence across a restart', () => {
  it('restores the record, notetaker progress and tasks, and keeps tracking new talk', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, { meetings, agenda: [{ title: 'Prep', minutes: 5 }] });
    const roles = talkRoles(app1);

    say(app1, 'Ada', 'The oven trips the fuse again, it has been happening all morning.', roles.first);
    say(app1, 'Bao', 'I will check the temperature log before service.', roles.second);
    const open = app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: roles.first,
    });
    const interrupted = app1.tasks.suggest({
      title: 'Email the supplier',
      context: 'The oven part is late.',
      suggestedAssignee: roles.first,
      actionKind: 'email',
    });
    app1.tasks.transition(interrupted.id, 'DISPATCHED', { assignee: roles.first });
    app1.tasks.transition(interrupted.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    app1.tasks.transition(interrupted.id, 'DRAFT_READY', {
      draft: { target: 'supplier@example.test', subject: 'Part', body: 'When is it coming?' },
    });
    app1.tasks.transition(interrupted.id, 'RUNNING');

    await first.flush();
    const frozen = store.saved;
    expect(frozen).toBeDefined();
    expect(frozen!.state.clock.started).toBe(true);
    expect(frozen!.state.notetaker.talkTotal).toBeGreaterThan(0);
    expect(frozen!.state.tasks).toHaveLength(2);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { meetings, meetingId: app1.meetingId });
    const screen = await connectScreen(app2);

    const restored = await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');
    expect(restored.type === 'MEETING_RESTORED' && restored.payload.startedAt).toBe(frozen!.startedAt);

    const record = await waitFor(
      () => screen.messages.filter(isRecord).at(-1) as Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> | undefined,
      'restored meeting record',
    );
    expect(record.payload.speakerTalkSeconds[roles.first]).toBeGreaterThan(0);
    expect(record.payload.speakerTalkSeconds[roles.second]).toBeGreaterThan(0);

    expect(app2.tasks.get(open.id)?.status).toBe('SUGGESTED');
    const failed = app2.tasks.get(interrupted.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.interrupted).toBe(true);
    expect(failed?.error).toBe(
      'Kaki restarted while this was running. It may already have gone through: check before tapping Retry.',
    );

    // The notetaker carries on from the restored talk time instead of starting from nothing.
    say(
      app2,
      'Ada',
      'I have also asked the supplier to call us back this afternoon, and I told them that if the part ' +
        'does not arrive before the lunch rush we will borrow the spare tray warmer from the branch next ' +
        'door, so the front counter keeps moving and nobody has to wait outside in the queue while we ' +
        'sort the oven out properly with the electrician on Monday morning.',
      roles.first,
    );
    const later = await waitFor(
      () => {
        const latest = screen.messages.filter(isRecord).at(-1) as
          | Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>
          | undefined;
        return latest !== undefined &&
          (latest.payload.speakerTalkSeconds[roles.first] ?? 0) > (record.payload.speakerTalkSeconds[roles.first] ?? 0)
          ? latest
          : undefined;
      },
      'talk time to keep growing',
    );
    expect(later.payload.agendaIndex).toBe(record.payload.agendaIndex);
  });

  it('clears the saved meeting when the host starts a new one', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, { meetings, agenda: [{ title: 'Prep', minutes: 5 }] });
    const roles = talkRoles(app1);
    say(app1, 'Ada', 'The oven trips the fuse again.', roles.first);
    app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: roles.first,
    });
    await first.flush();
    const frozen = store.saved!;

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { meetings, meetingId: app1.meetingId });
    const screen = await connectScreen(app2);
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');

    await waitFor(() => (store.saved === undefined ? true : undefined), 'saved meeting to be cleared');
    expect(app2.tasks.list()).toEqual([]);

    say(app2, 'Ada', 'A fresh meeting starts here.', roles.first);
    await waitFor(() => (store.saved !== undefined ? true : undefined), 'the new meeting to be saved');
    expect(store.saved!.startedAt).not.toBe(frozen.startedAt);
  });

  it('keeps an unconsumed edited draft across New meeting and a restart', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const firstPersistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await startApp(firstPersistence, {
      meetings,
      agenda: [{ title: 'Prep', minutes: 5 }],
    });
    const edited = editedSetup(await readSetup(first));
    expect((await putSetup(first, edited)).status).toBe(200);
    await firstPersistence.flush();

    const screen = await connectScreen(first);
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');
    await firstPersistence.flush();
    // The clear removed the old meeting; the kept draft is the new lobby and must be saved.
    expect(store.saved?.draft.title).toBe('Friday lunch readiness');
    expect(store.saved?.draftTouched).toBe(true);

    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const restored = await startApp(
      createMeetingPersistence({ store, saved: await store.load(), log: () => undefined }),
      { meetings, meetingId: first.meetingId },
    );
    expect((await readSetup(restored)).title).toBe('Friday lunch readiness');
  });

  it('refuses the previous format save with a clear message', () => {
    const saved: StoredMeeting = {
      ...savedState({ agenda: ['Prep'] }),
      schemaVersion: MEETING_STATE_SCHEMA_VERSION - 1,
    };

    expect(() => assertCompatibleSavedMeeting(saved)).toThrow(
      `Saved meeting is from an older format (v${MEETING_STATE_SCHEMA_VERSION - 1}, need v${MEETING_STATE_SCHEMA_VERSION}). ` +
        'Run `npm run meeting:reset` to discard it.',
    );
  });

  it('restores the saved agenda order so its index still means the same topic', async () => {
    const store = new MemoryStore();
    store.saved = savedState({ agenda: ['Service', 'Prep'], agendaIndex: 1 });
    const meetings = createMemoryMeetingStore();
    const app = await startApp(
      createMeetingPersistence({ store, saved: store.saved, log: () => undefined }),
      {
        meetings,
        agenda: [
          { title: 'Service', minutes: 5 },
          { title: 'Prep', minutes: 5 },
        ],
      },
    );
    const screen = await connectScreen(app);

    const start = await waitForEvent(screen, (event) => event.type === 'MEETING_STARTED', 'restored start');
    expect(start.type === 'MEETING_STARTED' ? start.payload : {}).toMatchObject({
      agendaIndex: 1,
      resumed: true,
    });

    const record = (await waitForEvent(screen, isRecord, 'restored record')) as Extract<
      KakiEvent,
      { type: 'MEETING_RECORD_UPDATED' }
    >;
    expect(record.payload.agendaIndex).toBe(1);

    const response = await fetch(meetingStateUrl(app, '/api/scenario'));
    const restored = (await response.json()) as { agenda: Array<{ title: string }> };
    expect(restored.agenda.map((item) => item.title)).toEqual(['Service', 'Prep']);
  });

  it('treats a restored meeting as ongoing so the person coming back resumes it', async () => {
    const scenario = await loadScenario('kopitiam');
    const task: Task = {
      id: 'task-restored',
      title: 'Keep the plan',
      context: 'From before the restart.',
      suggestedAssignee: 'operations_director',
      status: 'SUGGESTED',
      updatedAt: '2026-01-01T00:00:20.000Z',
    };
    const agenda = scenario.agenda.slice(0, 2).map((item) => item.title);
    const store = new MemoryStore();
    store.saved = savedState({ agenda, tasks: [task] });
    // The saved meeting belongs to the loaded scenario: Wei Ling is the person's seat, the rest are AI.
    const setup = defaultMeetingSetup(structuredClone(scenario));
    // A real meeting has no AI stand-ins: every one of its seats is a person.
    setup.seats = setup.seats.map((seat) => ({
      displayName: seat.displayName,
      roleId: seat.roleId,
      kind: 'person' as const,
    }));
    store.saved.sealed = { ...setup, agenda: setup.agenda.slice(0, 2) };
    const meetings = createMemoryMeetingStore();
    const app = await startApp(
      createMeetingPersistence({ store, saved: store.saved, log: () => undefined }),
      {
        meetings,
        agenda: agenda.map((title) => ({ title, minutes: 5 })),
      },
    );

    const response = await joinReal(app, 'Visitor');
    expect(response.status).toBe(200);
    const joined = (await response.json()) as { resumed?: boolean };
    expect(joined.resumed).toBe(true);
    expect(app.tasks.get(task.id)?.title).toBe('Keep the plan');

    const meeting = (await (await fetch(meetingStateUrl(app, '/api/scenario'))).json()) as {
      agenda: Array<{ title: string }>;
    };
    expect(meeting.agenda.map((item) => item.title)).toEqual(agenda);
  });

  it('refuses to start with a saved meeting whose shape is broken', async () => {
    const store = new MemoryStore();
    const broken = savedState({ agenda: ['Prep'] });
    (broken.state.clock as unknown as { agendaIndex: unknown }).agendaIndex = 'first';
    store.saved = broken;
    const persistence = createMeetingPersistence({ store, saved: broken, log: () => undefined });
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({ workspaceId: 'workspace-1', ownerUserId: 'test-owner', title: 'Test meeting' });
    const app = await bootApp(persistence, { meetings });
    await expect(app.registry.get(row.id)).rejects.toThrow(
      /Saved meeting is unreadable \(.*\)\. Run `npm run meeting:reset` to discard it\./,
    );
    await persistence.close();
  });

  it('tells the host when the old meeting could not be cleared, and keeps the meeting', async () => {
    const store = new FailingClearStore();
    const meetings = createMemoryMeetingStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence, { meetings });
    const roles = talkRoles(app);
    say(app, 'Ada', 'The oven trips the fuse again.', roles.first);
    const task = app.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: roles.first,
    });
    await persistence.flush();
    const screen = await connectScreen(app);

    store.clearFailures = 1;
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    const rejected = await waitForEvent(screen, (event) => event.type === 'COMMAND_REJECTED', 'clear rejection');
    expect(rejected.type === 'COMMAND_REJECTED' && rejected.payload).toMatchObject({
      commandType: 'NEW_MEETING',
      reason: "Couldn't clear the saved meeting — try again",
    });
    expect(app.tasks.get(task.id)?.title).toBe('Call the oven repair man');
    expect(store.saved).toBeDefined();

    // The failed clear stays queued; a second attempt clears it before the host's new meeting starts.
    store.clearFailures = 0;
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');
    await waitFor(() => (store.saved === undefined ? true : undefined), 'saved meeting to be cleared');
    expect(app.tasks.get(task.id)).toBeUndefined();
  });

  it('does not let a pre-reset save bring the old meeting back while a clear is slow', async () => {
    const store = new GatedClearStore();
    const meetings = createMemoryMeetingStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence, { meetings });
    const roles = talkRoles(app);
    const screen = await connectScreen(app);
    say(app, 'Ada', 'The oven trips the fuse again.', roles.first);
    const task = app.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: roles.first,
    });
    await persistence.flush();
    const frozen = store.saved!;
    expect(frozen).toBeDefined();

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await store.clearStarted;
    // The old meeting is still talking while the clear is in progress.
    say(app, 'Ada', 'One more line before the reset lands.', roles.first);
    store.finishClear();
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');
    await persistence.flush();

    expect(store.saved).toBeUndefined();
    expect(app.tasks.get(task.id)).toBeUndefined();

    say(app, 'Ada', 'A fresh meeting starts here.', roles.first);
    await waitFor(() => (store.saved !== undefined ? true : undefined), 'the new meeting to be saved');
    expect(store.saved!.startedAt).not.toBe(frozen.startedAt);
  });

  it('saves the last transcript line before closing, not the state before it', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence, {
      meetings,
      modules: [createMeetingModule({ llm: createFakeLlm(() => '{}'), notetakerIntervalMs: 60_000 })],
    });
    const roles = talkRoles(app);

    say(app, 'Ada', 'The first line of the meeting.', roles.first);
    await persistence.flush();
    say(app, 'Bao', 'The last line before we close.', roles.second);
    await persistence.flush();
    await app.close();

    const saved = store.saved;
    expect(saved?.state.notetaker.pending.map((line) => line.text)).toEqual([
      'The first line of the meeting.',
      'The last line before we close.',
    ]);
  });

  it('saves an edited pre-Start setup draft on PUT and restores it, with its code and identity', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, {
      meetings,
      agenda: [{ title: 'Prep', minutes: 5 }],
    });

    const edited = editedSetup(await readSetup(app1));
    expect((await putSetup(app1, edited)).status).toBe(200);
    await first.flush();

    expect(store.saved?.startedAt).toBeUndefined();
    expect(store.saved?.draft).toEqual(edited);
    const firstMeeting = await meetingState(app1);
    expect(firstMeeting.started).toBe(false);
    const firstCode = await meetingCode(app1);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { meetings, meetingId: app1.meetingId });

    expect(await readSetup(app2)).toEqual(edited);
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
    expect(await meetingCode(app2)).toBe(firstCode);
    expect(store.saved?.meetingCode).toBe(firstCode);
  });

  it('restores the meeting plan, code and both person seats after a running-meeting restart', async () => {
    const store = new MemoryStore();
    const meetings = createMemoryMeetingStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, {
      meetings,
      title: 'Friday lunch readiness',
      agenda: [
        { title: 'Prep', minutes: 5 },
        { title: 'Service', minutes: 5 },
      ],
    });
    const firstCode = await meetingCode(app1);

    const ada = await joinReal(app1, 'Ada');
    expect(ada.status).toBe(200);
    const adaSeat = ((await ada.json()) as { participantRole: string }).participantRole;
    const bao = await joinReal(app1, 'Bao');
    expect(bao.status).toBe(200);
    const baoSeat = ((await bao.json()) as { participantRole: string }).participantRole;
    expect((await fetch(meetingStateUrl(app1, '/api/meeting/start'), { method: 'POST' })).status).toBe(200);

    await first.flush();
    const frozen = store.saved!;
    const firstMeeting = await meetingState(app1);
    expect(frozen.holders.map((holder) => holder.name)).toEqual(['ada', 'bao']);
    expect(frozen.holders.map((holder) => holder.seat)).toEqual([adaSeat, baoSeat]);
    expect(frozen.sealed?.title).toBe('Friday lunch readiness');
    expect(frozen.sealed?.agenda.map((item) => item.title)).toEqual(['Prep', 'Service']);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { meetings, meetingId: app1.meetingId });

    const restoredSetup = await readSetup(app2);
    expect(restoredSetup.title).toBe('Friday lunch readiness');
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
    expect((await meetingState(app2)).started).toBe(true);
    expect(await meetingCode(app2)).toBe(firstCode);

    const back = await joinReal(app2, 'Ada');
    expect(back.status).toBe(200);
    const backBody = (await back.json()) as { participantRole: string; resumed?: boolean };
    expect(backBody.participantRole).toBe(adaSeat);
    expect(backBody.resumed).toBe(true);

    // The saved seat holders are known: a second known person joins the same meeting, not a new one.
    const baoBack = await joinReal(app2, 'Bao');
    expect(baoBack.status).toBe(200);
    expect(((await baoBack.json()) as { participantRole: string }).participantRole).toBe(baoSeat);
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
  });

  it('refuses a saved meeting with a corrupt setup, naming the field', async () => {
    const store = new MemoryStore();
    const broken = savedState({ agenda: ['Prep'] });
    broken.draft.agenda[0]!.minutes = 0;
    store.saved = broken;
    const persistence = createMeetingPersistence({ store, saved: broken, log: () => undefined });
    const meetings = createMemoryMeetingStore();
    const row = await meetings.create({ workspaceId: 'workspace-1', ownerUserId: 'test-owner', title: 'Test meeting' });
    const app = await bootApp(persistence, { meetings });
    await expect(app.registry.get(row.id)).rejects.toThrow(
      /its draft setup is invalid at agenda\[0\]\.minutes: .*Run `npm run meeting:reset` to discard it\./,
    );
    await persistence.close();
  });

  it('rejects every New meeting while the clear keeps failing, then saves again once it clears', async () => {
    const store = new FailingClearStore();
    const meetings = createMemoryMeetingStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence, { meetings });
    const roles = talkRoles(app);
    say(app, 'Ada', 'The oven trips the fuse again.', roles.first);
    await persistence.flush();
    const screen = await connectScreen(app);

    store.clearFailures = 2;
    for (const attempt of [1, 2]) {
      const before = screen.messages.filter((event) => event.type === 'COMMAND_REJECTED').length;
      screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
      await waitFor(
        () => {
          const rejections = screen.messages.filter((event) => event.type === 'COMMAND_REJECTED');
          return rejections.length > before ? rejections[before] : undefined;
        },
        `the host to see rejection ${attempt}`,
      );
    }

    // Neither New meeting reset the room, and the clear is still waiting to be retried.
    expect(screen.messages.some((event) => event.type === 'MEETING_RESET')).toBe(false);
    expect(store.events.filter((event) => event === 'clear')).toEqual([]);

    // The next save retries the queued clear first, then saves; saves are not stuck behind it.
    say(app, 'Ada', 'A line after the failed resets.', roles.first);
    await waitFor(
      () => (store.events.includes('clear') && store.saved !== undefined ? true : undefined),
      'the clear to succeed and saving to resume',
    );
    expect(store.events.filter((event) => event === 'clear')).toHaveLength(1);
  });
});
