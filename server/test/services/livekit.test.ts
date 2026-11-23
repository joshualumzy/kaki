import { afterEach, describe, expect, it, vi } from 'vitest';
import { KAKI_LISTENER_IDENTITY } from '@kaki/shared';
import {
  ADMISSION_RESERVATION_MS,
  createRoomToken,
  createSeatReservations,
  JoinError,
} from '../../src/services/livekit';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import {
  createPracticeTestApp,
  createTestApp,
  meetingUrl,
  openRealMeeting,
  type TestAppWithMeeting,
  type TestMeeting,
} from '../helpers';
import { testScenario } from '../fixtures/scenario';

function claims(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
}

type Roster = Array<{ name: string; role?: string }> | undefined;

describe('createRoomToken', () => {
  it('signs a token whose identity, name, role and room come from the join', async () => {
    const token = await createRoomToken({ roomName: 'room-1', participantName: ' Josh ', participantRole: 'Producer' });
    const body = claims(token);
    expect(body.sub).toBe('Josh');
    expect(body.name).toBe('Josh');
    expect(body.metadata).toBe('Producer');
    expect(body.video).toMatchObject({ roomJoin: true, room: 'room-1', canPublish: true, canSubscribe: true });
  });

  it('refuses an empty name and the name of an AI attendee, whatever its case', async () => {
    await expect(createRoomToken({ roomName: 'r', participantName: '  ' })).rejects.toBeInstanceOf(JoinError);
    await expect(createRoomToken({ roomName: 'r', participantName: 'arjun' }, ['Arjun', 'Mei'])).rejects.toThrow(
      /AI attendee/,
    );
  });
});

describe('seat reservations', () => {
  it('holds a seat until LiveKit shows the person, and releases it after the timeout', () => {
    let clock = 0;
    const reservations = createSeatReservations(ADMISSION_RESERVATION_MS, () => clock);
    reservations.add({ participantName: 'Ada', seatId: 'chef' });
    expect(reservations.active([])).toHaveLength(1);

    clock = ADMISSION_RESERVATION_MS - 1;
    expect(reservations.active([])).toHaveLength(1);
    clock = ADMISSION_RESERVATION_MS;
    expect(reservations.active([])).toHaveLength(0);
  });

  it('drops a reservation once the roster shows the person', () => {
    const reservations = createSeatReservations(ADMISSION_RESERVATION_MS, () => 0);
    reservations.add({ participantName: 'Ada', seatId: 'chef' });
    expect(reservations.active(['ada'])).toHaveLength(0);
  });

  it('replaces a reservation when the same person tries again', () => {
    const reservations = createSeatReservations(ADMISSION_RESERVATION_MS, () => 0);
    reservations.add({ participantName: 'Ada', seatId: 'chef' });
    reservations.add({ participantName: 'ADA', seatId: 'cashier' });
    expect(reservations.active([]).map((reservation) => reservation.seatId)).toEqual(['cashier']);
  });
});

