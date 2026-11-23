import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind } from '@kaki/shared';
import type { KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import type { EmailTransportFactory } from '../src/action/email';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import {
  createPracticeTestApp,
  createTestApp,
  meetingPath,
  meetingUrl,
  openRealMeeting,
  portOf,
  type TestAppWithMeeting,
} from './helpers';

const SECRETS = {
  GITEA_TOKEN: 'gitea-super-secret',
  MATTERMOST_TOKEN: 'mattermost-super-secret',
  WIKI_ADMIN_PASSWORD: 'wiki-super-secret',
};

const CONFIGURED_ENV = {
  CALDAV_URL: 'http://cal.test',
  GITEA_URL: 'http://gitea.test',
  GITEA_TOKEN: SECRETS.GITEA_TOKEN,
  GITEA_ORG: 'kaki',
  GITEA_REPO: 'meeting',
  MATTERMOST_URL: 'http://mattermost.test',
  MATTERMOST_TOKEN: SECRETS.MATTERMOST_TOKEN,
  MATTERMOST_TEAM: 'kopitiam',
  MATTERMOST_CHANNEL: 'town-square',
  MAILPIT_SMTP_HOST: '127.0.0.1',
  MAILPIT_SMTP_PORT: '1025',
  MAILPIT_URL: 'http://mailpit.test',
  EMAIL_FROM: 'kaki@example.test',
  WIKI_URL: 'http://wiki.test',
  WIKI_ADMIN_EMAIL: 'admin@example.test',
  WIKI_ADMIN_PASSWORD: SECRETS.WIKI_ADMIN_PASSWORD,
} as const satisfies NodeJS.ProcessEnv;

const KINDS: ActionKind[] = ['calendar_event', 'email', 'gitea_issue', 'mattermost_post', 'wiki_page'];

interface ToolStatus {
  kind: ActionKind;
  label: string;
  configured: boolean;
  missing: string[];
}

interface ProbeBody {
  kind: ActionKind;
  ok: boolean;
  detail?: string;
  problem?: string;
  message?: string;
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  const pair = header?.split(';')[0];
  return pair === undefined || pair === '' ? undefined : pair;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function graphqlQuery(init: RequestInit | undefined): string {
  return String((JSON.parse(String(init?.body)) as { query?: string }).query ?? '');
}

function wikiReply(query: string): Response {
  if (query.includes('Login')) {
    return Response.json({
      data: { authentication: { login: { jwt: 'wiki-jwt', responseResult: { succeeded: true } } } },
    });
  }
  return Response.json({ data: { pages: { list: [] } } });
}

function healthyFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith('http://cal.test/')) return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    if (url === 'http://gitea.test/api/v1/user') return Response.json({ login: 'kaki' });
    if (url === 'http://mattermost.test/api/v4/users/me') return Response.json({ username: 'kaki' });
    if (url.startsWith('http://mailpit.test/')) return Response.json({ messages: [], total: 0 });
    if (url === 'http://wiki.test/graphql') return wikiReply(graphqlQuery(init));
    return new Response('unexpected URL', { status: 500 });
  });
}

function statusFetch(status: number): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response('', { status }));
}

function healthyEmailTransport(): EmailTransportFactory {
  return () => ({ verify: async () => true, close: () => {} });
}

function refusedFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => {
    throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
  });
}

function slowFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
}

