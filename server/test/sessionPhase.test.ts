import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MeetingSetup, Scenario } from '@kaki/shared';
import { createApp, type CreateAppOptions, type KakiApp } from '../src/app';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { connectClient, portOf, settle, waitFor, waitForEvent } from './helpers';
import { testScenario } from './fixtures/scenario';

const serviceToken = 'session-phase-runner-token';

const packScenario: Scenario = {
  ...testScenario,
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
    { name: 'Cy', role: 'barista', zoomDisplayName: 'Cy (Barista)' },
  ],
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'barista', label: 'Barista' },
  ],
  agenda: [
    {
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before service',
      ownerRole: 'chef',
      decision: 'Do we prep as planned?',
    },
    {
      title: 'Close',
      minutes: 4,
      canWait: true,
      deadline: 'today',
      ownerRole: 'cashier',
      decision: 'Who closes the till?',
    },
  ],
  excludedPairs: [['Prep', 'Close']],
  npcs: [
    { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant', playable: true },
    { attendee: 'Bao', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
    { attendee: 'Cy', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' },
  ],
};

function freshScenario(): Scenario {
  return structuredClone(packScenario);
}

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

async function startApp(scenario: Scenario, options: Omit<CreateAppOptions, 'scenario'> = {}): Promise<KakiApp> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    rejoinPollMs: 60_000,
    ...options,
  });
  apps.push(app);
  return app;
}

function startMeeting(app: KakiApp): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/start`, { method: 'POST' });
}

async function join(app: KakiApp, participantName: string, participantRole: string): Promise<Response> {
  await fetch(`http://localhost:${portOf(app)}/api/meeting/open`, { method: 'POST' });
  return fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName, participantRole }),
  });
}

async function getScenario(app: KakiApp, token?: string): Promise<Scenario> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/scenario`, {
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Scenario;
}

async function getSetup(app: KakiApp): Promise<{ setup: MeetingSetup; started: boolean; phase: string }> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/setup`);
  expect(response.status).toBe(200);
  return (await response.json()) as { setup: MeetingSetup; started: boolean; phase: string };
}

function putSetup(app: KakiApp, setup: MeetingSetup): Promise<Response> {
  return fetch(`http://127.0.0.1:${portOf(app)}/api/setup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
}

interface PrepareRequest {
  requestId: string;
  attempt: string;
  meetingId: string;
}

async function connectHeldService(
  port: number,
  token?: string,
): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`, {
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
  const prepares: PrepareRequest[] = [];
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: Partial<PrepareRequest>;
    };
    const { requestId, attempt, meetingId } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
      return;
    }
    prepares.push({ requestId, attempt, meetingId });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    prepares,
    reply(kind, reason) {
      const last = prepares.at(-1);
      if (last === undefined) throw new Error('No prepare request to answer');
      socket.send(
        JSON.stringify({
          kind,
          requestId: last.requestId,
          attempt: last.attempt,
          meetingId: last.meetingId,
          ...(reason === undefined ? {} : { reason }),
        }),
      );
    },
  };
}

