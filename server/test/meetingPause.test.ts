import { KAKI_LISTENER_IDENTITY } from '@kaki/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { KakiApp } from '../src/app';
import { createAgendaClock, type AgendaClock } from '../src/host/clock';
import type { MeetingPauseControl } from '../src/host';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/core/loadScenario';
import { createMemoryMeetingStore, type MeetingStore } from '../src/meeting/registry';
import type { MeetingRow } from '../src/meeting/types';
import { createMeetingPersistence } from '../src/persist/persistence';
import type { MeetingStateStore, StoredMeeting } from '../src/persist/state';
import {
  connectMeetingClient,
  createTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  type TestAppWithMeeting,
} from './helpers';

const pack = await loadScenario('kopitiam');

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

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function pauseControl(clock: AgendaClock): MeetingPauseControl {
  return {
    paused: () => {
      const snapshot = clock.snapshot();
      return snapshot.started ? snapshot.paused === true : undefined;
    },
    kind: () => clock.snapshot().pauseKind,
    pause: (kind) => clock.pause(kind),
    resume: () => clock.resume(),
  };
}

function pausedOf(clock: AgendaClock): boolean | undefined {
  const snapshot = clock.snapshot();
  return snapshot.started ? snapshot.paused === true : undefined;
}

interface StartOptions {
  clock: AgendaClock;
  store?: MemoryStore;
  meetings?: MeetingStore;
  row?: MeetingRow;
  people?: () => Array<{ name: string }>;
  graceMs?: number;
  pollMs?: number;
  emptyRoomPauseMs?: number;
}

interface Started {
  app: TestAppWithMeeting;
  meetings: MeetingStore;
  row: MeetingRow;
  store: MemoryStore;
  clock: AgendaClock;
  persistence: ReturnType<typeof createMeetingPersistence>;
}

async function startApp({
  clock,
  store = new MemoryStore(),
  meetings: existingMeetings,
  row: existingRow,
  people = () => [],
  graceMs = 60_000,
  pollMs = 10,
  emptyRoomPauseMs = 5,
}: StartOptions): Promise<Started> {
  const meetings = existingMeetings ?? createMemoryMeetingStore();
  const row = existingRow ?? await meetings.create({
    workspaceId: 'workspace-1',
    ownerUserId: 'test-owner',
    title: 'Weekly planning',
    agenda: pack.agenda,
  });
  const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
  const app = (await createTestApp({
    speechRecognition: 'browser',
    scenario: pack,
    meetings,
    persistenceFor: async () => persistence,
    meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })], {
      meetingElapsedSeconds: () => clock.snapshot().meetingElapsedSeconds,
      meetingAgendaIndex: () => clock.snapshot().agendaIndex,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    }),
    roomRoster: async () => people(),
    rejoinGraceMs: graceMs,
    rejoinPollMs: pollMs,
    emptyRoomPauseMs,
  })) as TestAppWithMeeting;
  apps.push(app);
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
  return { app, meetings, row, store, clock, persistence };
}

async function join(app: TestAppWithMeeting, name: string): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantName: name, participantRole: 'operations_director' }),
  });
}

function startMeeting(app: TestAppWithMeeting): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
}

