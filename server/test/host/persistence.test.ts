import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultMeetingSetup, type KakiEvent, type MeetingSetup, type Task } from '@kaki/shared';
import { createApp, type CreateAppOptions } from '../../src/app';
import { createMeetingModule } from '../../src/host/meeting';
import { loadScenario } from '../../src/loadScenario';
import { createFakeLlm } from '../../src/llm';
import { createMeetingCodeSource } from '../../src/meetingCode';
import { createMeetingPersistence, type MeetingPersistence } from '../../src/persist/persistence';
import {
  assertCompatibleSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import type { KakiApp } from '../../src/app';
import { connectClient, createTestApp, portOf, waitFor, waitForEvent, type TestClient } from '../helpers';
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
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:05:00.000Z',
    setup: defaultMeetingSetup(testScenario),
    meetingCode: 'AB12CD',
    seats: [],
    state: {
      meetingId: 'meeting-1',
      agenda,
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

async function startApp(
  persistence: MeetingPersistence,
  options: Omit<CreateAppOptions, 'persistence' | 'scenario' | 'modules'> = {},
): Promise<KakiApp> {
  const app = await createTestApp({
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    persistence,
    ...options,
  });
  apps.push(app);
  return app;
}

function baseUrl(app: KakiApp): string {
  return `http://127.0.0.1:${portOf(app)}`;
}

async function readSetup(app: KakiApp): Promise<MeetingSetup> {
  const response = await fetch(`${baseUrl(app)}/api/setup`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { setup: MeetingSetup }).setup;
}

async function putSetup(app: KakiApp, setup: MeetingSetup): Promise<Response> {
  return fetch(`${baseUrl(app)}/api/setup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
}

function editedSetup(setup: MeetingSetup): MeetingSetup {
  return {
    ...setup,
    title: 'Friday lunch readiness',
    agenda: setup.agenda.map((item) => ({ ...item, minutes: 17, ownerRoleId: 'cashier' })),
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

async function meetingState(app: KakiApp): Promise<{ meetingId: string; started: boolean; startedAt?: string }> {
  const response = await fetch(`${baseUrl(app)}/api/meeting/state`);
  expect(response.status).toBe(200);
  return (await response.json()) as { meetingId: string; started: boolean; startedAt?: string };
}

function join(app: KakiApp, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', ...body }),
  });
}

async function connectScreen(app: KakiApp): Promise<TestClient> {
  const client = await connectClient(portOf(app), 'screen');
  clients.push(client);
  return client;
}

function say(app: KakiApp, speaker: string, text: string): void {
  app.hub.publish({
    type: 'MEETING_STARTED',
    audience: { kind: 'all' },
    payload: { meetingId: 'meeting-1', startedAt: new Date().toISOString() },
  });
  app.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { speaker, text, timestamp: new Date().toISOString() },
  });
}

function isRecord(event: KakiEvent): boolean {
  return event.type === 'MEETING_RECORD_UPDATED';
}

describe('meeting persistence across a restart', () => {
  it('restores the record, notetaker progress and tasks, and keeps tracking new talk', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);

    say(app1, 'Ada (Chef)', 'The oven trips the fuse again, it has been happening all morning.');
    say(app1, 'Bao (Cashier)', 'I will check the temperature log before service.');
    const open = app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    const interrupted = app1.tasks.suggest({
      title: 'Email the supplier',
      context: 'The oven part is late.',
      suggestedAssignee: 'chef',
      actionKind: 'email',
    });
    app1.tasks.transition(interrupted.id, 'DISPATCHED', { assignee: 'chef' });
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
    const app2 = await startApp(second);
    const screen = await connectScreen(app2);

    const restored = await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');
    expect(restored.type === 'MEETING_RESTORED' && restored.payload.startedAt).toBe(frozen!.startedAt);

    const record = await waitFor(
      () => screen.messages.filter(isRecord).at(-1) as Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> | undefined,
      'restored meeting record',
    );
    expect(record.payload.speakerTalkSeconds.chef).toBeGreaterThan(0);
    expect(record.payload.speakerTalkSeconds.cashier).toBeGreaterThan(0);

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
      'Ada (Chef)',
      'I have also asked the supplier to call us back this afternoon, and I told them that if the part ' +
        'does not arrive before the lunch rush we will borrow the spare tray warmer from the branch next ' +
        'door, so the front counter keeps moving and nobody has to wait outside in the queue while we ' +
        'sort the oven out properly with the electrician on Monday morning.',
    );
    const later = await waitFor(
      () => {
        const latest = screen.messages.filter(isRecord).at(-1) as
          | Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>
          | undefined;
        return latest !== undefined && (latest.payload.speakerTalkSeconds.chef ?? 0) > (record.payload.speakerTalkSeconds.chef ?? 0)
          ? latest
          : undefined;
      },
      'talk time to keep growing',
    );
    expect(later.payload.agendaIndex).toBe(record.payload.agendaIndex);
  });

  it('clears the saved meeting when the host starts a new one', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);
    say(app1, 'Ada (Chef)', 'The oven trips the fuse again.');
    app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    await first.flush();
    const frozen = store.saved!;

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second);
    const screen = await connectScreen(app2);
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');

    await waitFor(() => (store.saved === undefined ? true : undefined), 'saved meeting to be cleared');
    expect(app2.tasks.list()).toEqual([]);

    say(app2, 'Ada (Chef)', 'A fresh meeting starts here.');
    await waitFor(() => (store.saved !== undefined ? true : undefined), 'the new meeting to be saved');
    expect(store.saved!.startedAt).not.toBe(frozen.startedAt);
  });

  it('refuses the previous format save with a clear message', () => {
    const saved: StoredMeeting = {
      schemaVersion: MEETING_STATE_SCHEMA_VERSION - 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      savedAt: '2026-01-01T00:00:00.000Z',
      setup: defaultMeetingSetup(testScenario),
      meetingCode: 'AB12CD',
      seats: [],
      state: {
        meetingId: 'meeting-1',
        agenda: ['Prep'],
        clock: {
          started: true,
          ended: false,
          paused: false,
          agendaIndex: 0,
          itemElapsedSeconds: 0,
          meetingElapsedSeconds: 0,
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

    expect(() => assertCompatibleSavedMeeting(saved)).toThrow(
      `Saved meeting is from an older format (v${MEETING_STATE_SCHEMA_VERSION - 1}, need v${MEETING_STATE_SCHEMA_VERSION}). ` +
        'Run `npm run meeting:reset` to discard it.',
    );
  });

  it('restores the saved agenda order so its index still means the same topic', async () => {
    const scenario = {
      ...testScenario,
      agenda: [
        testScenario.agenda[0]!,
        { ...testScenario.agenda[0]!, title: 'Service', ownerRole: 'cashier' as const },
      ],
    };
    const store = new MemoryStore();
    store.saved = savedState({ agenda: ['Service', 'Prep'], agendaIndex: 1 });
    const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
    const app = await createApp({
      scenario,
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence,
    });
    apps.push(app);
    const screen = await connectClient(portOf(app), 'screen');
    clients.push(screen);

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

    const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/scenario`);
    const restored = (await response.json()) as { agenda: Array<{ title: string }> };
    expect(restored.agenda.map((item) => item.title)).toEqual(['Service', 'Prep']);
  });

  it('treats a restored meeting as ongoing so the person coming back resumes it', async () => {
    const scenario = await loadScenario('kopitiam');
    const task: Task = {
      id: 'task-restored',
      title: 'Keep the plan',
      context: 'From before the restart.',
      suggestedAssignee: 'producer',
      status: 'SUGGESTED',
      updatedAt: '2026-01-01T00:00:20.000Z',
    };
    const agenda = scenario.agenda.slice(0, 2).map((item) => item.title);
    const store = new MemoryStore();
    store.saved = savedState({ agenda, tasks: [task] });
    const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
    const app = await createApp({
      scenario,
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Visitor', participantRole: 'producer' }),
    });
    expect(response.status).toBe(200);
    const joined = (await response.json()) as { resumed?: boolean };
    expect(joined.resumed).toBe(true);
    expect(app.tasks.get(task.id)?.title).toBe('Keep the plan');

    const meeting = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/scenario`)).json()) as {
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

    await expect(
      createApp({
        scenario: testScenario,
        modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
        persistence,
      }),
    ).rejects.toThrow(/Saved meeting is unreadable \(.*\)\. Run `npm run meeting:reset` to discard it\./);
    await persistence.close();
  });

  it('tells the host when the old meeting could not be cleared, and keeps the meeting', async () => {
    const store = new FailingClearStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence);
    say(app, 'Ada (Chef)', 'The oven trips the fuse again.');
    const task = app.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
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
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence);
    const screen = await connectScreen(app);
    say(app, 'Ada (Chef)', 'The oven trips the fuse again.');
    const task = app.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    await persistence.flush();
    const frozen = store.saved!;
    expect(frozen).toBeDefined();

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await store.clearStarted;
    // The old meeting is still talking while the clear is in progress.
    say(app, 'Ada (Chef)', 'One more line before the reset lands.');
    store.finishClear();
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');
    await persistence.flush();

    expect(store.saved).toBeUndefined();
    expect(app.tasks.get(task.id)).toBeUndefined();

    say(app, 'Ada (Chef)', 'A fresh meeting starts here.');
    await waitFor(() => (store.saved !== undefined ? true : undefined), 'the new meeting to be saved');
    expect(store.saved!.startedAt).not.toBe(frozen.startedAt);
  });

  it('saves the last transcript line before closing, not the state before it', async () => {
    const store = new MemoryStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await createTestApp({
      modules: [createMeetingModule({ llm: createFakeLlm(() => '{}'), notetakerIntervalMs: 60_000 })],
      persistence,
    });
    apps.push(app);

    say(app, 'Ada (Chef)', 'The first line of the meeting.');
    await persistence.flush();
    say(app, 'Bao (Cashier)', 'The last line before we close.');
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
    const firstCode = createMeetingCodeSource('');
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, { meetingCode: firstCode });

    const edited = editedSetup(await readSetup(app1));
    expect((await putSetup(app1, edited)).status).toBe(200);
    await first.flush();

    expect(store.saved?.startedAt).toBeUndefined();
    expect(store.saved?.setup).toEqual(edited);
    const firstMeeting = await meetingState(app1);
    expect(firstMeeting.started).toBe(false);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const secondCode = createMeetingCodeSource('');
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, { meetingCode: secondCode });

    expect(await readSetup(app2)).toEqual(edited);
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
    expect(secondCode.value).toBe(firstCode.value);
    expect(secondCode.value).toBe(store.saved?.meetingCode);
  });

  it('restores the edited setup, code and both person seats after a running-meeting restart', async () => {
    const store = new MemoryStore();
    const firstCode = createMeetingCodeSource('');
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first, {
      meetingCode: firstCode,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });

    const edited = editedSetup(await readSetup(app1));
    expect((await putSetup(app1, edited)).status).toBe(200);
    expect((await fetch(`${baseUrl(app1)}/api/meeting/start`, { method: 'POST' })).status).toBe(200);

    const ada = await join(app1, { participantName: 'Ada', participantRole: 'chef' });
    expect(ada.status).toBe(200);
    const bao = await join(app1, {
      participantName: 'Bao',
      participantRole: 'cashier',
      meetingCode: firstCode.value,
    });
    expect(bao.status).toBe(200);

    await first.flush();
    const frozen = store.saved!;
    const firstMeeting = await meetingState(app1);
    expect(frozen.seats).toEqual([
      { name: 'ada', seat: 'chef' },
      { name: 'bao', seat: 'cashier' },
    ]);
    expect(frozen.setup).toEqual(edited);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const secondCode = createMeetingCodeSource('');
    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second, {
      meetingCode: secondCode,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });

    expect(await readSetup(app2)).toEqual(edited);
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
    expect(secondCode.value).toBe(firstCode.value);

    const back = await join(app2, { participantName: 'Ada', participantRole: 'chef' });
    expect(back.status).toBe(200);
    const backBody = (await back.json()) as { meetingCode: string; resumed?: boolean };
    expect(backBody.meetingCode).toBe(firstCode.value);
    expect(backBody.resumed).toBe(true);

    // The saved seat holders are known: a second known person joins the same meeting, not a new one.
    const baoBack = await join(app2, {
      participantName: 'Bao',
      participantRole: 'cashier',
      meetingCode: secondCode.value,
    });
    expect(baoBack.status).toBe(200);
    expect((await meetingState(app2)).meetingId).toBe(firstMeeting.meetingId);
  });

  it('lets KAKI_MEETING_CODE win over the saved code and says so', async () => {
    const store = new MemoryStore();
    store.saved = savedState({ agenda: ['Prep'] });
    const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
    const pinned = createMeetingCodeSource('K7QX');
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const app = await startApp(persistence, { meetingCode: pinned });
      expect(pinned.value).toBe('K7QX');
      expect(logs.some((line) => line.includes('KAKI_MEETING_CODE') && line.includes('saved meeting code'))).toBe(
        true,
      );
      expect((await meetingState(app)).meetingId).toBe('meeting-1');
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a saved meeting with a corrupt setup, naming the field', async () => {
    const store = new MemoryStore();
    const broken = savedState({ agenda: ['Prep'] });
    broken.setup.agenda[0]!.minutes = 0;
    store.saved = broken;
    const persistence = createMeetingPersistence({ store, saved: broken, log: () => undefined });

    await expect(
      createApp({
        scenario: testScenario,
        modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
        persistence,
      }),
    ).rejects.toThrow(/its setup is invalid at agenda\[0\]\.minutes: .*Run `npm run meeting:reset` to discard it\./);
    await persistence.close();
  });

  it('rejects every New meeting while the clear keeps failing, then saves again once it clears', async () => {
    const store = new FailingClearStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await startApp(persistence);
    say(app, 'Ada (Chef)', 'The oven trips the fuse again.');
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
    say(app, 'Ada (Chef)', 'A line after the failed resets.');
    await waitFor(
      () => (store.events.includes('clear') && store.saved !== undefined ? true : undefined),
      'the clear to succeed and saving to resume',
    );
    expect(store.events.filter((event) => event === 'clear')).toHaveLength(1);
  });
});
