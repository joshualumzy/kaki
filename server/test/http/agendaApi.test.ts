import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMeetingInviteIcs, KOPITIAM_INVITE_UID } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import type { CalendarSettings } from '../../src/action/calendar';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createMemoryMeetingStore, type MeetingStore } from '../../src/meeting/registry';
import { createFakeLlm, type LlmClient } from '../../src/services/llm';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const apps: KakiApp[] = [];
const CALENDAR: CalendarSettings = { caldavUrl: 'http://cal.test', viewBaseUrl: 'http://kaki.test' };

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const app of apps.splice(0)) await app.close();
});

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

interface BuildOptions {
  llm?: LlmClient;
  calendar?: CalendarSettings;
  calendarFetch?: typeof fetch;
}

async function buildApp(options: BuildOptions = {}): Promise<{
  base: string;
  store: AuthStore;
  meetings: MeetingStore;
}> {
  const store = createMemoryAuthStore();
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({ store, meetingCode });
  const meetings = createMemoryMeetingStore();
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings,
    ...options,
  });
  apps.push(app);
  return { base: `http://127.0.0.1:${portOf(app)}`, store, meetings };
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

function inviteIcs(
  agenda: Array<{ title: string; minutes: number; owner: string }> = [
    { title: 'Counter cover', minutes: 7, owner: 'Chef' },
  ],
): string {
  return buildMeetingInviteIcs(
    {
      uid: KOPITIAM_INVITE_UID,
      title: 'Opening day huddle',
      agenda,
      people: ['Ada', 'Bao'],
    },
    { start: '2026-11-11 07:30', end: '2026-11-11 08:00' },
  );
}

function calendarFetch(body = inviteIcs(), status = 200): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

describe('meeting agenda', () => {
  it('stores a trimmed agenda and shows it only in the workspace summary', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    const created = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: {
        workspaceId: team.workspace.id,
        title: 'Planning',
        agenda: [
          { title: '  Budget  ', minutes: 15 },
          { title: 'Hiring' },
        ],
      },
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    expect((await meetings.get(id))?.agenda).toEqual([
      { title: 'Budget', minutes: 15 },
      { title: 'Hiring' },
    ]);

    const workspace = (await (
      await request(base, `/api/workspaces/${team.workspace.id}`, { cookie: ada.cookie })
    ).json()) as { meetings: Array<{ id: string; agenda: unknown }> };
    expect(workspace.meetings.find((meeting) => meeting.id === id)?.agenda).toEqual([
      { title: 'Budget', minutes: 15 },
      { title: 'Hiring' },
    ]);

    const info = (await (await request(base, `/api/meetings/${id}/info`)).json()) as Record<string, unknown>;
    expect(info).not.toHaveProperty('agenda');
  });

  it('defaults a meeting with no agenda to an empty list', async () => {
    const { base, store, meetings } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    const created = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: { workspaceId: team.workspace.id, title: 'Planning' },
    });
    const { id } = (await created.json()) as { id: string };
    expect((await meetings.get(id))?.agenda).toEqual([]);
  });

  it.each([
    ['not a list', 'Budget'],
    ['more than 20 items', Array.from({ length: 21 }, (_item, index) => ({ title: `Item ${index + 1}` }))],
    ['an empty title', [{ title: '   ' }]],
    ['an overlong title', [{ title: 'x'.repeat(121) }]],
    ['a zero duration', [{ title: 'Budget', minutes: 0 }]],
    ['an overlong duration', [{ title: 'Budget', minutes: 241 }]],
    ['a fractional duration', [{ title: 'Budget', minutes: 1.5 }]],
    ['a string duration', [{ title: 'Budget', minutes: '5' }]],
  ])('refuses %s', async (_label, agenda) => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const team = await store.createWorkspace({ name: 'Team', createdBy: ada.user.id });

    const response = await request(base, '/api/meetings', {
      method: 'POST',
      cookie: ada.cookie,
      body: { workspaceId: team.workspace.id, title: 'Planning', agenda },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error.length).toBeGreaterThan(1);
  });
});