describe('the server owns the empty-room pause', () => {
  it('restores an empty-room pause after a runner restart and resumes when the guest returns', async () => {
    const clock = createAgendaClock({ agenda: pack.agenda });
    const first = await startApp({ clock });
    expect((await join(first.app, 'Guest')).status).toBe(200);
    expect((await startMeeting(first.app)).status).toBe(200);
    await waitFor(() => (first.app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );
    await first.persistence.flush();
    expect(first.store.saved?.state.clock.paused).toBe(true);
    expect(first.store.saved?.state.clock.pauseKind).toBe('empty-room');
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    // The runner (and the server) restarted; the guest is back in the room when the new process polls.
    const restoredClock = createAgendaClock({ agenda: pack.agenda });
    const restored = await startApp({
      clock: restoredClock,
      store: first.store,
      meetings: first.meetings,
      row: first.row,
      people: () => [{ name: 'Guest' }],
    });
    await waitFor(
      () => (restoredClock.snapshot().paused === false ? true : undefined),
      'the returning guest to resume the meeting',
    );
    expect(restored.app.session.phase()).toBe('running');
    expect(restoredClock.snapshot().pauseKind).toBeUndefined();
  });

  it('keeps a person\'s explicit Stop paused when the room empties and someone returns', async () => {
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const { app } = await startApp({ clock, people: () => people });
    expect((await join(app, 'Guest')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    // Let the poll observe the room occupied before its next empty observation.
    people = [{ name: 'Guest' }];
    await settle(40);
    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');

    screen.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(
      () => (clock.snapshot().paused === true && clock.snapshot().pauseKind === 'person' ? true : undefined),
      'the person pause',
    );

    people = [];
    await settle(80);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });

    people = [{ name: 'Guest' }];
    await settle(80);
    // A returning person resumes only an empty-room pause; the person's Stop stays.
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });

    screen.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the person resume');
    screen.close();
  });

  it('keeps a person\'s Stop that lands during an empty-room pause', async () => {
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const { app, store, persistence } = await startApp({ clock, people: () => people });
    expect((await join(app, 'Guest')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    people = [];
    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );
    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');

    // The person returns and presses Stop before the poll sees them. That must turn the holding
    // pause into a person's pause, not leave it resumable.
    screen.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
    await waitFor(
      () => (clock.snapshot().pauseKind === 'person' ? true : undefined),
      'the Stop to take ownership of the pause',
    );

    people = [{ name: 'Guest' }];
    await settle(80);
    expect(clock.snapshot()).toMatchObject({ paused: true, pauseKind: 'person' });
    await persistence.flush();
    expect(store.saved?.state.clock.pauseKind).toBe('person');
    screen.close();
  });

  it('does not pause for a quick blip but pauses after a sustained empty room', async () => {
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const { app } = await startApp({ clock, people: () => people, emptyRoomPauseMs: 50 });
    expect((await join(app, 'Guest')).status).toBe(200);
    // The roster sees the guest as soon as they have joined, before Start.
    people = [{ name: 'Guest' }];
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    await settle(40);

    // A page reload: the room reads empty for less than the debounce, then the same person is back.
    people = [];
    await settle(25);
    people = [{ name: 'Guest' }];
    await settle(80);
    expect(clock.snapshot().paused).toBe(false);

    // A real departure spans the debounce and pauses.
    people = [];
    await waitFor(() => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined), 'the empty-room pause');
    people = [{ name: 'Guest' }];
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the return to resume');
  });

  it('does not let the runner listener keep an empty room alive', async () => {
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const { app } = await startApp({ clock, people: () => people });
    expect((await join(app, 'Guest')).status).toBe(200);
    people.push({ name: 'Guest' });
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    // The person leaves; only the runner's technical listener stays in LiveKit.
    people = [{ name: KAKI_LISTENER_IDENTITY }];
    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );

    people = [{ name: 'Guest' }, { name: KAKI_LISTENER_IDENTITY }];
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the return to resume');
  });

  it('publishes the paused record to the screen on auto-pause and auto-resume', async () => {
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const { app } = await startApp({ clock, people: () => people });
    expect((await join(app, 'Guest')).status).toBe(200);
    // The roster sees the guest as soon as they have joined, before Start, so the meeting does not
    // auto-pause between Start and the screen connecting.
    people = [{ name: 'Guest' }];
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');
    const beforePause = screen.messages.length;
    people = [];
    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );
    const pausedRecord = await waitFor(
      () =>
        screen.messages
          .slice(beforePause)
          .find((event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.paused === true),
      'the paused record',
    );
    expect(pausedRecord).toMatchObject({ payload: { paused: true, pauseKind: 'empty-room' } });

    const beforeResume = screen.messages.length;
    people = [{ name: 'Guest' }];
    await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the auto resume');
    await waitFor(
      () =>
        screen.messages
          .slice(beforeResume)
          .some((event) => event.type === 'MEETING_RECORD_UPDATED' && event.payload.paused !== true)
          ? true
          : undefined,
      'the resumed record',
    );
    screen.close();
  });
});
