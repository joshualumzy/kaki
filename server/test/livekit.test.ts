import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMISSION_RESERVATION_MS, createRoomToken, createSeatReservations, JoinError } from '../src/livekit';
import { createApp } from '../src/app';
import { testScenario } from './fixtures/scenario';
import { createTestApp, portOf, waitFor } from './helpers';

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
  let app: Awaited<ReturnType<typeof createTestApp>>;
  afterEach(() => {
    vi.unstubAllEnvs();
    return app.close();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns a token and rejects malformed requests, a missing role, and a role that is not a human seat', async () => {
    app = await createTestApp({ devRoutes: false, roomRoster: async () => [] });
    const ok = await post({ roomName: 'room', participantName: 'Josh', participantRole: 'Chef' });
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { token: unknown }).token).toBe('string');

    const missingRole = await post({ roomName: 'room', participantName: 'Josh' });
    expect(missingRole.status).toBe(400);
    expect(((await missingRole.json()) as { error: string }).error).toMatch(/participantRole is required/);

    const bogusRole = await post({ roomName: 'room', participantName: 'Josh', participantRole: 'Astronaut' });
    expect(bogusRole.status).toBe(400);
    expect(((await bogusRole.json()) as { error: string }).error).toMatch(/not a human seat/);

    expect((await post({ roomName: 'room' })).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
  });

  it('admits two distinct human seats from the scenario capacity and refuses the rest', async () => {
    const [chef, cashier] = testScenario.roles;
    let present: Roster = [];
    app = await createApp({ devRoutes: false, scenario: testScenario, roomRoster: async () => present });

    const first = await post({ roomName: 'room', participantName: 'One', participantRole: chef!.label });
    expect(first.status).toBe(200);
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;

    present = [{ name: 'One', role: chef!.id }];
    const second = await post({ roomName: 'room', participantName: 'Two', participantRole: cashier!.label, meetingCode: code });
    expect(second.status).toBe(200);

    present = [{ name: 'One', role: chef!.id }, { name: 'Two', role: cashier!.id }];
    const third = await post({ roomName: 'room', participantName: 'Three', participantRole: chef!.label, meetingCode: code });
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: string }).error).toMatch(/seat is taken/);
  });

  it('refuses a taken seat and a duplicate display name with clear reasons', async () => {
    vi.stubEnv('KAKI_MEETING_CODE', 'K7QX');
    const [chef, cashier] = testScenario.roles;
    let present: Roster = [{ name: 'Foo', role: chef!.label }];
    app = await createApp({ devRoutes: false, scenario: testScenario, roomRoster: async () => present });

    const takenSeat = await post({ roomName: 'room', participantName: 'Other', participantRole: chef!.label, meetingCode: 'K7QX' });
    expect(takenSeat.status).toBe(409);
    expect(((await takenSeat.json()) as { error: string }).error).toMatch(/seat is taken/);

    const duplicateName = await post({ roomName: 'room', participantName: 'foo', participantRole: cashier!.label, meetingCode: 'K7QX' });
    expect(duplicateName.status).toBe(409);
    expect(((await duplicateName.json()) as { error: string }).error).toMatch(/already in the meeting/i);
  });

  it('gives the first person a code and makes the second person give it', async () => {
    const [chef, cashier] = testScenario.roles;
    let present: Roster = [];
    // Grace 0: an empty room starts a new meeting at once, so the next person gets a fresh code.
    app = await createApp({
      devRoutes: false,
      scenario: testScenario,
      roomRoster: async () => present,
      rejoinGraceMs: 0,
      admissionReservationMs: 0,
    });
    const first = await post({ roomName: 'room', participantName: 'One', participantRole: chef!.label });
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    expect(code).toMatch(/^[A-Z2-9]{4}$/);

    present = [{ name: 'One', role: chef!.id }];
    const missing = await post({ roomName: 'room', participantName: 'Two', participantRole: cashier!.label });
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { needsCode: boolean }).needsCode).toBe(true);
    expect((await post({ roomName: 'room', participantName: 'Two', participantRole: cashier!.label, meetingCode: 'WRNG' })).status).toBe(403);
    const ok = await post({ roomName: 'room', participantName: 'Two', participantRole: cashier!.label, meetingCode: ` ${code.toLowerCase()} ` });
    expect(ok.status).toBe(200);

    // The room empties: the next first person starts a meeting with a new code.
    present = [];
    const again = await post({ roomName: 'room', participantName: 'Three', participantRole: chef!.label });
    expect(again.status).toBe(200);
  });

  it('fails clearly when LiveKit cannot say who is in the room', async () => {
    const chef = testScenario.roles[0]!;
    app = await createApp({ devRoutes: false, scenario: testScenario, roomRoster: async () => undefined });
    const response = await post({ roomName: 'room', participantName: 'Josh', participantRole: chef.label });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; retryable?: boolean };
    expect(body.error).toMatch(/Could not check who is in the meeting/);
    expect(body.retryable).toBe(true);
  });

  it('serializes two simultaneous joins for one seat so only one succeeds', async () => {
    const chef = testScenario.roles[0]!;
    let rosterCalls = 0;
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    app = await createApp({
      devRoutes: false,
      scenario: testScenario,
      rejoinGraceMs: 0,
      roomRoster: async () => {
        rosterCalls += 1;
        if (rosterCalls === 1) await gate;
        return [];
      },
    });

    const first = post({ roomName: 'room', participantName: 'Ada', participantRole: chef.label });
    await waitFor(() => (rosterCalls === 1 ? true : undefined), 'the first roster read');
    const second = post({ roomName: 'room', participantName: 'Bao', participantRole: chef.label });
    openGate?.();

    const statuses = (await Promise.all([first, second])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('rejects the name of an AI attendee from the scenario', async () => {
    const cashier = testScenario.roles[1]!;
    app = await createApp({
      devRoutes: false,
      scenario: {
        ...testScenario,
        npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }],
      },
      roomRoster: async () => [],
    });
    const taken = await post({ roomName: 'room', participantName: 'ADA', participantRole: cashier.label });
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as { error: string }).error).toMatch(/AI attendee/);
  });

  it('does not set CORS headers: the page reaches the server through its own origin', async () => {
    app = await createTestApp({ devRoutes: false, roomRoster: async () => [] });
    const response = await post({ roomName: 'room', participantName: 'Josh', participantRole: 'Chef' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
