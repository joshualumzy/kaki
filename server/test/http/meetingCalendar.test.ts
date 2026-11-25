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

interface FakeCalendar {
  url: string;
  puts: Array<{ url: string; body: string }>;
  failWrites: boolean;
}

async function calendarServer(): Promise<FakeCalendar> {
  const fake: FakeCalendar = { url: '', puts: [], failWrites: false };
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.end(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
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
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
      );
      return;
    }
    if (req.method === 'PUT') {
      if (fake.failWrites) {
        res.statusCode = 500;
        res.end('calendar is down');
        return;
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
    expect(listing.events.map((event) => event.title)).toEqual(['Quarterly planning']);
    expect(listing.events[0]).toMatchObject({
      uid: 'planning@example.test',
      date: '2999-11-13',
      time: '10:00',
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
    expect((await cancelled.json()) as { calendarWarning: null }).toMatchObject({
      calendarWarning: null,
    });
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

  it('deletes a team workspace with everything it holds, warning when calendar cancellation fails', async () => {
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
    const deleted = await request(base, `/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      cookie: ada.cookie,
      body: { confirm: 'Kitchen' },
    });
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { ok: boolean; calendarWarnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.calendarWarnings).toHaveLength(1);
    expect(body.calendarWarnings[0]).toContain('Doomed meeting');

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
});