describe('Start lifecycle', () => {
  it('returns to lobby with the active scenario untouched when the runner refuses', async () => {
    const app = await startApp(freshScenario());
    const service = await connectHeldService(portOf(app));
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    const before = await getScenario(app);

    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('failed', 'cast unavailable');

    expect((await starting).status).toBe(503);
    expect(app.session.phase()).toBe('lobby');
    expect(await getScenario(app)).toEqual(before);
  });

  it('shows the Start candidate to the service channel only, and refuses joins while starting', async () => {
    const app = await startApp(freshScenario(), { serviceToken });
    const service = await connectHeldService(portOf(app), serviceToken);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    const before = await getScenario(app);

    const draft = (await getSetup(app)).setup;
    draft.title = 'The sealed meeting';
    draft.agenda = [{ id: 'agenda-1', title: 'Close', minutes: 2, ownerRoleId: 'cashier' }];
    expect((await putSetup(app, draft)).status).toBe(200);

    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');

    expect((await getScenario(app, serviceToken)).meetingTitle).toBe('The sealed meeting');
    expect((await getScenario(app, serviceToken)).agenda.map((item) => item.title)).toEqual(['Close']);
    expect(await getScenario(app)).toEqual(before);

    const refused = await join(app, 'Late', 'cashier');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'The meeting is starting; try again in a moment.',
      retryable: true,
    });

    service.reply('ready');
    expect((await starting).status).toBe(200);
    expect((await getScenario(app)).meetingTitle).toBe('The sealed meeting');
  });

  it('blames the reset, not the runner, when the meeting resets while Start is in flight', async () => {
    const app = await startApp(freshScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    const service = await connectHeldService(portOf(app));
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset');
    screen.close();

    const response = await starting;
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/reset while it was starting/);
    expect(app.session.phase()).toBe('lobby');
  });

  it('makes a Start wait for an in-flight admission so that admission cannot cancel it', async () => {
    let calls = 0;
    let releaseRoster: (() => void) | undefined;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const app = await startApp(structuredClone(testScenario), {
      roomRoster: async () => {
        calls += 1;
        if (calls === 2) await rosterGate;
        return [];
      },
    });
    const first = await join(app, 'Guest', 'chef');
    expect(first.status).toBe(200);
    const { meetingCode } = (await first.json()) as { meetingCode: string };

    const lateJoin = fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Late', participantRole: 'cashier', meetingCode }),
    });
    await waitFor(() => (calls === 2 ? true : undefined), 'the late join to reach the roster');
    const starting = startMeeting(app);
    await settle(20);
    // Start is queued behind the admission, so it has not begun while the roster is still held.
    expect(app.session.phase()).toBe('lobby');

    releaseRoster?.();
    expect((await lateJoin).status).toBe(200);
    const atStart = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
    };

    const started = await starting;
    expect(started.status).toBe(200);
    expect(app.session.phase()).toBe('running');
    const after = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
      started: boolean;
    };
    expect(after).toMatchObject({ meetingId: atStart.meetingId, started: true });
  });

  it('refuses a Start that waited through a reset instead of starting the replacement meeting', async () => {
    let calls = 0;
    let releaseRoster: (() => void) | undefined;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const app = await startApp(structuredClone(testScenario), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      roomRoster: async () => {
        calls += 1;
        if (calls === 2) await rosterGate;
        return [];
      },
    });
    const first = await join(app, 'Guest', 'chef');
    expect(first.status).toBe(200);
    const { meetingCode } = (await first.json()) as { meetingCode: string };

    const lateJoin = fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Late', participantRole: 'cashier', meetingCode }),
    });
    await waitFor(() => (calls === 2 ? true : undefined), 'the late join to reach the roster');
    const starting = startMeeting(app);
    await settle(20);
    expect(app.session.phase()).toBe('lobby');

    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset');
    screen.close();
    const replacement = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
    };

    releaseRoster?.();
    expect([403, 409]).toContain((await lateJoin).status);

    const response = await starting;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The meeting was reset before it could start; press Start again.',
    });
    expect(app.session.phase()).toBe('lobby');
    const state = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
      started: boolean;
    };
    expect(state).toMatchObject({ meetingId: replacement.meetingId, started: false });
  });

  it('times out a Start that waited in the admission queue so it never runs later', async () => {
    let calls = 0;
    let releaseRoster: (() => void) | undefined;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const app = await startApp(structuredClone(testScenario), {
      startAckTimeoutMs: 50,
      roomRoster: async () => {
        calls += 1;
        if (calls === 2) await rosterGate;
        return [];
      },
    });
    const first = await join(app, 'Guest', 'chef');
    expect(first.status).toBe(200);
    const { meetingCode } = (await first.json()) as { meetingCode: string };

    const lateJoin = fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Late', participantRole: 'cashier', meetingCode }),
    });
    await waitFor(() => (calls === 2 ? true : undefined), 'the late join to reach the roster');

    const starting = startMeeting(app);
    await settle(120);
    const timedOut = await starting;
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toMatchObject({ retryable: true });
    expect(app.session.phase()).toBe('lobby');

    releaseRoster?.();
    expect((await lateJoin).status).toBe(200);
    await settle(50);
    expect(app.session.phase()).toBe('lobby');
    const state = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      started: boolean;
    };
    expect(state.started).toBe(false);

    expect((await startMeeting(app)).status).toBe(200);
  });

  it('refuses an admission whose meeting changed while it waited, without mutating it', async () => {
    let calls = 0;
    let releaseRoster: (() => void) | undefined;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const app = await startApp(structuredClone(testScenario), {
      roomRoster: async () => {
        calls += 1;
        if (calls === 2) await rosterGate;
        return [];
      },
    });
    const first = await join(app, 'Guest', 'chef');
    expect(first.status).toBe(200);
    const { meetingCode } = (await first.json()) as { meetingCode: string };

    const lateJoin = fetch(`http://localhost:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Late', participantRole: 'cashier', meetingCode }),
    });
    await waitFor(() => (calls === 2 ? true : undefined), 'the late join to reach the roster');
    const replacement = app.session.reset({ rotateCode: false });
    releaseRoster?.();

    const response = await lateJoin;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The meeting changed while you were joining; try again in a moment.',
      retryable: true,
    });
    const state = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
      started: boolean;
    };
    expect(state).toMatchObject({ meetingId: replacement, started: false });
  });

  it('refuses Start after the meeting ended and lets the owner write the next draft', async () => {
    const app = await startApp(freshScenario(), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    });
    const service = await connectHeldService(portOf(app));
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);
    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('ready');
    expect((await starting).status).toBe(200);

    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING',
      'the meeting to end',
    );
    screen.close();
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the ended phase');

    const ended = await getSetup(app);
    expect(ended.started).toBe(false);
    expect(ended.phase).toBe('ended');

    const next = ended.setup;
    next.title = 'Tomorrow huddle';
    expect((await putSetup(app, next)).status).toBe(200);

    const refused = await startMeeting(app);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'This meeting has ended; press New meeting to start the next one.',
    });

    const after = await getSetup(app);
    expect(after.started).toBe(false);
    expect(after.phase).toBe('ended');
    expect(after.setup.title).toBe('Tomorrow huddle');
  });

  it('accepts a task for a role the owner added to the sealed setup', async () => {
    const app = await startApp(freshScenario());
    const service = await connectHeldService(portOf(app));
    const setup = (await getSetup(app)).setup;
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.agenda.push({ id: 'agenda-3', title: 'Runner handover', minutes: 2, ownerRoleId: 'runner' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('ready');
    expect((await starting).status).toBe(200);

    expect(() =>
      app.tasks.suggest({
        title: 'Hand over the runner',
        context: 'The owner added this role in the setup.',
        suggestedAssignee: 'runner',
      }),
    ).not.toThrow();
  });

  it('gives the clock the sealed agenda on commit and the reset agenda after a new meeting', async () => {
    const clock = createAgendaClock({ agenda: freshScenario().agenda });
    const app = await startApp(freshScenario(), {
      modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
    });
    const service = await connectHeldService(portOf(app));
    const setup = (await getSetup(app)).setup;
    setup.agenda = [
      { id: 'agenda-1', title: 'Close', minutes: 2, ownerRoleId: 'cashier' },
      { id: 'agenda-2', title: 'Prep', minutes: 3, ownerRoleId: 'chef' },
    ];
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await join(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startMeeting(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('ready');
    expect((await starting).status).toBe(200);
    expect(clock.agenda().map((item) => item.title)).toEqual(['Close', 'Prep']);
    expect(clock.agenda()).toEqual(app.session.active().agenda);

    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset');
    screen.close();
    await settle(20);

    expect(clock.agenda()).toEqual(app.session.active().agenda);
    expect(clock.agenda().map((item) => item.title)).not.toEqual(['Close', 'Prep']);
  });
});
