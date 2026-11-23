import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { hashToken } from '../../src/auth/password';
import type { KakiEvent } from '@kaki/shared';
import { createTestApp, meetingUrl, meetingWsUrl, openRealMeeting, portOf, settle, waitFor, type TestMeeting } from '../helpers';

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  if (pair === undefined || pair === '') throw new Error('The response did not set a session cookie');
  return pair;
}

function connectMeeting(
  port: number,
  meetingId: string,
  query: string,
  options: { cookie?: string; authorization?: string } = {},
): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number }> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  const ws = new WebSocket(
    meetingWsUrl(port, meetingId, query),
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

  function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  function pathFor(meeting: TestMeeting, path: string): string {
    return meetingUrl(app, meeting.id, path).replace(`http://127.0.0.1:${port}`, '');
  }

  async function signInGoogle(name: string): Promise<{ user: UserRecord; cookie: string }> {
    const email = `${randomUUID()}@example.com`;
    const user = await store.createGoogleUser({ googleSub: randomUUID(), name, email });
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

  async function makeRealMeetingApp(): Promise<{ meeting: TestMeeting; ownerCookie: string }> {
    const auth = createAuth({ store});
    app = await createTestApp({ auth, serviceToken: 'runner-secret', roomRoster: async () => [] });
    port = portOf(app);
    const owner = await signInGoogle('Ada');
    const meeting = await openRealMeeting(app, { ownerUserId: owner.user.id, title: 'Weekly planning' });
    expect((await post(pathFor(meeting, '/api/meeting/open'), {}, owner.cookie)).status).toBe(200);
    return { meeting, ownerCookie: owner.cookie };
  }

  async function joinGuest(meeting: TestMeeting, name: string): Promise<string> {
    const joined = await post(pathFor(meeting, '/join'), { name });
    expect(joined.status).toBe(200);
    return cookieFrom(joined);
  }

  async function takeSeat(
    meeting: TestMeeting,
    guestCookie: string,
    name: string,
  ): Promise<{ cookie: string; seat: string }> {
    const seated = await post(pathFor(meeting, '/api/livekit/token'), { participantName: name }, guestCookie);
    expect(seated.status).toBe(200);
    const body = (await seated.json()) as { participantRole: string };
    return { cookie: cookieFrom(seated), seat: body.participantRole };
  }

  // Legacy only: phone sign-in by meeting code and code rotation exist only on the legacy meeting.
  it('gives two assigned guest seats only their own private events', async () => {
    const { meeting } = await makeRealMeetingApp();
    const ada = await takeSeat(meeting, await joinGuest(meeting, 'Ada'), 'Ada');
    const bao = await takeSeat(meeting, await joinGuest(meeting, 'Bao'), 'Bao');
    const chef = await connectMeeting(port, meeting.id, `role=${encodeURIComponent(ada.seat)}`, { cookie: ada.cookie });
    const cashier = await connectMeeting(port, meeting.id, `role=${encodeURIComponent(bao.seat)}`, { cookie: bao.cookie });
    expect(chef.ok && cashier.ok).toBe(true);
    if (!chef.ok || !cashier.ok) return;
    sockets.push(chef.ws, cashier.ws);

    const chefEvents: KakiEvent[] = [];
    const cashierEvents: KakiEvent[] = [];
    chef.ws.on('message', (data) => chefEvents.push(JSON.parse(data.toString()) as KakiEvent));
    cashier.ws.on('message', (data) => cashierEvents.push(JSON.parse(data.toString()) as KakiEvent));

    meeting.hub.publish({
      type: 'WINGMAN_NOTE',
      audience: { kind: 'role', role: ada.seat },
      payload: { id: 'answer:chef', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'Chef only' },
    });
    await waitFor(() => chefEvents.find((event) => event.type === 'WINGMAN_NOTE'), 'the chef private note');
    await settle();
    expect(cashierEvents.some((event) => event.type === 'WINGMAN_NOTE')).toBe(false);

    meeting.hub.publish({
      type: 'WINGMAN_NOTE',
      audience: { kind: 'role', role: bao.seat },
      payload: { id: 'answer:cashier', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'Cashier only' },
    });
    await waitFor(() => cashierEvents.find((event) => event.type === 'WINGMAN_NOTE'), 'the cashier private note');
    await settle();
    expect(chefEvents.filter((event) => event.type === 'WINGMAN_NOTE')).toHaveLength(1);
  });

  // Legacy only: only the legacy role picker admits by pack role, so only it can refuse an AI role.
  it('closes participant lifecycle feeds on rotation but keeps host and runner sockets', async () => {
    const { meeting, ownerCookie } = await makeRealMeetingApp();
    const bao = await takeSeat(meeting, await joinGuest(meeting, 'Bao'), 'Bao');

    const participantLifecycle = await connectMeeting(port, meeting.id, 'audience=lifecycle', { cookie: bao.cookie });
    const hostLifecycle = await connectMeeting(port, meeting.id, 'audience=lifecycle', { cookie: ownerCookie });
    const hostScreen = await connectMeeting(port, meeting.id, 'audience=screen', { cookie: ownerCookie });
    // The runner drives the screen; the token may not open a human seat.
    const runnerScreen = await connectMeeting(port, meeting.id, 'audience=screen', { authorization: 'Bearer runner-secret' });
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

    const beforeReset = meeting.session.snapshot().meetingId;
    const afterReset = meeting.session.reset();
    expect(afterReset).not.toBe(beforeReset);
    await waitFor(() => participantClosed, 'the participant lifecycle feed to close');
    expect(participantClosed).toBe(4001);
    await settle();
    expect(hostLifecycleClosed).toBe(false);
    expect(hostScreenClosed).toBe(false);
    expect(runnerClosed).toBe(false);
  });

  // Legacy only: code-on-join and token rate limiting belongs to the legacy meeting-code join.
});
