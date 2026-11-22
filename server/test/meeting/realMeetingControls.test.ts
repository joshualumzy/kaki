import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent, Role, Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createAgendaClock, type AgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMeetingPersistence, type MeetingPersistence } from '../../src/persist/persistence';
import type { StoredMeeting } from '../../src/persist/state';
import type { KakiModule } from '../../src/core/modules';
import type { MeetingModules } from '../../src/modules';
import { createFakeLlm, type LlmClient } from '../../src/services/llm';
import { testScenario } from '../fixtures/scenario';
import { portOf, waitFor } from '../helpers';

const SERVICE_TOKEN = 'real-meeting-controls-token';
const OWNER_PICTURE = 'https://photos.example/ada.jpg';

const realScenario: Scenario = {
  ...testScenario,
  meetingTitle: 'Weekly planning',
  agenda: [{ title: 'Budget', minutes: 10, canWait: false, deadline: 'today', ownerRole: 'chef' }],
};

/** A real meeting with one AI seat, so Start must ask the runner. */
const aiScenario: Scenario = {
  ...realScenario,
  roles: [...realScenario.roles, { id: 'manager', label: 'Manager' }],
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Cy', role: 'manager', displayName: 'Cy (Manager)' },
  ],
  npcs: [
    {
      attendee: 'Cy',
      voice: 'test-voice',
      personality: 'Quiet.',
      agenda: 'Keep the kitchen running.',
      concerns: [],
    },
  ],
};

interface Socket {
  ws: WebSocket;
  messages: KakiEvent[];
  close(): void;
}

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw == null ? [] : [raw];
}

function cookiePair(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0];
}

async function signIn(store: AuthStore, name: string, picture?: string): Promise<SignedIn> {
  const email = `${randomUUID()}@example.com`;
  const user = await store.createGoogleUser({
    googleSub: randomUUID(),
    name,
    email,
    ...(picture === undefined ? {} : { picture }),
  });
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
  return { user, cookie: `kaki_session=${token}` };
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown; token?: string } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function connect(
  port: number,
  meetingId: string,
  query: { role?: string; audience?: string },
  cookie?: string,
): Promise<Socket> {
  const params = new URLSearchParams({ meeting: meetingId });
  if (query.role !== undefined) params.set('role', query.role);
  if (query.audience !== undefined) params.set('audience', query.audience);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${params.toString()}`, {
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, close: () => ws.close() }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`upgrade refused with HTTP ${response.statusCode ?? 0}`));
    });
  });
}

interface FakeModuleOptions {
  llm?: LlmClient;
  notetakerIntervalMs?: number;
}

function fakeModules(clock: AgendaClock, options: FakeModuleOptions = {}): MeetingModules {
  const snapshot = () => clock.snapshot();
  return {
    modules: [
      createMeetingModule({
        clock,
        notetakerIntervalMs: options.notetakerIntervalMs ?? 60_000,
        ...(options.llm === undefined ? {} : { llm: options.llm }),
      }),
    ],
    meetingElapsedSeconds: () => (snapshot().started ? snapshot().meetingElapsedSeconds : undefined),
    meetingAgendaIndex: () => (snapshot().started ? snapshot().agendaIndex : undefined),
    meetingPaused: () => (snapshot().started ? snapshot().paused === true : undefined),
    meetingPause: {
      paused: () => (snapshot().started ? snapshot().paused === true : undefined),
      kind: () => snapshot().pauseKind,
      pause: (kind) => clock.pause(kind),
      resume: () => clock.resume(),
    },
  };
}

interface Built {
  app: KakiApp;
  base: string;
  port: number;
  store: AuthStore;
  meetings: MeetingStore;
  clock: AgendaClock;
}

/** One in-memory meeting_state row per meeting id, shared across a restart. */
class FakeStateStore {
  readonly rows = new Map<string, StoredMeeting>();
  forId(id: string) {
    return {
      load: async (): Promise<StoredMeeting | undefined> => this.rows.get(id),
      save: async (meeting: StoredMeeting): Promise<void> => {
        this.rows.set(id, meeting);
      },
      clear: async (): Promise<void> => {
        this.rows.delete(id);
      },
    };
  }
}

const apps: KakiApp[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

async function buildApp(
  options: {
    now?: () => number;
    meetingModule?: FakeModuleOptions;
    scenario?: Scenario;
    startAckTimeoutMs?: number;
    modules?: MeetingModules['modules'];
  } = {},
): Promise<Built> {
  const store = createMemoryAuthStore();
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({ store, meetingCode });
  const meetings = createMemoryMeetingStore();
  const clock = createAgendaClock({
    agenda: realScenario.agenda,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const app = await createApp({
    scenario: options.scenario ?? realScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings,
    serviceToken: SERVICE_TOKEN,
    roomRoster: async () => [],
    ...(options.startAckTimeoutMs === undefined ? {} : { startAckTimeoutMs: options.startAckTimeoutMs }),
    meetingModules: () => {
      const built = fakeModules(clock, options.meetingModule);
      return {
        ...built,
        modules: [...built.modules, ...(options.modules ?? [])],
      };
    },
  });
  apps.push(app);
  return { app, base: `http://127.0.0.1:${portOf(app)}`, port: portOf(app), store, meetings, clock };
}

