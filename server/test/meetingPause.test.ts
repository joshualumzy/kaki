import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type KakiApp } from '../src/app';
import { createAgendaClock, type AgendaClock } from '../src/host/clock';
import type { MeetingPauseControl } from '../src/host';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/loadScenario';
import { createMeetingPersistence } from '../src/persist/persistence';
import type { MeetingStateStore, StoredMeeting } from '../src/persist/state';
import { connectClient, portOf, settle, waitFor } from './helpers';

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
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
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

async function connectService(app: KakiApp): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(app)}/ws?role=service`);
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
      return;
    }
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

async function join(app: KakiApp, name: string, role: string): Promise<Response> {
  await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/open`, { method: 'POST' });
  return fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName: name, participantRole: role }),
  });
}

function startMeeting(app: KakiApp): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/start`, { method: 'POST' });
}

describe('the server owns the empty-room pause', () => {
  it('restores an empty-room pause after a runner restart and resumes when the guest returns', async () => {
    const pack = await loadScenario('kopitiam');
    const store = new MemoryStore();
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const first = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      persistence,
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 5,
      meetingElapsedSeconds: () => clock.snapshot().meetingElapsedSeconds,
      meetingAgendaIndex: () => clock.snapshot().agendaIndex,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    });
    apps.push(first);
    await connectService(first);
    expect((await join(first, 'Guest', 'producer')).status).toBe(200);
    expect((await startMeeting(first)).status).toBe(200);
    await waitFor(() => (first.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    people = [];
    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );
    await persistence.flush();
    expect(store.saved?.state.clock.paused).toBe(true);
    expect(store.saved?.state.clock.pauseKind).toBe('empty-room');
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    // The runner (and the server) restarted; the guest is back in the room when the new process polls.
    const restoredClock = createAgendaClock({ agenda: pack.agenda });
    const restored = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock: restoredClock, notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, saved: store.saved, log: () => undefined }),
      roomRoster: async () => [{ name: 'Guest' }],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 5,
      meetingPaused: () => pausedOf(restoredClock),
      meetingPause: pauseControl(restoredClock),
    });
    apps.push(restored);
    await waitFor(
      () => (restoredClock.snapshot().paused === false ? true : undefined),
      'the returning guest to resume the meeting',
    );
    expect(restored.session.phase()).toBe('running');
    expect(restoredClock.snapshot().pauseKind).toBeUndefined();
  });

  it('keeps a person\'s explicit Stop paused when the room empties and someone returns', async () => {
    const pack = await loadScenario('kopitiam');
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 5,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    });
    apps.push(app);
    await connectService(app);
    expect((await join(app, 'Guest', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    // Let the poll observe the room occupied before its next empty observation.
    people = [{ name: 'Guest' }];
    await settle(40);
    const screen = await connectClient(portOf(app), 'screen');

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
    const pack = await loadScenario('kopitiam');
    const store = new MemoryStore();
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      persistence,
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 5,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    });
    apps.push(app);
    await connectService(app);
    expect((await join(app, 'Guest', 'producer')).status).toBe(200);
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    people = [];
    await waitFor(
      () => (clock.snapshot().pauseKind === 'empty-room' ? true : undefined),
      'the empty-room pause',
    );
    const screen = await connectClient(portOf(app), 'screen');

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
    const pack = await loadScenario('kopitiam');
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 50,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    });
    apps.push(app);
    await connectService(app);
    expect((await join(app, 'Guest', 'producer')).status).toBe(200);
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

  it('publishes the paused record to the screen on auto-pause and auto-resume', async () => {
    const pack = await loadScenario('kopitiam');
    let people: Array<{ name: string }> = [];
    const clock = createAgendaClock({ agenda: pack.agenda });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 10,
      emptyRoomPauseMs: 5,
      meetingPaused: () => pausedOf(clock),
      meetingPause: pauseControl(clock),
    });
    apps.push(app);
    await connectService(app);
    expect((await join(app, 'Guest', 'producer')).status).toBe(200);
    // The roster sees the guest as soon as they have joined, before Start, so the meeting does not
    // auto-pause between Start and the screen connecting.
    people = [{ name: 'Guest' }];
    expect((await startMeeting(app)).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');

    const screen = await connectClient(portOf(app), 'screen');
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