describe('setup tool status and probes', () => {
  let app: KakiApp | undefined;
  let base: string;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  async function start(options: Parameters<typeof createTestApp>[0] = {}): Promise<void> {
    const practice = await createPracticeTestApp(options);
    app = practice;
    base = `http://127.0.0.1:${portOf(practice)}${meetingPath(practice, '')}`;
  }

  async function tools(env: NodeJS.ProcessEnv, cookie?: string): Promise<{ status: number; tools: ToolStatus[]; text: string }> {
    await start({ actionTools: { env } });
    const response = await fetch(`${base}/api/setup/tools`, cookie === undefined ? undefined : { headers: { cookie } });
    const text = await response.text();
    return { status: response.status, tools: (JSON.parse(text) as { tools: ToolStatus[] }).tools, text };
  }

  function postProbe(kind: string, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers.cookie = cookie;
    return fetch(`${base}/api/setup/tools/${encodeURIComponent(kind)}/test`, { method: 'POST', headers });
  }

  async function probe(kind: ActionKind, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, timeoutMs = 5_000): Promise<{ status: number; body: ProbeBody; text: string }> {
    await start({ actionTools: { env, fetchImpl, timeoutMs, emailTransport: healthyEmailTransport() } });
    const response = await postProbe(kind);
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as ProbeBody, text };
  }

  it('reports every supported tool and the environment variable names it still needs', async () => {
    const { status, tools: list, text } = await tools({});

    expect(status).toBe(200);
    expect(list.map((tool) => tool.kind).sort()).toEqual([...KINDS].sort());
    for (const tool of list) {
      expect(tool.label).not.toBe('');
      expect(tool.configured).toBe(false);
    }
    const byKind = new Map(list.map((tool) => [tool.kind, tool]));
    expect(byKind.get('calendar_event')?.missing).toEqual(['CALDAV_URL']);
    expect(byKind.get('email')?.missing).toEqual(['MAILPIT_SMTP_HOST', 'MAILPIT_SMTP_PORT', 'MAILPIT_URL', 'EMAIL_FROM']);
    expect(byKind.get('gitea_issue')?.missing).toEqual(['GITEA_URL', 'GITEA_TOKEN', 'GITEA_ORG', 'GITEA_REPO']);
    expect(byKind.get('mattermost_post')?.missing).toEqual([
      'MATTERMOST_URL',
      'MATTERMOST_TOKEN',
      'MATTERMOST_TEAM',
      'MATTERMOST_CHANNEL',
    ]);
    expect(byKind.get('wiki_page')?.missing).toEqual(['WIKI_URL', 'WIKI_ADMIN_EMAIL', 'WIKI_ADMIN_PASSWORD']);
    expect(text).not.toContain(SECRETS.GITEA_TOKEN);
  });

  it('reports a configured tool as connected without returning its settings', async () => {
    const { status, tools: list, text } = await tools(CONFIGURED_ENV);
    expect(status).toBe(200);
    expect(list.every((tool) => tool.configured && tool.missing.length === 0)).toBe(true);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
  });

  it('treats an invalid mail port as a missing setting rather than failing the status request', async () => {
    const { status, tools: list } = await tools({ ...CONFIGURED_ENV, MAILPIT_SMTP_PORT: 'not-a-port' });
    expect(status).toBe(200);
    expect(list.find((tool) => tool.kind === 'email')).toMatchObject({
      configured: false,
      missing: ['MAILPIT_SMTP_PORT'],
    });
  });

  it.each(KINDS)('probes %s with a successful read-only request', async (kind) => {
    const fetchImpl = healthyFetch();
    const { status, body, text } = await probe(kind, CONFIGURED_ENV, fetchImpl);

    expect(status).toBe(200);
    expect(body).toMatchObject({ kind, ok: true });
    expect(body.detail).toBeTruthy();
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);

    const expectedPath: Record<ActionKind, string> = {
      calendar_event: 'http://cal.test/user/calendar/',
      email: 'http://mailpit.test/api/v1/messages?limit=1',
      gitea_issue: 'http://gitea.test/api/v1/user',
      mattermost_post: 'http://mattermost.test/api/v4/users/me',
      wiki_page: 'http://wiki.test/graphql',
    };
    expect(fetchImpl).toHaveBeenCalled();
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(requestUrl(input)).toBe(expectedPath[kind]);
      expect(['GET', 'POST']).toContain(String(init?.method ?? 'GET').toUpperCase());
      const query = String(init?.body ?? '');
      expect(query).not.toMatch(/Create|CreatePage|publish|sendMail|posts\b/i);
    }
  });

  it.each(KINDS)('reports an auth failure for %s on 401 and 403', async (kind) => {
    for (const status of [401, 403]) {
      const { status: httpStatus, body } = await probe(kind, CONFIGURED_ENV, statusFetch(status));
      expect(httpStatus).toBe(200);
      expect(body).toMatchObject({ kind, ok: false, problem: 'auth failed' });
      expect(body.message).toMatch(/token|login|credentials|permission/i);
    }
  });

  it.each(KINDS)('reports %s as unreachable when the connection is refused', async (kind) => {
    const { status, body } = await probe(kind, CONFIGURED_ENV, refusedFetch());
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind, ok: false, problem: 'unreachable' });
    expect(body.message).toMatch(/Couldn't reach/);
  });

  it.each(KINDS)('reports %s as a timeout when the tool does not answer in time', async (kind) => {
    const { status, body } = await probe(kind, CONFIGURED_ENV, slowFetch(), 20);
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind, ok: false, problem: 'timeout' });
  });

  it('reports missing settings as not configured and names only the variables', async () => {
    const { status, body, text } = await probe('gitea_issue', { ...CONFIGURED_ENV, GITEA_TOKEN: '' }, healthyFetch());
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'gitea_issue', ok: false, problem: 'not configured' });
    expect(body.message).toContain('GITEA_TOKEN');
    expect(body.message).not.toContain(SECRETS.GITEA_TOKEN);
    expect(text).not.toContain(SECRETS.MATTERMOST_TOKEN);
  });

  it('treats a malformed mail port as not configured', async () => {
    const { status, body } = await probe(
      'email',
      { ...CONFIGURED_ENV, MAILPIT_SMTP_PORT: 'NaN' },
      healthyFetch(),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'email', ok: false, problem: 'not configured' });
    expect(body.message).toContain('MAILPIT_SMTP_PORT');
  });

  it('reports an unexpected response when a tool answers with a server error', async () => {
    const { status, body } = await probe('mattermost_post', CONFIGURED_ENV, statusFetch(500));
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'mattermost_post', ok: false, problem: 'unexpected response' });
    expect(body.message).toContain('500');
  });

  it('never logs or returns configured secrets from a failing probe', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const fetched: string[] = [];
    for (const kind of KINDS) {
      const { text } = await probe(kind, CONFIGURED_ENV, refusedFetch());
      fetched.push(text);
    }

    for (const text of fetched) {
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    }
    for (const call of [...log.mock.calls, ...warn.mock.calls]) {
      const line = call.map(String).join(' ');
      for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
    }
  });

  it('keeps working after Start because the probe only reads', async () => {
    const fetchImpl = healthyFetch();
    await start({ actionTools: { env: CONFIGURED_ENV, fetchImpl }, roomRoster: async () => [] });
    const practice = app as TestAppWithMeeting;
    const joined = await fetch(meetingUrl(practice, practice.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: practice.cookie! },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Cook', participantRole: 'chef', kind: 'practice' }),
    });
    expect(joined.status).toBe(200);
    const started = await fetch(meetingUrl(practice, practice.meetingId, '/api/meeting/start'), {
      method: 'POST',
      headers: { cookie: practice.cookie! },
    });
    expect(started.status).toBe(200);

    const response = await postProbe('gitea_issue');
    expect(response.status).toBe(200);
    expect((await response.json()) as ProbeBody).toMatchObject({ kind: 'gitea_issue', ok: true });
  });

  it('returns 404 for an unknown tool kind', async () => {
    await start({ actionTools: { env: CONFIGURED_ENV } });
    const response = await postProbe('fax_machine');
    expect(response.status).toBe(404);
  });

  it('lets only the owner read or test tools when auth is on', async () => {
    const store = createMemoryAuthStore();
    const email = `${randomUUID()}@example.com`;
    const ownerUser = await store.createGoogleUser({ googleSub: randomUUID(), name: 'Ada', email });
    const token = randomUUID();
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: 'Ada',
      userId: ownerUser.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const owner = `kaki_session=${token}`;
    const meetingCode = createMeetingCodeSource('K7M2Q9');
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createTestApp({
      auth,
      meetingCode,
      actionTools: { env: CONFIGURED_ENV, fetchImpl: healthyFetch() },
      roomRoster: async () => [],
    });
    const meeting = await openRealMeeting(app, { ownerUserId: ownerUser.id, title: 'Weekly planning' });
    base = `http://127.0.0.1:${portOf(app)}${meetingPath(meeting, '')}`;

    const joined = await fetch(meetingUrl(app, meeting.id, '/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bao' }),
    });
    expect(joined.status).toBe(200);
    const guest = cookieFrom(joined);
    if (guest === undefined) throw new Error('Join did not set a cookie');
    const seated = await fetch(meetingUrl(app, meeting.id, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guest },
      body: JSON.stringify({ participantName: 'Bao' }),
    });
    expect(seated.status).toBe(200);
    const participant = cookieFrom(seated);
    if (participant === undefined) throw new Error('Taking a seat did not set a cookie');

    expect((await fetch(`${base}/api/setup/tools`, { headers: { cookie: participant } })).status).toBe(403);
    expect((await postProbe('gitea_issue', participant)).status).toBe(403);

    expect((await fetch(`${base}/api/setup/tools`, { headers: { cookie: owner } })).status).toBe(200);
    expect((await postProbe('gitea_issue', owner)).status).toBe(200);
  });
});