async function createAndOpen(
  built: Built,
  owner: SignedIn,
  agenda: Array<{ title: string; minutes?: number }> = [],
): Promise<string> {
  const meeting = await built.app.registry.create({
    workspaceId: 'workspace-1',
    ownerUserId: owner.user.id,
    title: 'Weekly planning',
    ...(agenda.length === 0 ? {} : { agenda }),
  });
  expect(
    (await request(built.base, `/api/meetings/${meeting.id}/meeting/open`, {
      method: 'POST',
      cookie: owner.cookie,
    })).status,
  ).toBe(200);
  return meeting.id;
}

async function join(
  built: Built,
  meetingId: string,
  cookie: string | undefined,
  name: string,
  role: string,
  meetingCode?: string,
): Promise<{ response: Response; cookie: string | undefined; meetingCode: string; seat: string }> {
  const response = await request(built.base, `/api/meetings/${meetingId}/livekit/token`, {
    method: 'POST',
    ...(cookie === undefined ? {} : { cookie }),
    body: {
      participantName: name,
      participantRole: role,
      ...(meetingCode === undefined ? {} : { meetingCode }),
    },
  });
  const body = (await response.json()) as { meetingCode?: string; participantRole?: string };
  return {
    response,
    cookie: cookiePair(setCookies(response), 'kaki_session') ?? cookie,
    meetingCode: body.meetingCode ?? '',
    seat: body.participantRole ?? role,
  };
}

function lastState(socket: Socket): KakiEvent | undefined {
  return [...socket.messages].reverse().find((event) => event.type === 'MEETING_STATE');
}

