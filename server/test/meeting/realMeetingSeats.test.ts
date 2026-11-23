import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { testScenario } from '../fixtures/scenario';
import { portOf, waitFor } from '../helpers';

const SERVICE_TOKEN = 'real-seat-test-token';

interface Socket {
  ws: WebSocket;
  messages: KakiEvent[];
}

interface SignedIn {
  cookie: string;
  userId: string;
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

async function signIn(store: AuthStore, name: string): Promise<SignedIn> {
  const user = await store.createGoogleUser({
    googleSub: randomUUID(),
    name,
    email: `${randomUUID()}@example.com`,
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
  return { cookie: `kaki_session=${token}`, userId: user.id };
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

/** The LiveKit identity the signed token actually carries, as LiveKit will see it in the room. */
function tokenIdentity(token: string): string {
  const payload = token.split('.')[1];
  if (payload === undefined) return '';
  // LiveKit carries the room identity in the JWT subject.
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
  return claims.sub ?? '';
}

async function seat(
  base: string,
  meetingId: string,
  cookie: string,
  name?: string,
): Promise<{ status: number; seat: string; identity: string; cookie: string }> {
  const response = await request(base, `/api/meetings/${meetingId}/livekit/token`, {
    method: 'POST',
    cookie,
    body: name === undefined ? {} : { participantName: name },
  });
  const body = (await response.json()) as { participantRole?: string; token?: string };
  return {
    status: response.status,
    seat: body.participantRole ?? '',
    identity: body.token === undefined ? '' : tokenIdentity(body.token),
    cookie: cookiePair(setCookies(response), 'kaki_session') ?? cookie,
  };
}

function connect(base: string, meetingId: string, audience: string, cookie?: string): Promise<Socket> {
  const port = new URL(base).port;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?meeting=${meetingId}&audience=${audience}`,
    cookie === undefined ? {} : { headers: { cookie } },
  );
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

/** The runner's own route for speech it recognised: it forwards the room identity, never a typed name. */
function postSpeechLine(
  base: string,
  meetingId: string,
  line: { participantIdentity: string; seat: string; text: string; clientLineId: string },
): Promise<Response> {
  return request(base, `/api/meetings/${meetingId}/runner/human-line`, {
    method: 'POST',
    token: SERVICE_TOKEN,
    body: { meetingId, ...line },
  });
}

const apps: KakiApp[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.ws.close();
  for (const app of apps.splice(0)) await app.close();
});

async function build(): Promise<{ app: KakiApp; base: string; store: AuthStore; meetingCode: ReturnType<typeof createMeetingCodeSource> }> {
  const store = createMemoryAuthStore();
  const meetingCode = createMeetingCodeSource();
  const auth = createAuth({ store, meetingCode });
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings: createMemoryMeetingStore(),
    serviceToken: SERVICE_TOKEN,
    roomRoster: async () => [],
  });
  apps.push(app);
  return { app, base: `http://127.0.0.1:${portOf(app)}`, store, meetingCode };
}

describe('real meeting seats', () => {
  it('starts from its own empty scenario, with no practice roles, briefing or AI colleagues', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
      agenda: [{ title: 'Budget', minutes: 10 }],
    });

    const joined = await seat(base, meeting.id, owner.cookie, 'Ada');
    expect(joined.status).toBe(200);
    const instance = await app.registry.get(meeting.id);
    if (instance === undefined) throw new Error('the meeting did not load');
    const scenario = instance.session.active();

    expect(scenario.meetingTitle).toBe('Weekly planning');
    expect(scenario.agenda.map((item) => item.title)).toEqual(['Budget']);
    expect(scenario.npcs ?? []).toHaveLength(0);
    expect(scenario.practiceBriefing).toBeUndefined();
    expect(scenario.hostBrief).toBeUndefined();
    expect(scenario.roles.map((role) => role.id)).not.toContain('chef');
    expect(scenario.roles.map((role) => role.id)).not.toContain('cashier');
    expect(scenario.roles.map((role) => role.label)).not.toContain('Operations Director');
    expect(scenario.attendees.map((attendee) => attendee.name)).toEqual(['Ada']);
  });

  it('keeps the owner as the chair and the same signed-in account after joining', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });

    const joined = await seat(base, meeting.id, owner.cookie, 'Ada');
    expect(joined.status).toBe(200);

    const instance = await app.registry.get(meeting.id);
    if (instance === undefined) throw new Error('the meeting did not load');
    expect(instance.session.active().roles.find((role) => role.facilitator === true)?.id).toBe(
      joined.seat,
    );

    // Taking the seat rewrites the session to the meeting role; the account must survive it.
    const me = await request(base, '/api/auth/me', { cookie: joined.cookie });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { kind?: string; user?: { id?: string } };
    expect(meBody.kind).toBe('user');
    expect(meBody.user?.id).toBe(owner.userId);

    const workspaces = await request(base, '/api/workspaces', { cookie: joined.cookie });
    expect(workspaces.status).toBe(200);
  });

  it('seats the owner and two guests who share a name, each under their own name', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });

    const ownerSeat = await seat(base, meeting.id, owner.cookie, 'Ada');
    expect(ownerSeat.status).toBe(200);

    const guestCookies: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
        method: 'POST',
        body: { name: 'Sam' },
      });
      expect(joined.status).toBe(200);
      const cookie = cookiePair(setCookies(joined), 'kaki_session');
      if (cookie === undefined) throw new Error('the guest got no cookie');
      guestCookies.push(cookie);
    }

    const first = await seat(base, meeting.id, guestCookies[0]!, 'Sam');
    const second = await seat(base, meeting.id, guestCookies[1]!, 'Sam');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.seat).not.toBe(second.seat);
    expect(first.seat).not.toBe(ownerSeat.seat);

    const instance = await app.registry.get(meeting.id);
    if (instance === undefined) throw new Error('the meeting did not load');
    const holders = instance.session.holders();
    expect(holders).toHaveLength(3);
    expect(new Set(holders.map((holder) => holder.seat)).size).toBe(3);
    expect(holders.filter((holder) => holder.name === 'sam')).toHaveLength(2);
    expect(holders.map((holder) => holder.displayName ?? holder.name)).toEqual(
      expect.arrayContaining(['Ada', 'Sam', 'Sam']),
    );
    const scenario = instance.session.active();
    expect(scenario.attendees.map((attendee) => attendee.name)).toEqual(
      expect.arrayContaining(['Ada', 'Sam', 'Sam']),
    );
  });

  it('keeps one holder per person when two same-named guests each refresh', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });
    await seat(base, meeting.id, owner.cookie, 'Ada');
    const seats: Array<{ seat: string; cookie: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
        method: 'POST',
        body: { name: 'Sam' },
      });
      const cookie = cookiePair(setCookies(joined), 'kaki_session');
      if (cookie === undefined) throw new Error('the guest got no cookie');
      seats.push(await seat(base, meeting.id, cookie, 'Sam'));
    }
    for (const guest of seats) {
      const again = await seat(base, meeting.id, guest.cookie, 'Sam');
      expect(again.seat).toBe(guest.seat);
    }
    const instance = await app.registry.get(meeting.id);
    expect(instance?.session.holders()).toHaveLength(3);
  });

  it('refuses a join with a stale guest cookie instead of seating it by name', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });
    const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
      method: 'POST',
      body: { name: 'Sam' },
    });
    const oldCookie = cookiePair(setCookies(joined), 'kaki_session');
    if (oldCookie === undefined) throw new Error('the guest got no cookie');
    // Taking the seat rotates the cookie, so a second join still sending the old one is stale.
    const first = await seat(base, meeting.id, oldCookie, 'Sam');
    expect(first.status).toBe(200);
    const stale = await seat(base, meeting.id, oldCookie, 'Sam');
    expect(stale.status).toBe(401);
    const instance = await app.registry.get(meeting.id);
    expect(instance?.session.holders()).toHaveLength(1);
  });

  it('gives a refresh or rejoin the same seat back, for the owner and a guest', async () => {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });

    const ownerFirst = await seat(base, meeting.id, owner.cookie, 'Ada');
    const ownerAgain = await seat(base, meeting.id, ownerFirst.cookie, 'Ada');
    expect(ownerAgain.status).toBe(200);
    expect(ownerAgain.seat).toBe(ownerFirst.seat);

    // The same account on a fresh sign-in (no old cookie) still owns the same seat.
    const freshToken = randomUUID();
    await store.createSession({
      tokenHash: hashToken(freshToken),
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: 'Ada',
      userId: owner.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const ownerNewBrowser = await seat(base, meeting.id, `kaki_session=${freshToken}`, 'Ada');
    expect(ownerNewBrowser.status).toBe(200);
    expect(ownerNewBrowser.seat).toBe(ownerFirst.seat);

    const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
      method: 'POST',
      body: { name: 'Sam' },
    });
    const guestCookie = cookiePair(setCookies(joined), 'kaki_session');
    if (guestCookie === undefined) throw new Error('the guest got no cookie');
    const guestFirst = await seat(base, meeting.id, guestCookie, 'Sam');
    const guestAgain = await seat(base, meeting.id, guestFirst.cookie, 'Sam');
    expect(guestAgain.status).toBe(200);
    expect(guestAgain.seat).toBe(guestFirst.seat);

    const instance = await app.registry.get(meeting.id);
    expect(instance?.session.holders()).toHaveLength(2);
  });

  it('gives each visitor’s practice meeting the pack’s roles and agenda exactly as they were', async () => {
    const { app, base } = await build();
    const created = await request(base, '/api/practice', { method: 'POST' });
    const { meetingId } = (await created.json()) as { meetingId: string };
    const practice = app.registry.findPractice(meetingId)?.session.active();
    expect(practice?.roles.map((role) => role.id)).toEqual(['chef', 'cashier']);
    expect(practice?.roles.map((role) => role.label)).toEqual(['Chef', 'Cashier']);
    expect(practice?.agenda.map((item) => item.title)).toEqual(['Prep']);
  });

  it('keeps a real meeting’s guest and signed-in seats when the practice meeting’s code changes', async () => {
    const { app, base, store, meetingCode } = await build();
    const owner = await signIn(store, 'Ada');
    const member = await signIn(store, 'Ben');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });
    const joined = await request(base, `/api/meetings/${meeting.id}/join`, {
      method: 'POST',
      body: { name: 'Sam' },
    });
    const guestCookie = cookiePair(setCookies(joined), 'kaki_session');
    if (guestCookie === undefined) throw new Error('the guest got no cookie');
    const guest = await seat(base, meeting.id, guestCookie, 'Sam');
    const signed = await seat(base, meeting.id, member.cookie, 'Ben');
    expect(guest.status).toBe(200);
    expect(signed.status).toBe(200);

    // A practice meeting starting or ending changes the one global code.
    meetingCode.rotate();

    const guestMe = await request(base, '/api/auth/me', { cookie: guest.cookie });
    expect(guestMe.status).toBe(200);
    expect(await guestMe.json()).toMatchObject({ kind: 'participant', role: guest.seat });
    const guestAgain = await seat(base, meeting.id, guest.cookie, 'Sam');
    expect(guestAgain.status).toBe(200);
    expect(guestAgain.seat).toBe(guest.seat);

    const signedMe = await request(base, '/api/auth/me', { cookie: signed.cookie });
    expect(signedMe.status).toBe(200);
    expect(await signedMe.json()).toMatchObject({ kind: 'user', user: { id: member.userId } });
    expect((await request(base, '/api/workspaces', { cookie: signed.cookie })).status).toBe(200);
  });
});