describe('Tell Kaki API', () => {
  it('fills a title and agenda from the model reply', async () => {
    const llm = createFakeLlm(() =>
      JSON.stringify({
        title: '  Budget review  ',
        agenda: [{ title: '  Budget  ', minutes: 10 }, { title: 'Hiring', minutes: null }],
      }),
    );
    const { base, store } = await buildApp({ llm });
    const ada = await signIn(store, 'Ada');

    const response = await request(base, '/api/tell-kaki', {
      method: 'POST',
      cookie: ada.cookie,
      body: { text: 'We need 10 minutes on the budget, then hiring.' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: 'Budget review',
      agenda: [{ title: 'Budget', minutes: 10 }, { title: 'Hiring' }],
    });
    expect(llm.callOptions[0]?.json).toBe(true);
    expect(llm.callOptions[0]?.schema?.name).toBe('tell_kaki');
    expect(llm.calls[0]?.[1]?.content).toBe('We need 10 minutes on the budget, then hiring.');
  });

  it('answers 502 when the model reply is malformed', async () => {
    const llm = createFakeLlm(() => '{"title":"Budget","agenda":[{"title":"Budget","owner":"Ada"}]}');
    const { base, store } = await buildApp({ llm });
    const ada = await signIn(store, 'Ada');

    const response = await request(base, '/api/tell-kaki', {
      method: 'POST',
      cookie: ada.cookie,
      body: { text: 'Budget' },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Couldn't read that; fill it in yourself." });
  });

  it('answers 503 when the model fails or is not configured', async () => {
    const llm = createFakeLlm(() => {
      throw new Error('gateway down');
    });
    const failing = await buildApp({ llm });
    const failingUser = await signIn(failing.store, 'Ada');
    const failed = await request(failing.base, '/api/tell-kaki', {
      method: 'POST',
      cookie: failingUser.cookie,
      body: { text: 'Budget' },
    });
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { error: string }).error).toContain('fill it in yourself');

    vi.stubEnv('KAKI_LLM_BASE_URL', '');
    vi.stubEnv('KAKI_LLM_API_KEY', '');
    vi.stubEnv('KAKI_LLM_MODEL', '');
    const missing = await buildApp();
    const missingUser = await signIn(missing.store, 'Ben');
    const response = await request(missing.base, '/api/tell-kaki', {
      method: 'POST',
      cookie: missingUser.cookie,
      body: { text: 'Budget' },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain('fill it in yourself');
  });

  it.each([
    ['empty text', ''],
    ['blank text', '   '],
    ['overlong text', 'x'.repeat(8_001)],
  ])('refuses %s', async (_label, text) => {
    const { base, store } = await buildApp({ llm: createFakeLlm(() => '{"title":null,"agenda":[]}') });
    const ada = await signIn(store, 'Ada');
    const response = await request(base, '/api/tell-kaki', {
      method: 'POST',
      cookie: ada.cookie,
      body: { text },
    });
    expect(response.status).toBe(400);
  });

  it('needs a signed-in user', async () => {
    const { base } = await buildApp({ llm: createFakeLlm(() => '{"title":null,"agenda":[]}') });
    expect(
      (await request(base, '/api/tell-kaki', { method: 'POST', body: { text: 'Budget' } })).status,
    ).toBe(401);
  });
});

describe('agenda from calendar API', () => {
  it('returns only the invite title and agenda item titles and minutes', async () => {
    const fetchImpl = calendarFetch();
    const { base, store } = await buildApp({ calendar: CALENDAR, calendarFetch: fetchImpl });
    const ada = await signIn(store, 'Ada');

    const response = await request(base, '/api/agenda/from-calendar', {
      method: 'POST',
      cookie: ada.cookie,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      title: 'Opening day huddle',
      agenda: [{ title: 'Counter cover', minutes: 7 }],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://cal.test/user/calendar/');
  });

  it('answers 503 when the calendar is not configured', async () => {
    const { base, store } = await buildApp();
    const ada = await signIn(store, 'Ada');
    const response = await request(base, '/api/agenda/from-calendar', {
      method: 'POST',
      cookie: ada.cookie,
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain('CALDAV_URL');
  });

  it('passes through a calendar fetch error', async () => {
    const notFound = await buildApp({ calendar: CALENDAR, calendarFetch: calendarFetch('', 404) });
    const notFoundUser = await signIn(notFound.store, 'Ada');
    const missing = await request(notFound.base, '/api/agenda/from-calendar', {
      method: 'POST',
      cookie: notFoundUser.cookie,
    });
    expect(missing.status).toBe(404);

    const brokenFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('connection refused');
    });
    const broken = await buildApp({ calendar: CALENDAR, calendarFetch: brokenFetch });
    const brokenUser = await signIn(broken.store, 'Ben');
    const failed = await request(broken.base, '/api/agenda/from-calendar', {
      method: 'POST',
      cookie: brokenUser.cookie,
    });
    expect(failed.status).toBe(502);
  });

  it('answers 404 for a missing invite and 422 for a malformed agenda', async () => {
    const other = buildMeetingInviteIcs(
      {
        uid: 'another-event@kaki.local',
        title: 'Other',
        agenda: [{ title: 'Budget', minutes: 5, owner: 'Ada' }],
        people: ['Ada'],
      },
      { start: '2026-11-11 07:30', end: '2026-11-11 08:00' },
    );
    const missing = await buildApp({ calendar: CALENDAR, calendarFetch: calendarFetch(other) });
    const missingUser = await signIn(missing.store, 'Ada');
    expect(
      (
        await request(missing.base, '/api/agenda/from-calendar', {
          method: 'POST',
          cookie: missingUser.cookie,
        })
      ).status,
    ).toBe(404);

    const malformed = await buildApp({
      calendar: CALENDAR,
      calendarFetch: calendarFetch(
        buildMeetingInviteIcs(
          {
            uid: KOPITIAM_INVITE_UID,
            title: 'Opening day huddle',
            agenda: [{ title: 'Counter cover', minutes: 0, owner: 'Chef' }],
            people: ['Ada', 'Chef'],
          },
          { start: '2026-11-11 07:30', end: '2026-11-11 08:00' },
        ),
      ),
    });
    const malformedUser = await signIn(malformed.store, 'Ben');
    const response = await request(malformed.base, '/api/agenda/from-calendar', {
      method: 'POST',
      cookie: malformedUser.cookie,
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { errors: Array<{ field: string }> }).errors).toContainEqual(
      expect.objectContaining({ field: 'agenda[0].minutes' }),
    );
  });

  it('needs a signed-in user', async () => {
    const { base } = await buildApp({ calendar: CALENDAR, calendarFetch: calendarFetch() });
    expect((await request(base, '/api/agenda/from-calendar', { method: 'POST' })).status).toBe(401);
  });
});