describe('real meeting controls', () => {
  it('waits for the owner, then shows participants with their Google photo', async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada', OWNER_PICTURE);
    const meetingId = await createAndOpen(built, owner);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);

    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(joined.response.status).toBe(200);
    const waiting = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.waitingForOwner ? state : undefined;
    }, 'the pre-Start state');
    if (waiting.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(waiting.payload.ownerName).toBe('Ada');
    expect(waiting.payload.started).toBe(false);
    expect(waiting.payload.participants).toEqual([
      { name: 'ada', displayName: 'Ada', seat: joined.seat, photoUrl: OWNER_PICTURE },
    ]);

    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(started.status).toBe(200);
    const running = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.started ? state : undefined;
    }, 'the running state');
    if (running.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(running.payload.waitingForOwner).toBe(false);
  });

  it('keeps the room off the record until anyone resumes, with nothing transcribed and the runner told to stop listening', async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(started.status).toBe(200);

    screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: true }));
    const off = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.offTheRecord !== null ? state : undefined;
    }, 'the off-the-record state');
    if (off.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(Number.isFinite(Date.parse(off.payload.offTheRecord!.since))).toBe(true);

    const runnerState = (await (
      await request(built.base, `/api/meetings/${meetingId}/runner/meeting-state`, { token: SERVICE_TOKEN })
    ).json()) as { offTheRecord?: { since?: string } | null };
    expect(runnerState.offTheRecord?.since).toBe(off.payload.offTheRecord!.since);

    const emitted = await request(built.base, `/api/meetings/${meetingId}/runner/emit`, {
      method: 'POST',
      token: SERVICE_TOKEN,
      body: {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Ada (Chef)', text: 'This must never be kept.', timestamp: new Date().toISOString() },
      },
    });
    expect(emitted.status).toBe(200);
    expect(await emitted.json()).toMatchObject({ ok: true, ignored: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.messages.some((event) => event.type === 'TRANSCRIPT_CHUNK')).toBe(false);

    screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: false }));
    await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.offTheRecord === null ? state : undefined;
    }, 'the back-on-the-record state');

    const instance = await built.app.registry.get(meetingId);
    expect(instance?.session.offTheRecordSpans()).toHaveLength(1);
    expect(instance?.session.offTheRecordSpans()[0]?.to).toBeDefined();

    await request(built.base, `/api/meetings/${meetingId}/runner/emit`, {
      method: 'POST',
      token: SERVICE_TOKEN,
      body: {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Ada (Chef)', text: 'Back on the record.', timestamp: new Date().toISOString() },
      },
    });
    await waitFor(
      () => screen.messages.find((event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'Back on the record.'),
      'the resumed transcript line',
    );
  });

  it('tells a module which seat holders are guests and which are signed in', async () => {
    let lookup: ((role: Role) => boolean | undefined) | undefined;
    const capture: KakiModule = {
      name: 'capture-seat-identity',
      start(ctx) {
        lookup = ctx.seatIsGuest;
      },
    };
    const built = await buildApp({ modules: [capture] });
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const ownerJoin = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(ownerJoin.response.status).toBe(200);
    const ownerSocket = await connect(built.port, meetingId, { role: ownerJoin.seat }, ownerJoin.cookie);
    sockets.push(ownerSocket);

    const guestJoin = await request(built.base, `/api/meetings/${meetingId}/join`, {
      method: 'POST',
      body: { name: 'Guest' },
    });
    expect(guestJoin.status).toBe(200);
    const guestCookie = cookiePair(setCookies(guestJoin), 'kaki_session');
    const guest = await join(built, meetingId, guestCookie, 'Guest', 'cashier', ownerJoin.meetingCode);
    expect(guest.response.status).toBe(200);
    const guestSocket = await connect(built.port, meetingId, { role: guest.seat }, guest.cookie);
    sockets.push(guestSocket);

    await waitFor(() => lookup?.(ownerJoin.seat) === false, 'the signed-in seat identity');
    await waitFor(() => lookup?.(guest.seat) === true, 'the guest seat identity');

    // A guest who reconnects now carries a seat principal; it must stay a guest, never a member.
    guestSocket.ws.close();
    const again = await connect(built.port, meetingId, { role: guest.seat }, guest.cookie);
    sockets.push(again);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lookup?.(guest.seat)).toBe(true);
  });

  it('refuses End from a guest and lets the owner end the meeting for everyone', async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const ownerJoin = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: ownerJoin.cookie,
    });
    expect(started.status).toBe(200);

    const guestJoin = await request(built.base, `/api/meetings/${meetingId}/join`, {
      method: 'POST',
      body: { name: 'Guest' },
    });
    expect(guestJoin.status).toBe(200);
    const guestCookie = cookiePair(setCookies(guestJoin), 'kaki_session');
    const guest = await join(built, meetingId, guestCookie, 'Guest', 'cashier', ownerJoin.meetingCode);
    expect(guest.response.status).toBe(200);
    const guestSocket = await connect(built.port, meetingId, { role: guest.seat }, guest.cookie);
    sockets.push(guestSocket);

    guestSocket.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    const refusal = await waitFor(
      () => guestSocket.messages.find((event) => event.type === 'COMMAND_REJECTED'),
      'the guest End refusal',
    );
    if (refusal.type !== 'COMMAND_REJECTED') throw new Error('not a refusal');
    expect(refusal.payload.reason).toBe('Only the shared screen can do that');

    const screen = await connect(built.port, meetingId, { audience: 'screen' }, ownerJoin.cookie);
    sockets.push(screen);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(
      () => screen.messages.find((event) => event.type === 'MEETING_STATE' && event.payload.phase === 'ended'),
      'the ended state for everyone',
    );
    const instance = await built.app.registry.get(meetingId);
    expect(instance?.session.phase()).toBe('ended');
    const row = await built.meetings.get(meetingId);
    expect(row?.status).toBe('ended');
    expect(row?.endedAt).not.toBeNull();
  });

  it("frees the owner's open slot as soon as a meeting ends, so the next opens without an unload", async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const first = await createAndOpen(built, owner);
    await createAndOpen(built, owner); // the owner's second slot
    const third = await built.app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.user.id,
      title: 'Third',
    });

    // At the cap, the join the web client makes fails first with the plain message its join page
    // shows. A refused WebSocket upgrade cannot carry a body the browser can read, so it is not
    // the message the person ever sees.
    const refused = await request(built.base, `/api/meetings/${third.id}/livekit/token`, {
      method: 'POST',
      cookie: owner.cookie,
      body: { participantName: 'Ada', participantRole: 'chef' },
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: 'busy',
      message: 'You already have 2 meetings open. End one to start another.',
    });

    // End the first through the real path: start it, then the shared screen sends END.
    const joined = await join(built, first, owner.cookie, 'Ada', 'chef');
    expect(joined.response.status).toBe(200);
    expect(
      (await request(built.base, `/api/meetings/${first}/meeting/start`, {
        method: 'POST',
        cookie: joined.cookie,
      })).status,
    ).toBe(200);
    const screen = await connect(built.port, first, { audience: 'screen' }, joined.cookie);
    sockets.push(screen);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(
      () => screen.messages.find((event) => event.type === 'MEETING_STATE' && event.payload.phase === 'ended'),
      'the first meeting to end',
    );
    await vi.waitFor(async () => {
      expect((await built.meetings.get(first))?.status).toBe('ended');
    });

    // Its slot is free at once: no unload, no idle sweep, the third opens straight away.
    const opened = await request(built.base, `/api/meetings/${third.id}/meeting/open`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(opened.status).toBe(200);
  });

  it('persists off-the-record spans with the meeting and restores them after a restart', async () => {
    const store = createMemoryAuthStore();
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, meetingCode });
    const meetings = createMemoryMeetingStore();
    const clock = createAgendaClock({ agenda: realScenario.agenda });
    const state = new FakeStateStore();
    const persistenceFor = async (id: string): Promise<MeetingPersistence | undefined> => {
      const row = state.forId(id);
      return createMeetingPersistence({ store: row, saved: await row.load(), log: () => undefined });
    };
    const app = await createApp({
      scenario: realScenario,
      speechRecognition: 'browser',
      auth,
      meetingCode,
      meetings,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      persistenceFor,
      meetingModules: () => fakeModules(clock),
    });
    apps.push(app);
    const port = portOf(app);
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.user.id,
      title: 'Weekly planning',
    });
    expect(
      (await request(`http://127.0.0.1:${port}`, `/api/meetings/${meeting.id}/meeting/open`, {
        method: 'POST',
        cookie: owner.cookie,
      })).status,
    ).toBe(200);
    const screen = await connect(port, meeting.id, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);
    const joined = await join(
      { app, base: `http://127.0.0.1:${port}`, port, store, meetings, clock },
      meeting.id,
      owner.cookie,
      'Ada',
      'chef',
    );
    expect(
      (await request(`http://127.0.0.1:${port}`, `/api/meetings/${meeting.id}/meeting/start`, {
        method: 'POST',
        cookie: joined.cookie,
      })).status,
    ).toBe(200);

    screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: true }));
    await waitFor(() => (state.rows.get(meeting.id)?.offTheRecordSince !== undefined ? true : undefined), 'the saved open span');
    screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: false }));
    await waitFor(
      () => (state.rows.get(meeting.id)?.offTheRecordSpans?.length === 1 ? true : undefined),
      'the saved closed span',
    );

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = await createApp({
      scenario: realScenario,
      speechRecognition: 'browser',
      auth,
      meetingCode,
      meetings,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      persistenceFor,
      meetingModules: () => fakeModules(clock),
    });
    apps.push(restarted);
    const rebuilt = await restarted.registry.get(meeting.id);
    expect(rebuilt?.session.offTheRecordSpans()).toEqual(state.rows.get(meeting.id)?.offTheRecordSpans);
  });

  it('turns real meeting agenda time cues into quiet state notes, never spoken cues', async () => {
    let now = 0;
    const built = await buildApp({ now: () => now });
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner, [{ title: 'Budget', minutes: 10 }]);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(
      (await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
        method: 'POST',
        cookie: joined.cookie,
      })).status,
    ).toBe(200);

    now = 5 * 60_000 + 500;
    const warning = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.cue?.text.startsWith('5 min left on') ? state : undefined;
    }, 'the five-minute quiet note', 4_000);
    if (warning.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(warning.payload.cue?.text).toBe('5 min left on Budget');

    now = 10 * 60_000 + 500;
    const overtime = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.cue?.text.startsWith('Over time on') ? state : undefined;
    }, 'the overtime quiet note', 4_000);
    if (overtime.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(overtime.payload.cue?.text).toBe('Over time on Budget');
    expect(screen.messages.some((event) => event.type === 'HOST_SPEECH_TRIGGERED')).toBe(false);
  });

  it('says loudly when the runner control channel is away, then clears it when the runner connects', async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);
    await join(built, meetingId, owner.cookie, 'Ada', 'chef');

    const down = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused !== null ? state : undefined;
    }, 'the runner-down warning');
    if (down.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(down.payload.notesPaused).toBe("Kaki can't hear the room right now");

    const control = new WebSocket(`ws://127.0.0.1:${built.port}/ws?audience=service-control`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      control.once('open', () => resolve());
      control.once('error', reject);
    });
    await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused === null ? state : undefined;
    }, 'the runner-up state');

    control.close();
    await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused !== null ? state : undefined;
    }, 'the runner-down warning again');
  });

  it('shows the notes catching up when the notetaker fails, then clears it on the next good pass', async () => {
    let down = true;
    const llm = createFakeLlm(() => {
      if (down) throw new Error('model gateway unavailable');
      return JSON.stringify({
        agendaIndex: 0,
        newQuestions: [],
        answeredQuestionIds: [],
        answeredQuestions: [],
        newTasks: [],
        revisions: [],
      });
    });
    const built = await buildApp({ meetingModule: { llm, notetakerIntervalMs: 40 } });
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, owner.cookie);
    sockets.push(screen);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(started.status).toBe(200);

    const control = new WebSocket(`ws://127.0.0.1:${built.port}/ws?audience=service-control`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      control.once('open', () => resolve());
      control.once('error', reject);
    });
    await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused === null ? state : undefined;
    }, 'the runner-up state');

    const spoken = await request(built.base, `/api/meetings/${meetingId}/runner/emit`, {
      method: 'POST',
      token: SERVICE_TOKEN,
      body: {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Ada (Chef)', text: 'Prep is done for the morning.', timestamp: new Date().toISOString() },
      },
    });
    expect(spoken.status).toBe(200);
    const paused = await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused === 'Notes paused, catching up'
        ? state
        : undefined;
    }, 'the notetaker catch-up notice');
    if (paused.type !== 'MEETING_STATE') throw new Error('not a state event');
    expect(paused.payload.notesPaused).toBe('Notes paused, catching up');

    down = false;
    const recovered = await request(built.base, `/api/meetings/${meetingId}/runner/emit`, {
      method: 'POST',
      token: SERVICE_TOKEN,
      body: {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Bao (Cashier)', text: 'Bao, please check the till later.', timestamp: new Date().toISOString() },
      },
    });
    expect(recovered.status).toBe(200);
    await waitFor(() => {
      const state = lastState(screen);
      return state?.type === 'MEETING_STATE' && state.payload.notesPaused === null ? state : undefined;
    }, 'the notes healthy again');

    control.close();
  });

  it('starts a real meeting without asking the runner to prepare AI colleagues', async () => {
    const built = await buildApp({ scenario: aiScenario, startAckTimeoutMs: 4_000 });
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(joined.response.status).toBe(200);

    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(started.status).toBe(200);
    const instance = await built.app.registry.get(meetingId);
    expect(instance?.session.active().npcs ?? []).toHaveLength(0);
  });

  it("admits a guest who arrived through the meeting's own link without a typed code", async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);

    const guestJoin = await request(built.base, `/api/meetings/${meetingId}/join`, {
      method: 'POST',
      body: { name: 'Guest' },
    });
    expect(guestJoin.status).toBe(200);
    const guestCookie = cookiePair(setCookies(guestJoin), 'kaki_session');
    expect(guestCookie).toBeDefined();

    const seated = await request(built.base, `/api/meetings/${meetingId}/livekit/token`, {
      method: 'POST',
      cookie: guestCookie,
      body: { participantName: 'Guest', participantRole: 'cashier' },
    });
    expect(seated.status).toBe(200);
  });

  it('starts a real meeting even when no runner is connected, because it has no AI colleagues', async () => {
    const built = await buildApp({ scenario: aiScenario, startAckTimeoutMs: 150 });
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(joined.response.status).toBe(200);

    const started = await request(built.base, `/api/meetings/${meetingId}/meeting/start`, {
      method: 'POST',
      cookie: joined.cookie,
    });
    expect(started.status).toBe(200);
    expect((await started.json()) as { started?: boolean }).toMatchObject({ started: true });
  }, 20_000);
});

