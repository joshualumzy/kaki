import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { createMemoryWorkspaceToolStore } from '../../src/workspace/tools';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const apps: KakiApp[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

function newKey(): string {
  return randomBytes(32).toString('base64');
}

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

async function signIn(store: AuthStore, name: string): Promise<SignedIn> {
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

async function buildApp(store: AuthStore): Promise<{
  base: string;
  meetings: ReturnType<typeof createMemoryMeetingStore>;
  workspaceTools: ReturnType<typeof createMemoryWorkspaceToolStore>;
}> {
  const auth = createAuth({ store });
  const meetings = createMemoryMeetingStore();
  const workspaceTools = createMemoryWorkspaceToolStore();
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetings,
    workspaceTools,
    indexWorkspaceTool: async () => undefined,
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, meetings, workspaceTools };
}

function request(
  base: string,
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeCalendar {
  url: string;
  puts: Array<{ url: string; body: string }>;
  failWrites: boolean;
  /** When set, the next successful PUT waits: the test can edit or cancel while it is in flight. */
  holdNextPut?: Deferred;
  putStarted?: Deferred;
}

function utcStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

async function calendarServer(): Promise<FakeCalendar> {
  const fake: FakeCalendar = { url: '', puts: [], failWrites: false };
  const server = createServer((req, res) => {
    void (async () => {
    if (req.method === 'GET') {
      const earlier = utcStamp(new Date(Date.now() - 60_000));
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.end(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:earlier@example.test',
          `DTSTART:${earlier}`,
          'SUMMARY:Earlier today',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:planning@example.test',
          'DTSTART:29991113T100000Z',
          'DTEND:29991113T110000Z',
          'SUMMARY:Quarterly planning',
          'DESCRIPTION:Agenda:\\n- Budget\\n- Hiring',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:past@example.test',
          'DTSTART:20000101T100000Z',
          'SUMMARY:Old event',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:cancelled@example.test',
          'DTSTART:29991114T100000Z',
          'SUMMARY:Cancelled event',
          'STATUS:CANCELLED',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      );
      return;
    }
    if (req.method === 'REPORT') {
      const earlierStart = utcStamp(new Date(Date.now() - 60_000));
      const earlier = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:earlier@example.test',
        `DTSTART:${earlierStart}`,
        'SUMMARY:Earlier today',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      const planning = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:planning@example.test',
        'DTSTART:29991113T100000Z',
        'DTEND:29991113T110000Z',
        'SUMMARY:Quarterly planning',
        'DESCRIPTION:Agenda:\\n- Budget\\n- Hiring',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      const past = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:past@example.test',
        'DTSTART:20000101T100000Z',
        'SUMMARY:Old event',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      res.setHeader('content-type', 'application/xml; charset=utf-8');
      res.end(
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
          '<d:response><d:href>/user/calendar/earlier.ics</d:href><d:propstat><d:prop><c:calendar-data>',
          earlier,
          '</c:calendar-data></d:prop></d:propstat></d:response>',
          '<d:response><d:href>/user/calendar/planning.ics</d:href><d:propstat><d:prop><c:calendar-data>',
          planning,
          '</c:calendar-data></d:prop></d:propstat></d:response>',
          '<d:response><d:href>/user/calendar/past.ics</d:href><d:propstat><d:prop><c:calendar-data>',
          past,
          '</c:calendar-data></d:prop></d:propstat></d:response>',
          '</d:multistatus>',
        ].join(''),
      );
      return;
    }
    if (req.method === 'PUT') {
      if (fake.failWrites) {
        res.statusCode = 500;
        res.end('calendar is down');
        return;
      }
      const hold = fake.holdNextPut;
      if (hold !== undefined) {
        fake.holdNextPut = undefined;
        fake.putStarted?.resolve();
        await hold.promise;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        fake.puts.push({ url: String(req.url), body });
        res.statusCode = 201;
        res.end();
      });
      return;
    }
    // MKCOL and MKCALENDAR may already exist; the PUT is what matters here.
    res.statusCode = 405;
    res.end();
    })();
  });
  fake.url = await listen(server);
  return fake;
}

async function createTeam(base: string, cookie: string): Promise<string> {
  const response = await request(base, '/api/workspaces', {
    method: 'POST',
    cookie,
    body: { name: 'Kitchen' },
  });
  return ((await response.json()) as { id: string }).id;
}

