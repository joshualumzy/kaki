import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMeetingInviteIcs, KOPITIAM_INVITE_UID, type MeetingInvite, type MeetingSetup } from '@kaki/shared';
import type { KakiApp } from '../src/app';
import type { CalendarSettings } from '../src/action/calendar';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { createTestApp, portOf } from './helpers';

const settings: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };

function invite(overrides: Partial<MeetingInvite> = {}): MeetingInvite {
  return {
    uid: KOPITIAM_INVITE_UID,
    title: 'Opening day huddle',
    agenda: [{ title: 'Counter cover', minutes: 7, owner: 'Chef' }],
    people: ['Ada', 'Bao'],
    ...overrides,
  };
}

function ics(value: MeetingInvite = invite()): string {
  return buildMeetingInviteIcs(value, { start: '2026-11-11 07:30', end: '2026-11-11 08:00' });
}

function calendarFetch(body = ics(), status = 200): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  return pair === undefined || pair === '' ? undefined : pair;
}

interface ImportBody {
  setup: MeetingSetup;
  started: boolean;
}

describe('setup calendar import', () => {
  let app: KakiApp | undefined;
  let base: string;

  afterEach(async () => {
    if (app !== undefined) await app.close();
  });

  async function start(options: Parameters<typeof createTestApp>[0] = {}): Promise<void> {
    app = await createTestApp(options);
    base = `http://127.0.0.1:${portOf(app)}`;
  }

  function postImport(cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base}/api/setup/import-calendar`, { method: 'POST', headers });
  }

  async function getSetup(): Promise<MeetingSetup> {
    const response = await fetch(`${base}/api/setup`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { setup: MeetingSetup }).setup;
  }

  it('stores a setup whose title and agenda come from the invite and whose roles and pace come from the pack', async () => {
    const fetchImpl = calendarFetch();
    await start({ calendar: settings, calendarFetch: fetchImpl });

    const response = await postImport();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ImportBody;
    expect(body.started).toBe(false);
    expect(body.setup.title).toBe('Opening day huddle');
    expect(body.setup.agenda).toEqual([{ id: 'agenda-1', title: 'Counter cover', minutes: 7, ownerRoleId: 'chef' }]);
    expect(body.setup.seats).toEqual([
      { displayName: 'Ada', roleId: 'chef', kind: 'person' },
      { displayName: 'Bao', roleId: 'cashier', kind: 'person' },
    ]);
    expect(body.setup.source).toEqual({
      title: 'calendar invite',
      agenda: 'calendar invite',
      roles: 'demo pack',
      seats: 'demo pack',
      pace: 'demo pack',
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://cal.test/user/calendar/');
    expect((await getSetup()).title).toBe('Opening day huddle');
  });

  it('returns 503 naming the missing calendar setting', async () => {
    await start();
    const response = await postImport();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('CALDAV_URL');
    expect((await getSetup()).title).toBe('Lunch service readiness');
  });

  it('returns 404 when the invite is not in the calendar and stores nothing', async () => {
    const missing = ics(invite({ uid: 'another-event@kaki.local' }));
    await start({ calendar: settings, calendarFetch: calendarFetch(missing) });

    const response = await postImport();
    expect(response.status).toBe(404);
    expect((await getSetup()).title).toBe('Lunch service readiness');
  });

  it('returns 422 with field errors for a malformed agenda and stores nothing', async () => {
    await start({ calendar: settings, calendarFetch: calendarFetch(ics(invite({ agenda: [{ title: 'Prep', minutes: 0, owner: 'Chef' }] }))) });

    const response = await postImport();
    expect(response.status).toBe(422);
    const body = (await response.json()) as { errors: Array<{ field: string }> };
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'agenda[0].minutes' }));
    expect((await getSetup()).title).toBe('Lunch service readiness');
  });

  it('returns 502 when the calendar cannot be reached and stores nothing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('connection refused');
    });
    await start({ calendar: settings, calendarFetch: fetchImpl });

    const response = await postImport();
    expect(response.status).toBe(502);
    expect((await getSetup()).title).toBe('Lunch service readiness');
  });

  it('refuses a participant', async () => {
    const store = createMemoryAuthStore();
    await store.createUser({
      email: 'host@example.com',
      passwordHash: await hashPassword('correct-horse-battery'),
    });
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    await start({ auth, meetingCode, calendar: settings, calendarFetch: calendarFetch() });

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'host@example.com', password: 'correct-horse-battery' }),
    });
    expect(login.status).toBe(200);
    const hostCookie = login.headers.get('set-cookie')?.split(';')[0];
    if (hostCookie === undefined || hostCookie === '') throw new Error('Login did not set a cookie');
    expect((await fetch(`${base}/api/meeting/open`, { method: 'POST', headers: { cookie: hostCookie } })).status).toBe(200);
    const joined = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'K7M2Q9', role: 'chef' }),
    });
    expect(joined.status).toBe(200);
    const cookie = cookieFrom(joined);
    if (cookie === undefined) throw new Error('Join did not set a cookie');

    const response = await postImport(cookie);
    expect(response.status).toBe(403);
  });

  it('refuses the import after Start', async () => {
    await start({ calendar: settings, calendarFetch: calendarFetch(), roomRoster: async () => [] });
    expect((await fetch(`${base}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const joined = await fetch(`${base}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Cook', participantRole: 'chef' }),
    });
    expect(joined.status).toBe(200);
    expect((await fetch(`${base}/api/meeting/start`, { method: 'POST' })).status).toBe(200);

    expect((await postImport()).status).toBe(409);
  });
});
