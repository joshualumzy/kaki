import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MeetingSetup, Scenario } from '@kaki/shared';
import { createApp, type CreateAppOptions, type KakiApp } from '../../src/app';
import { createAgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { LEGACY_MEETING_ID } from '../../src/meeting/registry';
import { createMeetingPersistence } from '../../src/persist/persistence';
import type { MeetingStateStore, StoredMeeting } from '../../src/persist/state';
import {
  connectClient,
  connectMeetingClient,
  createPracticeTestApp,
  createRealTestApp,
  meetingUrl,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  waitForEvent,
  type TestAppWithMeeting,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';

/** A saved meeting whose next clear waits, so a test can tell when a reset is about to queue. */
class GatedStore implements MeetingStateStore {
  saved: StoredMeeting | undefined;
  readonly clearStarted: Promise<void>;
  private readonly gate: Promise<void>;
  private reached!: () => void;
  private release!: () => void;
  private armed = false;

  constructor() {
    this.clearStarted = new Promise((resolve) => {
      this.reached = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  /** Hold the next clear; earlier clears (a meeting opened before the reset) pass straight through. */
  arm(): void {
    this.armed = true;
  }
  releaseClear(): void {
    this.release();
  }
  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }
  async save(meeting: StoredMeeting): Promise<void> {
    this.saved = meeting;
  }
  async clear(): Promise<void> {
    this.saved = undefined;
    if (!this.armed) return;
    this.armed = false;
    this.reached();
    await this.gate;
  }
}

/**
 * Start the legacy meeting inside this process, so its admission is queued before the caller's next
 * line instead of racing an HTTP request through the event loop.
 */
function startInProcess(app: KakiApp): Promise<{ status: number; body: Record<string, unknown> }> {
  return (async () => {
    const instance = await app.registry.get(LEGACY_MEETING_ID);
    if (instance === undefined) throw new Error('the legacy meeting is missing');
    const request = {
      method: 'POST',
      url: '/api/meeting/start',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    let status = 0;
    let text = '';
    const response = {
      get writableEnded() {
        return false;
      },
      writeHead(value: number) {
        status = value;
        return response;
      },
      end(chunk: string) {
        text = chunk;
      },
    } as unknown as ServerResponse;
    await instance.handle(request, response, '/api/meeting/start');
    return { status, body: JSON.parse(text) as Record<string, unknown> };
  })();
}

const serviceToken = 'session-phase-runner-token';

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
  meetingId?: string,
): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  const url =
    meetingId === undefined
      ? `ws://127.0.0.1:${port}/ws?role=service`
      : `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meetingId)}&role=service`;
  const socket = new WebSocket(url, {
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

async function getPracticeScenario(app: TestAppWithMeeting): Promise<Scenario> {
  const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario?kind=practice'));
  expect(response.status).toBe(200);
  return (await response.json()) as Scenario;
}

async function connectHeldPracticeService(
  app: TestAppWithMeeting,
): Promise<{
  socket: WebSocket;
  prepares: PrepareRequest[];
  reply(kind: 'ready' | 'failed', reason?: string): void;
}> {
  return connectHeldService(portOf(app), undefined, app.meetingId);
}

function joinReal(app: TestAppWithMeeting, participantName: string): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room', participantName }),
  });
}

function startReal(app: TestAppWithMeeting): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
}

async function getRealSetup(app: TestAppWithMeeting): Promise<{ setup: MeetingSetup; started: boolean; phase: string }> {
  const response = await fetch(meetingUrl(app, app.meetingId, '/api/setup'));
  expect(response.status).toBe(200);
  return (await response.json()) as { setup: MeetingSetup; started: boolean; phase: string };
}

function putRealSetup(app: TestAppWithMeeting, setup: MeetingSetup): Promise<Response> {
  return fetch(meetingUrl(app, app.meetingId, '/api/setup'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(setup),
  });
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
    const service = await connectHeldPracticeService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);
    const before = await getPracticeScenario(app);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    service.reply('failed', 'cast unavailable');

    expect((await starting).status).toBe(503);
    expect(app.session.phase()).toBe('lobby');
    expect(await getPracticeScenario(app)).toEqual(before);
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
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: freshScenario(),
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
    });
    apps.push(app);
    const service = await connectHeldPracticeService(app);
    expect((await joinPractice(app, 'Guest', 'chef')).status).toBe(200);

    const starting = startPractice(app);
    await waitFor(() => (service.prepares.length === 1 ? true : undefined), 'the runner prepare');
    app.session.reset();

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

  it('keeps a New meeting reset waiting for the join admission already signing', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reachedRoster = new Promise<void>((resolve) => { entered = resolve; });
    const rosterGate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const app = await startApp(structuredClone(testScenario), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      roomRoster: async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await rosterGate;
        }
        return [];
      },
    });
    const state = async (): Promise<{ meetingId: string }> =>
      (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as { meetingId: string };
    const before = await state();

    const joining = join(app, 'Guest', 'chef');
    await reachedRoster;
    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await settle(80);

    // The join still owns admission: the reset must not slip in while its room token is being signed.
    expect((await state()).meetingId).toBe(before.meetingId);
    expect(screen.messages.some((event) => event.type === 'MEETING_RESET')).toBe(false);

    release();
    expect((await joining).status).toBe(200);
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the queued reset');
    expect((await state()).meetingId).not.toBe(before.meetingId);
    screen.close();
  });

  it('refuses a Start that waited through a reset instead of starting the replacement meeting', async () => {
    const store = new GatedStore();
    let calls = 0;
    let releaseRoster: (() => void) | undefined;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    const app = await startApp(structuredClone(testScenario), {
      modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
      persistence: createMeetingPersistence({ store, log: () => undefined }),
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
    // Queue the reset before Start, so it runs first once the in-flight admission finishes. Waiting
    // for the saved clear tells us the command arrived, instead of hoping a sleep outlasts delivery.
    const screen = await connectClient(portOf(app), 'screen');
    store.arm();
    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await store.clearStarted;
    store.releaseClear();
    // Let the reset's admission queue behind the in-flight join before Start queues after it.
    await settle(0);
    const starting = startInProcess(app);
    await settle(0);
    expect(app.session.phase()).toBe('lobby');

    releaseRoster?.();
    // The admission in flight completes under the meeting it was admitted to; the reset follows it.
    expect((await lateJoin).status).toBe(200);
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'the reset');
    screen.close();
    const replacement = (await (await fetch(`http://127.0.0.1:${portOf(app)}/api/meeting/state`)).json()) as {
      meetingId: string;
    };

    const response = await starting;
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
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
    expect((await joinReal(app, 'Guest')).status).toBe(200);
    expect((await startReal(app)).status).toBe(200);

    const screen = await connectMeetingClient(portOf(app), app.meetingId, 'screen');
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the ended phase');
    screen.close();

    const ended = await getRealSetup(app);
    expect(ended.started).toBe(false);
    expect(ended.phase).toBe('ended');

    const next = ended.setup;
    next.title = 'Tomorrow huddle';
    expect((await putRealSetup(app, next)).status).toBe(200);

    const refused = await startReal(app);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'This meeting has ended; press New meeting to start the next one.',
    });

    const after = await getRealSetup(app);
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