async function connectCalendar(
  base: string,
  cookie: string,
  workspaceId: string,
  caldavUrl: string,
): Promise<void> {
  const response = await request(base, `/api/workspaces/${workspaceId}/tools/calendar`, {
    method: 'PUT',
    cookie,
    body: { settings: { caldavUrl } },
  });
  expect(response.status).toBe(200);
}

async function scheduleMeeting(
  base: string,
  cookie: string,
  workspaceId: string,
  title = 'Weekly sync',
): Promise<{ id: string; calendar: { uid: string; sequence: number; state: string } }> {
  const response = await request(base, '/api/meetings', {
    method: 'POST',
    cookie,
    body: {
      workspaceId,
      title,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      agenda: [{ title: 'Budget', minutes: 20 }],
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    calendar: { uid: string; sequence: number; state: string };
  };
}

describe('workspace calendar and meeting events', () => {
  it('lists upcoming workspace events, syncs one event per meeting, updates it and cancels it', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);

    const list = await request(base, `/api/workspaces/${workspaceId}/calendar/events`, {
      cookie: ada.cookie,
    });
    expect(list.status).toBe(200);
    const listing = (await list.json()) as {
      connected: boolean;
      events: Array<{ uid: string; title: string; date: string; time: string; description: string }>;
    };
    expect(listing.connected).toBe(true);
    // An event that started earlier today is not upcoming; only the future one is listed.
    expect(listing.events.map((event) => event.title)).toEqual(['Quarterly planning']);
    expect(listing.events[0]).toMatchObject({
      uid: 'planning@example.test',
      date: '2999-11-13',
      time: '10:00',
      start: '2999-11-13T10:00:00.000Z',
      timeZone: 'UTC',
      fileId: 'planning',
    });

    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId);
    expect(meeting.calendar.state).toBe('synced');
    expect(meeting.calendar.uid).toBe(`kaki-meeting-${meeting.id}@kaki.local`);
    expect(meeting.calendar.sequence).toBe(0);
    const firstPut = calendar.puts.at(-1);
    expect(firstPut?.url).toBe(`/user/calendar/kaki-meeting-${meeting.id}.ics`);
    expect(firstPut?.body).toContain(`UID:kaki-meeting-${meeting.id}@kaki.local`);
    expect(firstPut?.body).toContain('SEQUENCE:0');
    expect(firstPut?.body).toContain('STATUS:CONFIRMED');

    const updated = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: ada.cookie,
      body: { title: 'Weekly sync v2' },
    });
    expect(updated.status).toBe(200);
    expect(calendar.puts.at(-1)?.body).toContain('SEQUENCE:1');
    expect(calendar.puts.at(-1)?.body).toContain('SUMMARY:Weekly sync v2');
    expect(calendar.puts.at(-1)?.url).toBe(`/user/calendar/kaki-meeting-${meeting.id}.ics`);

    const download = await request(base, `/api/meetings/${meeting.id}/calendar.ics`, {
      cookie: ada.cookie,
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('text/calendar');
    const ics = await download.text();
    expect(ics).toContain(`UID:kaki-meeting-${meeting.id}@kaki.local`);
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('DTSTART:');
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);

    const cancelled = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
    expect(calendar.puts.at(-1)?.body).toContain('STATUS:CANCELLED');
    expect(calendar.puts.at(-1)?.body).toContain('SEQUENCE:2');
  });

  it('keeps the meeting when the calendar refuses, stores the failure and retries it', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);
    calendar.failWrites = true;

    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId, 'Calendar down');
    expect(meeting.calendar.state).toBe('error');
    expect(meeting.calendar.sequence).toBe(0);

    const detail = await request(base, `/api/workspaces/${workspaceId}`, { cookie: ada.cookie });
    const workspace = (await detail.json()) as {
      meetings: Array<{ id: string; calendar: { state: string; error: string; sequence: number } }>;
    };
    expect(workspace.meetings[0]).toMatchObject({
      id: meeting.id,
      calendar: { state: 'error', sequence: 0 },
    });
    expect(workspace.meetings[0]?.calendar.error).toContain('HTTP 500');

    calendar.failWrites = false;
    const retried = await request(base, `/api/meetings/${meeting.id}/calendar-sync`, {
      method: 'POST',
      cookie: ada.cookie,
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      calendar: { state: 'synced', sequence: 0 },
      warning: null,
    });
    expect(calendar.puts.at(-1)?.body).toContain('SEQUENCE:0');
  });

  it('refuses to delete a workspace when the calendar is unreachable, then deletes anyway on request', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base, meetings, workspaceTools } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'member' });
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);
    await scheduleMeeting(base, ada.cookie, workspaceId, 'Doomed meeting');

    const wrong = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'wrong name' },
    });
    expect(wrong.status).toBe(400);

    const asMember = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ben.cookie,
      body: { confirm: 'Kitchen' },
    });
    expect(asMember.status).toBe(403);

    calendar.failWrites = true;
    const refused = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'Kitchen' },
    });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      error: "The team calendar can't be reached, so the workspace wasn't deleted. Try again.",
      canDeleteAnyway: true,
    });
    // Nothing was deleted and no calendar event was marked cancelled.
    expect(await store.getWorkspace(workspaceId)).toBeDefined();
    expect(await meetings.list(workspaceId)).toHaveLength(1);
    expect(calendar.puts.filter((put) => put.body.includes('STATUS:CANCELLED'))).toHaveLength(0);

    const deleted = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'Kitchen', deleteAnyway: true },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      ok: true,
      calendarEventsMayRemain: true,
    });

    expect(await store.getWorkspace(workspaceId)).toBeUndefined();
    expect(await store.getMembership({ workspaceId, userId: ada.user.id })).toBeUndefined();
    expect(await meetings.list(workspaceId)).toEqual([]);
    expect(await workspaceTools.list(workspaceId)).toEqual([]);
  });

  it('refuses the workspace calendar and .ics to a non-member', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId, 'Private sync');

    expect(
      (await request(base, `/api/workspaces/${workspaceId}/calendar/events`, { cookie: ben.cookie }))
        .status,
    ).toBe(404);
    expect(
      (await request(base, `/api/meetings/${meeting.id}/calendar.ics`, { cookie: ben.cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(base, `/api/meetings/${meeting.id}/calendar-sync`, {
          method: 'POST',
          cookie: ben.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('answers plainly when the workspace has no calendar', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);

    const list = await request(base, `/api/workspaces/${workspaceId}/calendar/events`, {
      cookie: ada.cookie,
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ connected: false, events: [] });

    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId, 'No calendar');
    expect(meeting.calendar).toMatchObject({ state: 'not_connected', sequence: 0 });
  });
  it('limits calendar picker reads to 60 a minute for the signed-in account', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);

    for (let read = 0; read < 60; read += 1) {
      const allowed = await request(base, `/api/workspaces/${workspaceId}/calendar/events`, {
        cookie: ada.cookie,
      });
      expect(allowed.status).toBe(200);
    }
    const limited = await request(base, `/api/workspaces/${workspaceId}/calendar/events`, {
      cookie: ada.cookie,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: 'Too many calendar reads. Wait a minute and try again.',
    });
  });

  it('binds a meeting to the picked event and updates that resource instead of adding a duplicate', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);

    const start = '2999-11-13T10:00:00.000Z';
    const created = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: {
        workspaceId,
        title: 'Quarterly planning',
        scheduledFor: start,
        calendarEvent: { uid: 'planning@example.test' },
      },
    });
    expect(created.status).toBe(200);
    const meeting = (await created.json()) as {
      id: string;
      calendar: { uid: string; sequence: number; fileId?: string };
    };
    expect(meeting.calendar.uid).toBe('planning@example.test');
    expect(meeting.calendar.fileId).toBe('planning');
    const firstPut = calendar.puts.at(-1);
    expect(firstPut?.url).toBe('/user/calendar/planning.ics');
    expect(firstPut?.body).toContain('UID:planning@example.test');
    expect(calendar.puts.filter((put) => put.body.includes('UID:planning@example.test'))).toHaveLength(1);

    const updated = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: ada.cookie,
      body: { title: 'Quarterly planning v2' },
    });
    expect(updated.status).toBe(200);
    expect(calendar.puts.at(-1)?.url).toBe('/user/calendar/planning.ics');
    expect(calendar.puts.at(-1)?.body).toContain('UID:planning@example.test');
    expect(calendar.puts.at(-1)?.body).toContain('SEQUENCE:1');
  });

  it('refuses a picked event that is no longer in the workspace calendar', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);

    const created = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: {
        workspaceId,
        title: 'Gone',
        scheduledFor: '2999-11-13T10:00:00.000Z',
        calendarEvent: { uid: 'not-there@example.test' },
      },
    });
    expect(created.status).toBe(400);
    expect(calendar.puts).toHaveLength(0);
  });

  it('refuses to cancel a meeting when the calendar is unreachable and keeps the meeting', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base, meetings } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);
    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId, 'Late cancel');

    calendar.failWrites = true;
    const cancelled = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(cancelled.status).toBe(502);
    expect(await cancelled.json()).toEqual({
      error: "The team calendar can't be reached, so the meeting wasn't cancelled. Try again.",
    });
    // The meeting and its row stay, so the person can try again.
    expect(await meetings.list(workspaceId)).toHaveLength(1);

    calendar.failWrites = false;
    const retried = await request(base, `/api/meetings/${meeting.id}`, {
      method: 'DELETE',
      cookie: ada.cookie,
    });
    expect(retried.status).toBe(200);
    expect(calendar.puts.at(-1)?.body).toContain('STATUS:CANCELLED');
    expect(await meetings.list(workspaceId)).toEqual([]);
  });

  it('serialises a delayed retry with an edit so it cannot roll back the title or SEQUENCE', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const workspaceId = await createTeam(base, ada.cookie);
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);
    calendar.failWrites = true;
    const meeting = await scheduleMeeting(base, ada.cookie, workspaceId, 'Retry race');

    calendar.failWrites = false;
    const hold = deferred();
    calendar.putStarted = deferred();
    calendar.holdNextPut = hold;
    const retry = request(base, `/api/meetings/${meeting.id}/calendar-sync`, {
      method: 'POST',
      cookie: ada.cookie,
    });
    await calendar.putStarted.promise;
    const edit = request(base, `/api/meetings/${meeting.id}`, {
      method: 'PATCH',
      cookie: ada.cookie,
      body: { title: 'Edited during retry' },
    });
    hold.resolve();
    expect((await retry).status).toBe(200);
    expect((await edit).status).toBe(200);

    const detail = await request(base, `/api/workspaces/${workspaceId}`, { cookie: ada.cookie });
    const workspace = (await detail.json()) as {
      meetings: Array<{ id: string; calendar: { sequence: number; state: string } }>;
    };
    expect(workspace.meetings[0]?.calendar).toMatchObject({ state: 'synced', sequence: 1 });
    expect(calendar.puts.at(-1)?.body).toContain('SUMMARY:Edited during retry');
    expect(calendar.puts.at(-1)?.body).toContain('SEQUENCE:1');
  });


  it('runs no cancellation or room teardown when the admin loses the role before deletion', async () => {
    process.env.KAKI_SECRET_KEY = newKey();
    const store = createMemoryAuthStore();
    const { base } = await buildApp(store);
    const ada = await signIn(store, 'Ada');
    const ben = await signIn(store, 'Ben');
    const workspaceId = await createTeam(base, ada.cookie);
    await store.addWorkspaceMember({ workspaceId, userId: ben.user.id, role: 'admin' });
    const calendar = await calendarServer();
    await connectCalendar(base, ada.cookie, workspaceId, calendar.url);
    await scheduleMeeting(base, ada.cookie, workspaceId, 'Doomed by a demoted admin');
    const putsBefore = calendar.puts.length;

    const realDelete = store.deleteWorkspace.bind(store);
    store.deleteWorkspace = async (input, client) => {
      // A concurrent demotion lands after the route's first check but before the locked recheck.
      await store.setWorkspaceMemberRole({
        workspaceId: input.id,
        userId: input.actorUserId,
        role: 'member',
        actorUserId: ben.user.id,
      });
      return realDelete(input, client);
    };

    const deleted = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'Kitchen' },
    });
    expect(deleted.status).toBe(404);
    expect(calendar.puts).toHaveLength(putsBefore);
    expect(await store.getWorkspace(workspaceId)).toBeDefined();
  });

});