describe('real meeting line replay', () => {
  function chunkTexts(socket: Socket): string[] {
    return socket.messages.flatMap((event) => (event.type === 'TRANSCRIPT_CHUNK' ? [event.payload.text] : []));
  }

  it('replays the last 50 lines to a refreshed seat and never the off-the-record ones', async () => {
    const built = await buildApp();
    const owner = await signIn(built.store, 'Ada');
    const meetingId = await createAndOpen(built, owner);
    const joined = await join(built, meetingId, owner.cookie, 'Ada', 'chef');
    expect(
      (await request(built.base, `/api/meetings/${meetingId}/meeting/start`, { method: 'POST', cookie: joined.cookie })).status,
    ).toBe(200);
    const seat = await connect(built.port, meetingId, { role: joined.seat }, joined.cookie);
    const screen = await connect(built.port, meetingId, { audience: 'screen' }, joined.cookie);
    sockets.push(seat, screen);

    // A seat may write five lines a second, so move the clock on between batches of five.
    let clock = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: true }));
      await waitFor(() => {
        const state = lastState(screen);
        return state?.type === 'MEETING_STATE' && state.payload.offTheRecord !== null ? state : undefined;
      }, 'the room to go off the record');
      seat.ws.send(JSON.stringify({ type: 'HUMAN_LINE', text: 'secret', source: 'typed', clientLineId: 'id-secret' }));
      screen.ws.send(JSON.stringify({ type: 'SET_OFF_THE_RECORD', on: false }));
      await waitFor(() => {
        const state = lastState(screen);
        return state?.type === 'MEETING_STATE' && state.payload.offTheRecord === null ? state : undefined;
      }, 'the room back on the record');
      for (let batch = 0; batch < 60; batch += 5) {
        clock += 1_100;
        for (let index = batch; index < batch + 5; index += 1) {
          seat.ws.send(JSON.stringify({ type: 'HUMAN_LINE', text: `line ${index}`, source: 'typed', clientLineId: `id-${index}` }));
        }
        await waitFor(() => (chunkTexts(screen).includes(`line ${batch + 4}`) ? true : undefined), `batch ${batch}`);
      }
    } finally {
      spy.mockRestore();
    }

    const refreshed = await connect(built.port, meetingId, { audience: 'screen' }, joined.cookie);
    sockets.push(refreshed);
    await waitFor(() => (chunkTexts(refreshed).length > 0 ? true : undefined), 'the replay');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replayed = chunkTexts(refreshed);
    expect(replayed).toHaveLength(50);
    expect(replayed[0]).toBe('line 10');
    expect(replayed[49]).toBe('line 59');
    expect(replayed).not.toContain('secret');
  }, 20_000);
});
