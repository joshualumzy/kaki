import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp, type KakiApp } from '../src/app';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { loadScenario } from '../src/loadScenario';
import { createMeetingCodeSource, type MeetingCodeSource } from '../src/meetingCode';
import { connectClient, portOf, settle, waitForEvent, type TestClient } from './helpers';
import { testScenario } from './fixtures/scenario';

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

interface StartedMeeting {
  app: KakiApp;
  screen: TestClient;
  people: Array<{ name: string; role?: string }>;
  meetingCode: MeetingCodeSource;
  meetingId: string;
  code: string;
  taskId: string;
}

function baseUrl(app: KakiApp): string {
  return `http://127.0.0.1:${portOf(app)}`;
}

function join(
  app: KakiApp,
  body: { participantName: string; participantRole: string; meetingCode?: string },
): Promise<Response> {
  return fetch(`${baseUrl(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', ...body }),
  });
}

async function connectService(port: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`);
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

async function emptyRoom(meeting: StartedMeeting): Promise<void> {
  meeting.people.length = 0;
  // Let the previous join's seat reservation expire, so the room really looks empty to admission.
  await settle(30);
}

async function meetingState(app: KakiApp): Promise<{ meetingId: string; started: boolean }> {
  return (await (await fetch(`${baseUrl(app)}/api/meeting/state`)).json()) as {
    meetingId: string;
    started: boolean;
  };
}

function resetCount(client: TestClient): number {
  return client.messages.filter((event) => event.type === 'MEETING_RESET').length;
}

async function startedMeeting(
  setup: (app: KakiApp) => void | Promise<void> = () => undefined,
): Promise<StartedMeeting> {
  const scenario = await loadScenario('kopitiam');
  const people: Array<{ name: string; role?: string }> = [];
  const meetingCode = createMeetingCodeSource();
  const app = await createApp({
    scenario,
    meetingCode,
    roomRoster: async () => people,
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    admissionReservationMs: 20,
    devRoutes: true,
  });
  apps.push(app);
  const port = portOf(app);
  const screen = await connectClient(port, 'screen');
  clients.push(screen);
  await connectService(port);
  await setup(app);

  const first = await join(app, { participantName: 'Booth Playtest', participantRole: 'producer' });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { meetingCode: string };
  people.push({ name: 'Booth Playtest', role: 'producer' });
  expect((await fetch(`${baseUrl(app)}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
  const task = app.tasks.suggest({
    title: 'Keep this card',
    context: 'From the running meeting',
    suggestedAssignee: 'producer',
  });
  await settle();
  const state = await meetingState(app);
  expect(state.started).toBe(true);

  screen.messages.length = 0;
  return {
    app,
    screen,
    people,
    meetingCode,
    meetingId: state.meetingId,
    code: firstBody.meetingCode,
    taskId: task.id,
  };
}

describe('join admission decides before it resets', () => {
  it('refuses an AI attendee name in a momentarily empty room without wiping the meeting', async () => {
    const meeting = await startedMeeting();
    await emptyRoom(meeting);

    const refused = await join(meeting.app, { participantName: 'Sam', participantRole: 'producer' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/AI attendee/i);

    expect(await meetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.meetingCode.value).toBe(meeting.code);
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    await settle();
    expect(resetCount(meeting.screen)).toBe(0);
  });

  it('refuses an over-long name in a momentarily empty room without wiping the meeting', async () => {
    const meeting = await startedMeeting();
    await emptyRoom(meeting);

    const refused = await join(meeting.app, {
      participantName: 'x'.repeat(61),
      participantRole: 'producer',
    });
    expect(refused.status).toBe(400);

    expect(await meetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.meetingCode.value).toBe(meeting.code);
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    await settle();
    expect(resetCount(meeting.screen)).toBe(0);
  });

  it('still refuses a wrong code in a non-empty room without resetting', async () => {
    // Two human seats so the room can be non-empty without the wanted seat being taken.
    const people: Array<{ name: string; role?: string }> = [];
    const meetingCode = createMeetingCodeSource();
    const app = await createApp({
      scenario: testScenario,
      meetingCode,
      roomRoster: async () => people,
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      admissionReservationMs: 20,
    });
    apps.push(app);
    const screen = await connectClient(portOf(app), 'screen');
    clients.push(screen);

    const first = await join(app, { participantName: 'Ada', participantRole: 'chef' });
    expect(first.status).toBe(200);
    people.push({ name: 'Ada', role: 'chef' });
    expect((await fetch(`${baseUrl(app)}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    const task = app.tasks.suggest({
      title: 'Keep this card',
      context: 'From the running meeting',
      suggestedAssignee: 'chef',
    });
    await settle();
    const state = await meetingState(app);
    expect(state.started).toBe(true);
    const code = meetingCode.value;
    screen.messages.length = 0;

    const refused = await join(app, {
      participantName: 'Bao',
      participantRole: 'cashier',
      meetingCode: 'WRONG1',
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { needsCode?: boolean }).needsCode).toBe(true);

    expect(await meetingState(app)).toMatchObject({ meetingId: state.meetingId, started: true });
    expect(meetingCode.value).toBe(code);
    expect(app.tasks.get(task.id)?.title).toBe('Keep this card');
    await settle();
    expect(resetCount(screen)).toBe(0);
  });

  it('resets exactly once when a valid stranger joins the empty room', async () => {
    const meeting = await startedMeeting();
    await emptyRoom(meeting);
    let subscriberResets = 0;
    const unsubscribe = meeting.app.hub.subscribe((event) => {
      if (event.type === 'MEETING_RESET') subscriberResets += 1;
    });

    try {
      const joined = await join(meeting.app, { participantName: 'Guest', participantRole: 'producer' });
      expect(joined.status).toBe(200);
      const body = (await joined.json()) as { meetingCode: string; started?: boolean };
      expect(body.started).toBe(false);
      expect(meeting.app.tasks.get(meeting.taskId)).toBeUndefined();

      await waitForEvent(meeting.screen, (event) => event.type === 'MEETING_RESET', 'the one reset');
      await settle();
      expect(resetCount(meeting.screen)).toBe(1);
      expect(subscriberResets).toBe(1);
      expect((await meetingState(meeting.app)).meetingId).not.toBe(meeting.meetingId);
      expect(body.meetingCode).toBe(meeting.meetingCode.value);
      expect(body.meetingCode).not.toBe(meeting.code);
    } finally {
      unsubscribe();
    }
  });
});

describe('foreign resets', () => {
  it('refuses a MEETING_RESET published outside the meeting session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const meeting = await startedMeeting();
    const resetsBefore = resetCount(meeting.screen);
    let resetSubscriberRuns = 0;
    const unsubscribe = meeting.app.hub.subscribe((event) => {
      if (event.type === 'MEETING_RESET') resetSubscriberRuns += 1;
    });

    try {
      expect(() =>
        meeting.app.hub.publish({
          type: 'MEETING_RESET',
          audience: { kind: 'all' },
          payload: { meetingId: 'foreign-meeting' },
        }),
      ).toThrow(/MEETING_RESET/);
      await settle();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('refused to publish a MEETING_RESET'));
      expect(resetSubscriberRuns).toBe(0);
      expect(resetCount(meeting.screen)).toBe(resetsBefore);
      expect(await meetingState(meeting.app)).toMatchObject({
        meetingId: meeting.meetingId,
        started: true,
      });
      expect(meeting.meetingCode.value).toBe(meeting.code);
      expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
    } finally {
      unsubscribe();
    }
  });

  it('refuses a MEETING_RESET sent through the event-injection routes', async () => {
    const meeting = await startedMeeting();
    const resetsBefore = resetCount(meeting.screen);

    const res = await fetch(`${baseUrl(meeting.app)}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'MEETING_RESET',
        audience: { kind: 'all' },
        payload: { meetingId: 'foreign-meeting' },
      }),
    });
    await settle();

    expect(res.status).toBe(400);
    expect(resetCount(meeting.screen)).toBe(resetsBefore);
    expect(await meetingState(meeting.app)).toMatchObject({
      meetingId: meeting.meetingId,
      started: true,
    });
    expect(meeting.app.tasks.get(meeting.taskId)?.title).toBe('Keep this card');
  });
});

describe('New meeting', () => {
  it('resets once and resets the agenda clock once', async () => {
    const clock = createAgendaClock({ agenda: (await loadScenario('kopitiam')).agenda });
    const reset = vi.spyOn(clock, 'reset');
    const scenario = await loadScenario('kopitiam');
    const app = await createApp({
      scenario,
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const port = portOf(app);
    const screen = await connectClient(port, 'screen');
    clients.push(screen);
    await connectService(port);

    expect((await join(app, { participantName: 'Booth Playtest', participantRole: 'producer' })).status).toBe(200);
    expect((await fetch(`${baseUrl(app)}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    screen.messages.length = 0;
    reset.mockClear();

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the New meeting reset');
    await settle();

    expect(screen.messages.filter((event) => event.type === 'MEETING_RESET')).toHaveLength(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