describe('real meeting speech lines', () => {
  async function runningMeeting(): Promise<{
    app: KakiApp;
    base: string;
    store: AuthStore;
    meetingId: string;
    ownerSeat: Awaited<ReturnType<typeof seat>>;
  }> {
    const { app, base, store } = await build();
    const owner = await signIn(store, 'Ada');
    const meeting = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: owner.userId,
      title: 'Weekly planning',
    });
    const ownerSeat = await seat(base, meeting.id, owner.cookie, 'Ada');
    expect(ownerSeat.status).toBe(200);
    expect(ownerSeat.identity).toBe(ownerSeat.seat);
    expect(
      (await request(base, `/api/meetings/${meeting.id}/meeting/start`, {
        method: 'POST',
        cookie: ownerSeat.cookie,
      })).status,
    ).toBe(200);
    return { app, base, store, meetingId: meeting.id, ownerSeat };
  }

  function transcriptChunk(socket: Socket, text: string): Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }> | undefined {
    return socket.messages.find(
      (event): event is Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }> =>
        event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === text,
    );
  }

  it("accepts a signed-in person's speech line under the seat identity the real token issued", async () => {
    const { base, meetingId, ownerSeat } = await runningMeeting();
    const screen = await connect(base, meetingId, 'screen', ownerSeat.cookie);
    sockets.push(screen);

    const text = 'I checked the front counter this morning.';
    const response = await postSpeechLine(base, meetingId, {
      participantIdentity: ownerSeat.identity,
      seat: ownerSeat.seat,
      text,
      clientLineId: 'signed-in-speech',
    });
    expect(response.status).toBe(200);

    const chunk = await waitFor(() => transcriptChunk(screen, text), 'the signed-in speech line');
    expect(chunk).toMatchObject({ payload: { speaker: 'Ada', speakerRole: ownerSeat.seat } });
  });

  it("accepts a guest's speech line under the seat identity the real token issued", async () => {
    const { base, meetingId, ownerSeat } = await runningMeeting();
    const joined = await request(base, `/api/meetings/${meetingId}/join`, {
      method: 'POST',
      body: { name: 'Sam' },
    });
    expect(joined.status).toBe(200);
    const guestCookie = cookiePair(setCookies(joined), 'kaki_session');
    if (guestCookie === undefined) throw new Error('the guest got no cookie');
    const guestSeat = await seat(base, meetingId, guestCookie, 'Sam');
    expect(guestSeat.status).toBe(200);
    expect(guestSeat.identity).toBe(guestSeat.seat);
    expect(guestSeat.seat).not.toBe(ownerSeat.seat);

    const screen = await connect(base, meetingId, 'screen', ownerSeat.cookie);
    sockets.push(screen);

    const text = 'The queue was out the door.';
    const response = await postSpeechLine(base, meetingId, {
      participantIdentity: guestSeat.identity,
      seat: guestSeat.seat,
      text,
      clientLineId: 'guest-speech',
    });
    expect(response.status).toBe(200);

    const chunk = await waitFor(() => transcriptChunk(screen, text), 'the guest speech line');
    expect(chunk).toMatchObject({ payload: { speaker: 'Sam', speakerRole: guestSeat.seat } });
  });

  it('tells two people with the same display name apart by the identity each real token issued', async () => {
    const { app, base, meetingId, ownerSeat } = await runningMeeting();
    const guestSeats: Array<Awaited<ReturnType<typeof seat>>> = [];
    for (let index = 0; index < 2; index += 1) {
      const joined = await request(base, `/api/meetings/${meetingId}/join`, {
        method: 'POST',
        body: { name: 'Sam' },
      });
      expect(joined.status).toBe(200);
      const cookie = cookiePair(setCookies(joined), 'kaki_session');
      if (cookie === undefined) throw new Error('the guest got no cookie');
      const seated = await seat(base, meetingId, cookie, 'Sam');
      expect(seated.status).toBe(200);
      guestSeats.push(seated);
    }
    const [first, second] = guestSeats;
    if (first === undefined || second === undefined) throw new Error('both guests seated');
    expect(first.seat).not.toBe(second.seat);
    expect(first.identity).toBe(first.seat);
    expect(second.identity).toBe(second.seat);

    const instance = await app.registry.get(meetingId);
    expect(instance?.session.holders().filter((holder) => holder.name === 'sam')).toHaveLength(2);

    const screen = await connect(base, meetingId, 'screen', ownerSeat.cookie);
    sockets.push(screen);

    const firstText = 'The first Sam checks the till.';
    const secondText = 'The second Sam checks the counter.';
    expect(
      (
        await postSpeechLine(base, meetingId, {
          participantIdentity: first.identity,
          seat: first.seat,
          text: firstText,
          clientLineId: 'same-name-first',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postSpeechLine(base, meetingId, {
          participantIdentity: second.identity,
          seat: second.seat,
          text: secondText,
          clientLineId: 'same-name-second',
        })
      ).status,
    ).toBe(200);

    const firstChunk = await waitFor(() => transcriptChunk(screen, firstText), 'the first Sam line');
    const secondChunk = await waitFor(() => transcriptChunk(screen, secondText), 'the second Sam line');
    expect(firstChunk).toMatchObject({ payload: { speaker: 'Sam', speakerRole: first.seat } });
    expect(secondChunk).toMatchObject({ payload: { speaker: 'Sam', speakerRole: second.seat } });
  });
});
