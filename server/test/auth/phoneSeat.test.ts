import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultMeetingSetup, humanSeatRoles, type KakiEvent, type MeetingSetup, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { hashPassword } from '../../src/auth/password';
import { loadScenario } from '../../src/loadScenario';
import { createMeetingCodeSource, type MeetingCodeSource } from '../../src/meetingCode';
import { testScenario } from '../fixtures/scenario';
import { createTestApp, portOf, settle, waitFor } from '../helpers';

const FIXED_CODE = 'K7M2Q9';
const ENDED = 'This meeting has ended; scan the new code.';

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  if (pair === undefined || pair === '') throw new Error('The response did not set a session cookie');
  return pair;
}

function connect(
  port: number,
  role: string,
  cookie?: string,
  authorization?: string,
): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number }> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  if (authorization !== undefined) headers.authorization = authorization;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`,
    Object.keys(headers).length === 0 ? undefined : { headers },
  );
  return new Promise((resolve) => {
    let settled = false;
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, ws });
    });
    ws.once('unexpected-response', (_request, response) => {
      if (settled) return;
      settled = true;
      response.resume();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 0 });
    });
  });
}

const aiScenario: Scenario = {
  ...testScenario,
  roles: [...testScenario.roles, { id: 'manager', label: 'Manager' }],
  attendees: [...testScenario.attendees, { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy' }],
  npcs: [
    {
      attendee: 'Cy',
      voice: 'test-voice',
      personality: 'Quiet until asked.',
      agenda: 'Keep the kitchen running.',
      concerns: [],
    },
  ],
};

describe('phone and screen seat authority', () => {
  let app: KakiApp;
  let store: AuthStore;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    store = createMemoryAuthStore();
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
  });

  async function makeApp({
    scenario = testScenario,
    meetingCode,
    roomRoster = async () => [],
    serviceToken,
  }: {
    scenario?: Scenario;
    meetingCode: MeetingCodeSource;
    roomRoster?: () => Promise<Array<{ name: string; role?: string }> | undefined>;
    serviceToken?: string;
  } = { meetingCode: createMeetingCodeSource(FIXED_CODE) }): Promise<void> {
    const auth = createAuth({
      store,
      offeredRoles: () => humanSeatRoles(scenario).map((role) => role.id),
      meetingCode,
    });
    app = await createApp({
      speechRecognition: 'browser',
      scenario,
      auth,
      meetingCode,
      roomRoster,
      rejoinGraceMs: 0,
      admissionReservationMs: 0,
      ...(serviceToken === undefined ? {} : { serviceToken }),
    });
    port = portOf(app);
  }

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  function put(path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
  }

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, cookie === undefined ? undefined : { headers: { cookie } });
  }

  async function joinAs(code: string, role: string): Promise<string> {
    const response = await post('/api/join', { code, role });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function joinRoom(name: string, role: string, cookie?: string): Promise<{ meetingCode: string }> {
    const response = await post(
      '/api/livekit/token',
      {
        roomName: 'room',
        participantName: name,
        participantRole: role,
      },
      cookie,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { meetingCode: string };
  }

  async function loginHost(): Promise<string> {
    const email = 'host@example.com';
    if ((await store.findUserByEmail(email)) === undefined) {
      await store.createUser({ email, passwordHash: await hashPassword('host-password') });
    }
    const response = await post('/api/auth/login', { email, password: 'host-password' });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  it('uses the LiveKit meeting code for phone sign-in and rotates both on reset', async () => {
    const meetingCode = createMeetingCodeSource('');
    await makeApp({ meetingCode });

    const shownCode = meetingCode.value;
    const first = await joinRoom('Ada', 'chef', await loginHost());
    const oldCode = first.meetingCode;
    // The code already on screen stays valid when the first person starts this app's first meeting.
    expect(oldCode).toBe(shownCode);
    const oldCookie = await joinAs(oldCode, 'cashier');
    const oldPhone = await connect(port, 'cashier', oldCookie);
    expect(oldPhone.ok).toBe(true);
    if (!oldPhone.ok) return;
    let closedWith: number | undefined;
    oldPhone.ws.on('close', (code) => {
      closedWith = code;
    });

    // The room emptied: the owner's next arrival starts a new meeting and rotates the one code both sides use.
    const second = await joinRoom('Ada', 'chef', await loginHost());
    const newCode = second.meetingCode;
    expect(newCode).not.toBe(oldCode);
    expect(meetingCode.value).toBe(newCode);
    await waitFor(() => (closedWith === 4001 ? true : undefined), 'the old phone feed to close');

    const oldJoin = await post('/api/join', { code: oldCode, role: 'chef' });
    expect(oldJoin.status).toBe(403);

    const oldSession = await get('/api/auth/me', oldCookie);
    expect(oldSession.status).toBe(403);
    expect(await oldSession.json()).toEqual({ error: ENDED, authEnabled: true });

    const oldSocket = await connect(port, 'cashier', oldCookie);
    expect(oldSocket.ok).toBe(false);
    if (!oldSocket.ok) expect(oldSocket.status).toBe(401);

    // The desktop person took the chef seat when they joined the new meeting, so the phone takes cashier.
    const newCookie = await joinAs(newCode, 'cashier');
    const newSocket = await connect(port, 'cashier', newCookie);
    expect(newSocket.ok).toBe(true);
    if (newSocket.ok) sockets.push(newSocket.ws);
  });

  it('gives two assigned phone roles only their own private events', async () => {
    await makeApp({ meetingCode: createMeetingCodeSource(FIXED_CODE) });
    const chefCookie = await joinAs(FIXED_CODE, 'chef');
    const cashierCookie = await joinAs(FIXED_CODE, 'cashier');
    const chef = await connect(port, 'chef', chefCookie);
    const cashier = await connect(port, 'cashier', cashierCookie);
    expect(chef.ok && cashier.ok).toBe(true);
    if (!chef.ok || !cashier.ok) return;
    sockets.push(chef.ws, cashier.ws);

    const chefEvents: KakiEvent[] = [];
    const cashierEvents: KakiEvent[] = [];
    chef.ws.on('message', (data) => chefEvents.push(JSON.parse(data.toString()) as KakiEvent));
    cashier.ws.on('message', (data) => cashierEvents.push(JSON.parse(data.toString()) as KakiEvent));

    app.hub.publish({
      type: 'NUDGE',
      audience: { kind: 'role', role: 'chef' },
      payload: { text: 'Chef only', agendaIndex: 0 },
    });
    await waitFor(() => chefEvents.find((event) => event.type === 'NUDGE'), 'the chef nudge');
    await settle();
    expect(cashierEvents.some((event) => event.type === 'NUDGE')).toBe(false);

    app.hub.publish({
      type: 'NUDGE',
      audience: { kind: 'role', role: 'cashier' },
      payload: { text: 'Cashier only', agendaIndex: 0 },
    });
    await waitFor(() => cashierEvents.find((event) => event.type === 'NUDGE'), 'the cashier nudge');
    await settle();
    expect(chefEvents.filter((event) => event.type === 'NUDGE')).toHaveLength(1);
  });

  it('refuses a role an AI stand-in plays', async () => {
    await makeApp({ scenario: aiScenario, meetingCode: createMeetingCodeSource(FIXED_CODE) });

    const aiRole = await post('/api/join', { code: FIXED_CODE, role: 'manager' });
    expect(aiRole.status).toBe(403);
    expect(((await aiRole.json()) as { error: string }).error).toMatch(/human seat/);

    const humanCookie = await joinAs(FIXED_CODE, 'chef');
    const wrongSeat = await connect(port, 'manager', humanCookie);
    expect(wrongSeat.ok).toBe(false);
    if (!wrongSeat.ok) expect(wrongSeat.status).toBe(401);
  });

  it('offers a role added in setup to phone joins, not the roles known at boot', async () => {
    const pack = await loadScenario('kopitiam');
    await makeApp({ scenario: pack, meetingCode: createMeetingCodeSource(FIXED_CODE) });
    const host = await loginHost();
    const setup: MeetingSetup = defaultMeetingSetup(pack);
    setup.roles.push({ id: 'runner', label: 'Runner', facilitator: false });
    setup.seats = [
      { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
      { displayName: 'Runner One', roleId: 'runner', kind: 'person' },
    ];
    expect((await put('/api/setup', setup, host)).status).toBe(200);

    const joined = await post('/api/join', { code: FIXED_CODE, role: 'runner' });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ kind: 'participant', role: 'runner' });
  });

  it('refuses a phone join for a pack role the setup turned into an AI seat', async () => {
    const pack = await loadScenario('kopitiam');
    await makeApp({ scenario: pack, meetingCode: createMeetingCodeSource(FIXED_CODE) });
    const host = await loginHost();
    const setup: MeetingSetup = defaultMeetingSetup(pack);
    const weiLing = setup.seats.find((seat) => seat.displayName === 'Wei Ling');
    const arjun = setup.seats.find((seat) => seat.displayName === 'Arjun');
    if (weiLing === undefined || arjun === undefined) throw new Error('Expected Wei Ling and Arjun seats');
    weiLing.kind = 'ai';
    weiLing.npcProfileId = 'Wei Ling';
    arjun.kind = 'person';
    delete arjun.npcProfileId;
    expect((await put('/api/setup', setup, host)).status).toBe(200);

    const refused = await post('/api/join', { code: FIXED_CODE, role: 'producer' });
    expect([403, 409]).toContain(refused.status);
    expect(((await refused.json()) as { error: string }).error).toMatch(/human seat|no place/);

    const allowed = await post('/api/join', { code: FIXED_CODE, role: 'lead_programmer' });
    expect(allowed.status).toBe(200);
  });

  it('refuses an opening socket whose authorization predates a code rotation', async () => {
    const meetingCode = createMeetingCodeSource('');
    const roles = humanSeatRoles(testScenario).map((role) => role.id);
    const baseAuth = createAuth({ store, offeredRoles: () => roles, meetingCode });
    let authorized: (() => void) | undefined;
    const didAuthorize = new Promise<void>((resolve) => {
      authorized = resolve;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = {
      ...baseAuth,
      authorize: async (
        request: Parameters<typeof baseAuth.authorize>[0],
        audience: Parameters<typeof baseAuth.authorize>[1],
      ) => {
        const decision = await baseAuth.authorize(request, audience);
        authorized?.();
        await released;
        return decision;
      },
    };
    app = await createTestApp({
      auth,
      meetingCode,
      roomRoster: async () => [],
      rejoinGraceMs: 0,
      admissionReservationMs: 0,
    });
    port = portOf(app);

    const first = await joinRoom('Ada', 'chef', await loginHost());
    const oldCookie = await joinAs(first.meetingCode, 'cashier');

    const pending = connect(port, 'cashier', oldCookie);
    await didAuthorize;
    const second = await joinRoom('Ada', 'chef', await loginHost());
    expect(second.meetingCode).not.toBe(first.meetingCode);
    release?.();

    const opened = await pending;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    sockets.push(opened.ws);
    const closedWith = await Promise.race([
      new Promise<number>((resolve) => opened.ws.once('close', (code) => resolve(code))),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);
    expect(closedWith).toBe(4001);
  });

  it('closes participant lifecycle feeds on rotation but keeps host and runner sockets', async () => {
    await store.createUser({
      email: 'host@example.com',
      passwordHash: await hashPassword('host-password'),
    });
    const meetingCode = createMeetingCodeSource('');
    await makeApp({ meetingCode, serviceToken: 'runner-secret' });

    const first = await joinRoom('Ada', 'chef', await loginHost());
    const participantCookie = await joinAs(first.meetingCode, 'cashier');
    // A separate host sign-in for the sockets; the next join below replaces only its own session.
    const hostCookie = await loginHost();

    const participantLifecycle = await connect(port, 'lifecycle', participantCookie);
    const hostLifecycle = await connect(port, 'lifecycle', hostCookie);
    const hostScreen = await connect(port, 'screen', hostCookie);
    // The runner drives the screen; the token may not open a human seat.
    const runnerScreen = await connect(port, 'screen', undefined, 'Bearer runner-secret');
    expect(participantLifecycle.ok && hostLifecycle.ok && hostScreen.ok && runnerScreen.ok).toBe(true);
    if (!participantLifecycle.ok || !hostLifecycle.ok || !hostScreen.ok || !runnerScreen.ok) return;
    sockets.push(participantLifecycle.ws, hostLifecycle.ws, hostScreen.ws, runnerScreen.ws);

    let participantClosed: number | undefined;
    let hostLifecycleClosed = false;
    let hostScreenClosed = false;
    let runnerClosed = false;
    participantLifecycle.ws.on('close', (code) => {
      participantClosed = code;
    });
    hostLifecycle.ws.on('close', () => {
      hostLifecycleClosed = true;
    });
    hostScreen.ws.on('close', () => {
      hostScreenClosed = true;
    });
    runnerScreen.ws.on('close', () => {
      runnerClosed = true;
    });

    const second = await joinRoom('Ada', 'chef', await loginHost());
    expect(second.meetingCode).not.toBe(first.meetingCode);
    await waitFor(() => participantClosed, 'the participant lifecycle feed to close');
    expect(participantClosed).toBe(4001);
    await settle();
    expect(hostLifecycleClosed).toBe(false);
    expect(hostScreenClosed).toBe(false);
    expect(runnerClosed).toBe(false);
  });

  it('rate-limits wrong meeting codes on both join and token routes, separately from host sign-in', async () => {
    await store.createUser({
      email: 'host@example.com',
      passwordHash: await hashPassword('host-password'),
    });
    await makeApp({
      meetingCode: createMeetingCodeSource(FIXED_CODE),
      roomRoster: async () => [{ name: 'Ada', role: 'chef' }],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post('/api/livekit/token', {
        roomName: 'room',
        participantName: `Mallory ${attempt}`,
        participantRole: 'cashier',
        meetingCode: 'WRONG1',
      });
      expect(response.status).toBe(403);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post('/api/join', { code: 'WRONG1', role: 'chef' });
      expect(response.status).toBe(403);
    }

    const limitedJoin = await post('/api/join', { code: FIXED_CODE, role: 'chef' });
    expect(limitedJoin.status).toBe(429);
    expect(await limitedJoin.json()).toEqual({
      error: 'Too many meeting-code attempts. Wait a minute and try again.',
    });
    const limitedToken = await post('/api/livekit/token', {
      roomName: 'room',
      participantName: 'Mallory later',
      participantRole: 'cashier',
      meetingCode: FIXED_CODE,
    });
    expect(limitedToken.status).toBe(429);

    const hostLogin = await post('/api/auth/login', {
      email: 'host@example.com',
      password: 'host-password',
    });
    expect(hostLogin.status).toBe(200);
  });

});
