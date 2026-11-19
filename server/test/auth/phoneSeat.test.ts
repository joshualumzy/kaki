import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { humanSeatRoles, type KakiEvent, type Scenario } from '@kaki/shared';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
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

function connect(port: number, role: string, cookie?: string): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`,
    cookie === undefined ? undefined : { headers: { cookie } },
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
  }: {
    scenario?: Scenario;
    meetingCode: MeetingCodeSource;
    roomRoster?: () => Promise<Array<{ name: string; role?: string }> | undefined>;
  } = { meetingCode: createMeetingCodeSource(FIXED_CODE) }): Promise<void> {
    const auth = createAuth({
      store,
      roles: humanSeatRoles(scenario).map((role) => role.id),
      meetingCode,
    });
    app = await createTestApp({
      auth,
      meetingCode,
      roomRoster,
      rejoinGraceMs: 0,
      admissionReservationMs: 0,
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

  function get(path: string, cookie?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, cookie === undefined ? undefined : { headers: { cookie } });
  }

  async function joinAs(code: string, role: string): Promise<string> {
    const response = await post('/api/join', { code, role });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  async function joinRoom(name: string, role: string): Promise<{ meetingCode: string }> {
    const response = await post('/api/livekit/token', {
      roomName: 'room',
      participantName: name,
      participantRole: role,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { meetingCode: string };
  }

  it('uses the LiveKit meeting code for phone sign-in and rotates both on reset', async () => {
    const meetingCode = createMeetingCodeSource('');
    await makeApp({ meetingCode });

    const shownCode = meetingCode.value;
    const first = await joinRoom('Ada', 'chef');
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

    // The room emptied: the next arrival starts a new meeting and rotates the one code both sides use.
    const second = await joinRoom('Ada', 'chef');
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

    const newCookie = await joinAs(newCode, 'chef');
    const newSocket = await connect(port, 'chef', newCookie);
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
});