describe('POST /api/livekit/token', () => {
  const apps: TestAppWithMeeting[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const app of apps.splice(0)) await app.close();
  });

  async function practiceApp(): Promise<TestAppWithMeeting> {
    const app = await createPracticeTestApp({ roomRoster: async () => [] });
    apps.push(app);
    return app;
  }

  async function realApp(options: {
    auth?: AuthStore;
    roomRoster?: () => Promise<Roster>;
  } = {}): Promise<{ app: TestAppWithMeeting; meeting: TestMeeting }> {
    const app = (await createTestApp({
      devRoutes: false,
      roomRoster: options.roomRoster ?? (async () => []),
      ...(options.auth === undefined
        ? {}
        : {
            auth: createAuth({
              store: options.auth,
              offeredRoles: () => testScenario.roles.map((role) => role.id),
              meetingCode: createMeetingCodeSource('K7M2Q9'),
            }),
            meetingCode: createMeetingCodeSource('K7M2Q9'),
          }),
    })) as TestAppWithMeeting;
    apps.push(app);
    const meeting = await openRealMeeting(app);
    return { app, meeting };
  }

  async function postPractice(app: TestAppWithMeeting, body: unknown): Promise<Response> {
    return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie! },
      body: JSON.stringify(typeof body === 'object' && body !== null ? { kind: 'practice', ...body } : body),
    });
  }

  async function postReal(
    app: TestAppWithMeeting,
    meeting: TestMeeting,
    body: unknown,
    cookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(meetingUrl(app, meeting.id, '/api/livekit/token'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  function cookieFrom(response: Response): string {
    const value = response.headers.get('set-cookie')?.split(';')[0];
    if (value === undefined || value === '') throw new Error('Expected a session cookie');
    return value;
  }

  async function joinGuest(app: TestAppWithMeeting, meeting: TestMeeting, name: string): Promise<string> {
    const joined = await fetch(meetingUrl(app, meeting.id, '/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(joined.status).toBe(200);
    return cookieFrom(joined);
  }

  it('returns a token and rejects malformed requests, a missing role, and a role that is not a human seat', async () => {
    const app = await practiceApp();
    const ok = await postPractice(app, { roomName: 'room', participantName: 'Josh', participantRole: 'Chef' });
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { token: unknown }).token).toBe('string');

    const missingRole = await postPractice(app, { roomName: 'room', participantName: 'Josh' });
    expect(missingRole.status).toBe(400);
    expect(((await missingRole.json()) as { error: string }).error).toMatch(/participantRole is required/);

    const bogusRole = await postPractice(app, { roomName: 'room', participantName: 'Josh', participantRole: 'Astronaut' });
    expect(bogusRole.status).toBe(400);
    expect(((await bogusRole.json()) as { error: string }).error).toMatch(/not a human seat/);

    expect((await postPractice(app, { roomName: 'room' })).status).toBe(400);
    expect((await postPractice(app, 'nope')).status).toBe(400);
  });

  it('seats each person under their own identity, never sharing one seat between two people', async () => {
    const { app, meeting } = await realApp();
    const first = await postReal(app, meeting, { participantName: 'One' });
    const second = await postReal(app, meeting, { participantName: 'Two' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstSeat = ((await first.json()) as { participantRole: string }).participantRole;
    const secondSeat = ((await second.json()) as { participantRole: string }).participantRole;
    expect(firstSeat).not.toBe(secondSeat);
    expect(meeting.session.holders().map((holder) => holder.seat).sort()).toEqual([firstSeat, secondSeat].sort());
  });

  it('seats two people who share a display name, and refuses a stale guest cookie', async () => {
    const store = createMemoryAuthStore();
    const { app, meeting } = await realApp({ auth: store });

    const firstCookie = await joinGuest(app, meeting, 'Sam');
    const first = await postReal(app, meeting, { participantName: 'Sam' }, firstCookie);
    expect(first.status).toBe(200);
    const firstSeat = ((await first.json()) as { participantRole: string }).participantRole;

    const secondCookie = await joinGuest(app, meeting, 'Sam');
    const second = await postReal(app, meeting, { participantName: 'Sam' }, secondCookie);
    expect(second.status).toBe(200);
    const secondSeat = ((await second.json()) as { participantRole: string }).participantRole;
    expect(secondSeat).not.toBe(firstSeat);

    // Taking the seat rotated the first cookie: the old one is stale and takes no seat.
    const stale = await postReal(app, meeting, { participantName: 'Sam' }, firstCookie);
    expect(stale.status).toBe(401);
  });

  it('needs no typed code: the invite link is the credential and no code is handed out', async () => {
    const store = createMemoryAuthStore();
    const { app, meeting } = await realApp({ auth: store });
    const cookie = await joinGuest(app, meeting, 'One');
    const joined = await postReal(app, meeting, { participantName: 'One' }, cookie);
    expect(joined.status).toBe(200);
    const body = (await joined.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('meetingCode');
    expect(body).not.toHaveProperty('needsCode');

    // A second person needs their own invite, never a code typed from the first.
    const second = await postReal(app, meeting, { participantName: 'Two' });
    expect(second.status).toBe(401);
  });

  it('does not need the LiveKit roster to admit a real meeting', async () => {
    const { app, meeting } = await realApp({ roomRoster: async () => undefined });
    const response = await postReal(app, meeting, { participantName: 'Josh' });
    expect(response.status).toBe(200);
  });

  it('serializes two simultaneous joins for one person so only one takes the seat', async () => {
    const store = createMemoryAuthStore();
    const { app, meeting } = await realApp({ auth: store });
    const cookie = await joinGuest(app, meeting, 'Ada');
    const [first, second] = await Promise.all([
      postReal(app, meeting, { participantName: 'Ada' }, cookie),
      postReal(app, meeting, { participantName: 'Ada' }, cookie),
    ]);
    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect(meeting.session.holders()).toHaveLength(1);
  });

  it('refuses an AI stand-in’s role and name on a practice join', async () => {
    const app = await createPracticeTestApp({
      scenario: {
        ...testScenario,
        npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant' }],
      },
      roomRoster: async () => [],
    });
    apps.push(app);
    const role = await postPractice(app, { roomName: 'room', participantName: 'Guest', participantRole: 'chef' });
    expect(role.status).toBe(400);
    expect(((await role.json()) as { error: string }).error).toMatch(/not a human seat/);

    const name = await postPractice(app, { roomName: 'room', participantName: 'ADA', participantRole: 'cashier' });
    expect(name.status).toBe(400);
    expect(((await name.json()) as { error: string }).error).toMatch(/AI attendee/);
  });

  it('rejects the name reserved for the meeting listener', async () => {
    const { app, meeting } = await realApp();
    const reserved = await postReal(app, meeting, { participantName: KAKI_LISTENER_IDENTITY.toUpperCase() });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { error: string }).error).toMatch(/AI attendee/);
  });

  it('does not set CORS headers: the page reaches the server through its own origin', async () => {
    const app = await practiceApp();
    const response = await postPractice(app, { roomName: 'room', participantName: 'Josh', participantRole: 'Chef' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
