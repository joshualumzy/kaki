import { afterEach, describe, expect, it } from 'vitest';
import { createRoomToken, JoinError } from '../src/livekit';
import { createApp } from '../src/app';
import { testScenario } from './fixtures/scenario';
import { createTestApp, portOf } from './helpers';

function claims(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
}

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

describe('POST /api/livekit/token', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  afterEach(() => app.close());

  async function post(body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${portOf(app)}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns a token and rejects malformed requests', async () => {
    app = await createTestApp({ devRoutes: false });
    const ok = await post({ roomName: 'room', participantName: 'Josh', participantRole: 'Producer' });
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { token: unknown }).token).toBe('string');

    expect((await post({ roomName: 'room' })).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
  });

  it('refuses a join when the meeting is full or the seat is taken', async () => {
    const role = testScenario.roles[0]!;
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const scenario = {
      ...testScenario,
      npcs: testScenario.attendees.map((a) => ({ ...npc, attendee: `AI ${a.name}`, role: 'x', playable: true })),
    };
    let present: Array<{ name: string; role?: string }> = [{ name: 'Visitor', role: role.label }];
    app = await createApp({ devRoutes: false, scenario, roomRoster: async () => present });
    const taken = await post({ roomName: 'room', participantName: 'Other', participantRole: role.label });
    expect(taken.status).toBe(409);
    present = [];
    expect((await post({ roomName: 'room', participantName: 'Other', participantRole: role.label })).status).toBe(200);
    // LiveKit cannot be asked: the join is allowed rather than blocked.
    app.close();
    app = await createApp({ devRoutes: false, scenario, roomRoster: async () => undefined });
    expect((await post({ roomName: 'room', participantName: 'Other', participantRole: role.label })).status).toBe(200);
  });

  it('gives the first person a code and makes the second person give it', async () => {
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const scenario = {
      ...testScenario,
      npcs: ['A', 'B', 'C', 'D'].map((n) => ({ ...npc, attendee: `AI ${n}`, role: 'x', playable: true })),
    };
    let present: Array<{ name: string; role?: string }> = [];
    app = await createApp({ devRoutes: false, scenario, roomRoster: async () => present });
    const first = await post({ roomName: 'room', participantName: 'One' });
    const code = ((await first.json()) as { meetingCode: string }).meetingCode;
    expect(code).toMatch(/^[A-Z2-9]{4}$/);

    present = [{ name: 'One' }];
    const missing = await post({ roomName: 'room', participantName: 'Two' });
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { needsCode: boolean }).needsCode).toBe(true);
    expect((await post({ roomName: 'room', participantName: 'Two', meetingCode: 'WRNG' })).status).toBe(403);
    const ok = await post({ roomName: 'room', participantName: 'Two', meetingCode: ` ${code.toLowerCase()} ` });
    expect(ok.status).toBe(200);

    // The room empties: the next first person starts a meeting with a new code.
    present = [];
    const again = await post({ roomName: 'room', participantName: 'Three' });
    expect(again.status).toBe(200);
  });

  it('rejects the name of an AI attendee from the scenario', async () => {
    app = await createApp({
      devRoutes: false,
      scenario: {
        ...testScenario,
        npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }],
      },
    });
    const taken = await post({ roomName: 'room', participantName: 'ADA' });
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as { error: string }).error).toMatch(/AI attendee/);
  });

  it('does not set CORS headers: the page reaches the server through its own origin', async () => {
    app = await createTestApp({ devRoutes: false });
    const response = await post({ roomName: 'room', participantName: 'Josh' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
