import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MeetingSetup, Scenario } from '@kaki/shared';
import { createMeetingModule } from '../../src/host/meeting';
import {
  connectMeetingClient,
  createPracticeTestApp,
  createRealTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  practiceModulesWith,
  realModulesWith,
  waitFor,
  type TestAppWithMeeting,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';

const packScenario: Scenario = {
  ...testScenario,
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
    { name: 'Cy', role: 'barista', displayName: 'Cy (Barista)' },
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

const apps: TestAppWithMeeting[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

function startPractice(app: TestAppWithMeeting): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
    method: 'POST',
    headers: { cookie: app.cookie! },
  });
}

function joinPractice(app: TestAppWithMeeting, participantName: string, participantRole: string): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: app.cookie! },
    body: JSON.stringify({ roomName: 'test-room', participantName, participantRole, kind: 'practice' }),
  });
}

async function getScenario(app: TestAppWithMeeting): Promise<Scenario> {
  const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario?kind=practice'));
  expect(response.status).toBe(200);
  return (await response.json()) as Scenario;
}

async function getSetup(app: TestAppWithMeeting): Promise<{ setup: MeetingSetup; started: boolean; phase: string }> {
  const response = await fetch(meetingUrl(app, app.meetingId, '/api/setup'));
  expect(response.status).toBe(200);
  return (await response.json()) as { setup: MeetingSetup; started: boolean; phase: string };
}

function putSetup(app: TestAppWithMeeting, setup: MeetingSetup): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
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
  app: TestAppWithMeeting,
): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  const socket = new WebSocket(meetingWsUrl(portOf(app), app.meetingId, 'role=service'));
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
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const service = await connectHeldService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);
    const before = await getScenario(app);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('failed', 'cast unavailable');

    expect((await starting).status).toBe(503);
    expect(app.session.phase()).toBe('lobby');
    expect(await getScenario(app)).toEqual(before);
  });

  it('refuses a token join while the meeting is starting', async () => {
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const service = await connectHeldService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');

    const refused = await joinPractice(app, 'Late', 'cashier');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'The meeting is starting; try again in a moment.',
      retryable: true,
    });

    service.reply('ready');
    expect((await starting).status).toBe(200);
  });

  it('lets a practice visitor rejoin a running meeting without failing the token request', async () => {
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const service = await connectHeldService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('ready');
    expect((await starting).status).toBe(200);
    expect(app.session.phase()).toBe('running');

    // Coming back after Leave is the same seat and the same meeting: the token is issued again,
    // and shaping the lobby a second time must not throw.
    const rejoin = await joinPractice(app, 'Guest', 'chef');
    expect(rejoin.status).toBe(200);
    const body = (await rejoin.json()) as { token: string; resumed: boolean };
    expect(body.token).not.toBe('');
    expect(body.resumed).toBe(true);
  });

  it('blames the reset, not the runner, when the meeting resets while Start is in flight', async () => {
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const service = await connectHeldService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    app.session.reset();

    const response = await starting;
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/reset while it was starting/);
    expect(app.session.phase()).toBe('lobby');
  });

  it('refuses Start after the meeting ended and lets the owner write the next draft', async () => {
    const app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario: freshScenario(),
        roomRoster: async () => [],
        meetingModules: realModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
      },
      { title: 'Weekly planning', agenda: freshScenario().agenda },
    );
    apps.push(app);
    const port = portOf(app);
    const join = () => fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Guest', participantRole: 'chef' }),
    });
    const startMeeting = () => fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
    expect((await join()).status).toBe(200);
    expect((await startMeeting()).status).toBe(200);

    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the ended phase');
    screen.close();

    const ended = await getSetup(app);
    expect(ended.started).toBe(false);
    expect(ended.phase).toBe('ended');

    const next = ended.setup;
    next.title = 'Tomorrow huddle';
    expect((await putSetup(app, next)).status).toBe(200);

    const refused = await startMeeting();
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
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      practiceModules: practiceModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    });
    apps.push(app);
    const service = await connectHeldService(app);
    const setup = (await getSetup(app)).setup;
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.agenda.push({ id: 'agenda-3', title: 'Runner handover', minutes: 2, ownerRoleId: 'runner' });
    expect((await putSetup(app, setup)).status).toBe(200);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startPractice(app);
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
});
