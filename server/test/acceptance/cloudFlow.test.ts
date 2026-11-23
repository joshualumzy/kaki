import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { parseScenario, type KakiEvent, type Scenario } from '@kaki/shared';
import type { KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import { createMemoryAuthStore, type AuthStore, type UserRecord } from '../../src/auth/store';
import type { MeetingPauseControl } from '../../src/host';
import { createAgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { createRunnerClient } from '../../src/npc/runnerClient';
import { testScenario } from '../fixtures/scenario';
import {
  createTestApp,
  meetingPath,
  meetingWsUrl,
  openRealMeeting,
  portOf,
  realModulesWith,
  settle,
  waitFor,
  type TestMeeting,
} from '../helpers';
import { createPostgresTestSchema, type PostgresTestSchema } from '../postgresTestSchema';

const serviceToken = 'local-test-runner-token';
const connectionString = process.env.POSTGRES_URL;

const scenario: Scenario = {
  ...testScenario,
  roles: [
    { id: 'chef', label: 'Chef', card: { youAre: 'Chef', facts: ['chef secret'], responsibility: 'Cook' } },
    { id: 'cashier', label: 'Cashier', card: { youAre: 'Cashier', facts: ['cashier secret'], responsibility: 'Count' } },
    { id: 'manager', label: 'Manager', card: { youAre: 'Manager', facts: ['manager secret'], responsibility: 'Lead' } },
  ],
  attendees: [
    ...testScenario.attendees,
    { name: 'Mia', role: 'manager', displayName: 'Mia (Manager)' },
  ],
  agenda: [{ ...testScenario.agenda[0]!, directions: ['private direction'], seatFacts: {
    chef: 'chef agenda secret', cashier: 'cashier agenda secret', manager: 'manager agenda secret',
  } }],
};

interface SignedIn {
  user: UserRecord;
  cookie: string;
}

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie');
  return value;
}

async function signInGoogle(store: AuthStore, name: string): Promise<SignedIn> {
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

async function socket(
  port: number,
  meetingId: string,
  query: string,
  credentials: { cookie?: string; token?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (credentials.cookie) headers.cookie = credentials.cookie;
  if (credentials.token) headers.authorization = `Bearer ${credentials.token}`;
  const ws = new WebSocket(meetingWsUrl(port, meetingId, query), { headers });
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  const result = await new Promise<{ ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number }>((resolve) => {
    ws.once('open', () => resolve({ ok: true, ws, messages }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once('error', () => resolve({ ok: false, status: 0 }));
  });
  return result;
}

for (const kind of ['memory', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && connectionString === undefined)(`auth-on cloud flow (${kind})`, () => {
    let app: KakiApp | undefined;
    let postgres: PostgresTestSchema | undefined;
    const sockets: WebSocket[] = [];

    afterEach(async () => {
      for (const ws of sockets.splice(0)) ws.terminate();
      if (app) await app.close();
      await postgres?.dispose();
      app = undefined;
      postgres = undefined;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('admits guests before the host, protects runner traffic, and revokes the old meeting', async () => {
      vi.stubEnv('KAKI_AUTH', '1');
      vi.stubEnv('KAKI_AUTO_DISPATCH', '0');
      vi.stubEnv('KAKI_PUBLIC_URL', 'https://kaki.example.test');
      vi.stubEnv('LIVEKIT_API_KEY', 'acceptance-key');
      vi.stubEnv('LIVEKIT_API_SECRET', 'acceptance-secret-for-local-signing-only');
      vi.stubEnv('MATTERMOST_URL', '');
      vi.stubEnv('MATTERMOST_PUBLIC_URL', '');
      vi.stubEnv('MATTERMOST_PASSWORD', '');
      let store: AuthStore;
      if (kind === 'postgres') {
        if (!connectionString) throw new Error('POSTGRES_URL is missing');
        postgres = await createPostgresTestSchema(connectionString);
        await ensureAuthSchema(postgres.pool);
        store = createPostgresAuthStore(postgres.pool);
      } else {
        store = createMemoryAuthStore();
      }
      const owner = await signInGoogle(store, 'Demo');
      const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier', 'manager'], secureCookies: true });
      const roster: Array<{ name: string; role: string }> = [];
      const clock = createAgendaClock({ agenda: scenario.agenda });
      const pause: MeetingPauseControl = {
        paused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
        kind: () => clock.snapshot().pauseKind,
        pause: (kind) => clock.pause(kind),
        resume: () => clock.resume(),
      };
      app = await createTestApp({
        scenario: structuredClone(scenario),
        auth,
        serviceToken,
        roomRoster: async () => roster,
        rejoinGraceMs: 25,
        rejoinPollMs: 5,
        admissionReservationMs: 5,
        meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })], {
          meetingAgendaIndex: () => (clock.snapshot().started ? clock.snapshot().agendaIndex : undefined),
          meetingPaused: pause.paused,
          meetingPause: pause,
        }),
      });
      const joinLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const port = portOf(app);
      const base = `http://127.0.0.1:${port}`;
      const request = (path: string, method = 'GET', body?: unknown, credentials: { cookie?: string; token?: string } = {}) => {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (credentials.cookie) headers.cookie = credentials.cookie;
        if (credentials.token) headers.authorization = `Bearer ${credentials.token}`;
        return fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      };
      const remember = (value: string) => value;
      const state = async (meeting: TestMeeting) =>
        (await (await request(meetingPath(meeting, '/api/meeting/state'))).json()) as { meetingId: string; started: boolean };

      const meeting = await openRealMeeting(app, {
        workspaceId: 'workspace-1',
        ownerUserId: owner.user.id,
        title: 'Weekly planning',
        agenda: [{ title: 'Prep', minutes: 5 }],
      });
      expect((await request(meetingPath(meeting, '/api/meeting/open'), 'POST', undefined, { cookie: owner.cookie })).status).toBe(200);

      // 1. Anonymous readers get a parser-valid public projection with no private material.
      const publicScenario = parseScenario(await (await request(meetingPath(meeting, '/api/scenario'))).json(), {
        requireOrganisation: false,
        allowEmptyAgenda: true,
        allowEmptyRoles: true,
      });
      expect(publicScenario.roles.every((role) => (role.card?.facts ?? []).length === 0)).toBe(true);
      expect(publicScenario.agenda[0]?.directions).toBeUndefined();
      expect(publicScenario.agenda[0]?.seatFacts).toBeUndefined();

      // 2. A guest joins through the meeting's own link, then reaches RTC admission.
      const guestJoin = await request(meetingPath(meeting, '/join'), 'POST', { name: 'Ada' });
      expect(guestJoin.status).toBe(200);
      const guestJoinCookie = remember(cookie(guestJoin));
      const guestResponse = await request(meetingPath(meeting, '/api/livekit/token'), 'POST',
        { participantName: 'Ada' }, { cookie: guestJoinCookie });
      expect(guestResponse.status).toBe(200);
      const guestBody = (await guestResponse.json()) as { token: string; participantRole: string };
      expect(guestBody.token).toEqual(expect.any(String));
      const guest = remember(cookie(guestResponse));
      expect((await request(meetingPath(meeting, '/api/scenario'), 'GET', undefined, { cookie: guest })).status).toBe(200);
      roster.push({ name: 'Ada', role: 'everyone' });
      const guestSocket = await socket(port, meeting.id, `role=${encodeURIComponent(guestBody.participantRole)}`, { cookie: guest });
      expect(guestSocket.ok).toBe(true);
      if (!guestSocket.ok) throw new Error('Guest socket did not open');
      sockets.push(guestSocket.ws);

      // 3. A phone joins another seat and stays connected across the host's admission.
      const phoneJoin = await request(meetingPath(meeting, '/join'), 'POST', { name: 'Bao' });
      expect(phoneJoin.status).toBe(200);
      const phoneJoinCookie = cookie(phoneJoin);
      const phoneResponse = await request(meetingPath(meeting, '/api/livekit/token'), 'POST',
        { participantName: 'Bao' }, { cookie: phoneJoinCookie });
      expect(phoneResponse.status).toBe(200);
      const phone = remember(cookie(phoneResponse));
      const phoneSeat = ((await phoneResponse.json()) as { participantRole: string }).participantRole;
      const phoneSocket = await socket(port, meeting.id, `role=${encodeURIComponent(phoneSeat)}`, { cookie: phone });
      expect(phoneSocket.ok).toBe(true);
      if (!phoneSocket.ok) throw new Error('Phone socket did not open');
      sockets.push(phoneSocket.ws);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).toBe(200);

      // 4. The owner takes the remaining seat, reads the code and starts.
      const hostAdmission = await request(meetingPath(meeting, '/api/livekit/token'), 'POST',
        { participantName: 'Demo' }, { cookie: owner.cookie });
      expect(hostAdmission.status).toBe(200);
      const host = remember(cookie(hostAdmission));
      expect((await (await request(meetingPath(meeting, '/api/meeting-code'), 'GET', undefined, { cookie: host })).json()) as { code: string }).toEqual({ code: meeting.instance.meetingCode() });
      expect((await request(meetingPath(meeting, '/api/meeting/start'), 'POST', {}, { cookie: guest })).status).toBe(403);
      expect((await request(meetingPath(meeting, '/api/meeting/start'), 'POST', {}, { cookie: host })).status).toBe(200);
      expect((await state(meeting)).started).toBe(true);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).toBe(200);
      expect(phoneSocket.ws.readyState).toBe(WebSocket.OPEN);

      // A seated guest's typed line goes straight to the server and is recorded under their name.
      guestSocket.ws.send(JSON.stringify({
        type: 'HUMAN_LINE', text: 'The chiller is down.', source: 'typed', clientLineId: 'cloud-human-1',
      }));
      const humanLine = await waitFor(
        () => guestSocket.messages.find(
          (message) => message.type === 'TRANSCRIPT_CHUNK' && message.payload.text === 'The chiller is down.',
        ),
        'the seated guest human line',
      );
      expect(humanLine).toMatchObject({ payload: { speaker: 'Ada' } });

      // 5. The runner uses the same bearer socket path and the service-only routes.
      const runner = createRunnerClient({ baseUrl: base, apiPrefix: `/api/meetings/${meeting.id}`, serviceToken });
      guestSocket.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
      await waitFor(
        () => (clock.snapshot().pauseKind === 'person' ? true : undefined),
        'the seated guest pause',
      );
      expect((await runner.fetchMeetingState()).paused).toBe(true);
      guestSocket.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
      await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the guest resume');
      const serviceSocket = await socket(port, meeting.id, 'audience=service', { token: serviceToken });
      const screenSocket = await socket(port, meeting.id, 'audience=screen', { token: serviceToken });
      expect(serviceSocket.ok).toBe(true);
      expect(screenSocket.ok).toBe(true);
      if (!serviceSocket.ok || !screenSocket.ok) throw new Error('Runner socket did not open');
      sockets.push(serviceSocket.ws, screenSocket.ws);
      screenSocket.ws.send(JSON.stringify({ type: 'SET_HOST_MODE', human: true }));
      await settle(20);
      expect(screenSocket.messages.some((message) => message.type === 'COMMAND_REJECTED')).toBe(false);
      for (const credentials of [{}, { cookie: guest }, { cookie: phone }, { cookie: host }]) {
        expect((await request(meetingPath(meeting, '/api/scenario/full'), 'GET', undefined, credentials)).status).toBe(401);
        expect((await socket(port, meeting.id, 'audience=service', credentials)).ok).toBe(false);
      }
      const event: KakiEvent = { type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() } };
      expect((await runner.emit(event)).status).toBe(200);
      await waitFor(() => guestSocket.messages.find((message) => message.type === 'TRANSCRIPT_CHUNK' && message.payload.text === 'Hello'), 'runner transcript');
      const suggestion = { title: 'Order stock', context: 'Lunch prep', suggestedAssignee: 'everyone', agendaItemTitle: 'Prep' };
      expect((await runner.suggestTask(suggestion)).status).toBe(200);
      expect(meeting.tasks.list().some((task) => task.title === 'Order stock')).toBe(true);
      await runner.postMeetingMemory([{ kind: 'decision', item: 'Prep', text: 'Order stock' }]);
      expect(meeting.memory).toEqual([{ kind: 'decision', item: 'Prep', text: 'Order stock' }]);
      await runner.postSettledTopic({ ...suggestion, title: 'Publish stock list' });
      expect(meeting.tasks.list().some((task) => task.title === 'Publish stock list')).toBe(true);
      const runnerState = await runner.fetchMeetingState();
      expect(runnerState.meetingId).toBe((await state(meeting)).meetingId);
      expect(runnerState.agendaIndex).toBe(0);
      const serviceState = await request(meetingPath(meeting, '/api/runner/meeting-state'), 'GET', undefined, { token: serviceToken });
      expect(serviceState.status).toBe(200);
      expect(await serviceState.json()).toMatchObject({ meetingId: (await state(meeting)).meetingId, started: true });
      for (const [path, body] of [
        ['/api/runner/emit', event], ['/api/runner/suggest-task', suggestion],
        ['/api/runner/meeting-memory', [{ kind: 'decision', item: 'Prep', text: 'Order stock' }]],
        ['/api/runner/settle-topic', { ...suggestion, title: 'Publish stock list' }],
      ] as const) {
        for (const credentials of [{}, { cookie: guest }, { cookie: phone }, { cookie: host }]) {
          expect((await request(meetingPath(meeting, path), 'POST', body, credentials)).status).toBe(401);
        }
      }

      // 6. New meeting from the owner's own screen rotates the room and revokes the old sessions.
      const hostScreen = await socket(port, meeting.id, 'audience=screen', { cookie: host });
      expect(hostScreen.ok).toBe(true);
      if (!hostScreen.ok) throw new Error('Host screen did not open');
      sockets.push(hostScreen.ws);
      hostScreen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
      await waitFor(
        () => (hostScreen.messages.some((message) => message.type === 'MEETING_RESET') ? true : undefined),
        'the meeting reset',
      );
      for (const ws of [guestSocket.ws, phoneSocket.ws]) {
        await waitFor(() => (ws.readyState === WebSocket.CLOSED ? true : undefined), 'the old participant socket close');
      }
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: guest })).status).not.toBe(200);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).not.toBe(200);

      // The owner opens the next meeting's lobby before the browser reads its lifecycle.
      expect((await request(meetingPath(meeting, '/api/meeting/open'), 'POST', {}, { cookie: host })).status).toBe(200);

      // The browser needs only lifecycle identity and status; runner details stay service-only.
      for (const credentials of [{}, { cookie: host }]) {
        const publicState = await request(meetingPath(meeting, '/api/meeting/state'), 'GET', undefined, credentials);
        expect(publicState.status).toBe(200);
        expect(Object.keys((await publicState.json()) as Record<string, unknown>).sort()).toEqual([
          'kind',
          'meetingId',
          'started',
        ]);
        expect((await request(meetingPath(meeting, '/api/runner/meeting-state'), 'GET', undefined, credentials)).status).toBe(401);
      }
      expect(joinLog).toHaveBeenCalled();
    });
  });
}

describe('auth-off local demo compatibility', () => {
  let app: KakiApp | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    if (app) await app.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it('permits dev routes and a tokenless local runner on a real meeting', async () => {
    vi.stubEnv('KAKI_AUTH', '0');
    vi.stubEnv('KAKI_DEV_ROUTES', '1');
    app = await createTestApp({ devRoutes: true, roomRoster: async () => [] });
    const port = portOf(app);
    const base = `http://127.0.0.1:${port}`;
    const meeting = await openRealMeeting(app, { title: 'Local demo' });
    expect((await fetch(`${base}${meetingPath(meeting, '/api/meeting/open')}`, { method: 'POST' })).status).toBe(200);
    const first = await fetch(`${base}${meetingPath(meeting, '/api/livekit/token')}`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Ada' }) });
    expect(first.status).toBe(200);
    expect((await first.json()) as { token: string }).toHaveProperty('token');
    const runner = createRunnerClient({ baseUrl: base, apiPrefix: `/api/meetings/${meeting.id}` });
    expect((await runner.emit({ type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
      payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() } })).status).toBe(200);
    const serviceSocket = await socket(port, meeting.id, 'audience=service');
    expect(serviceSocket.ok).toBe(true);
    if (serviceSocket.ok) sockets.push(serviceSocket.ws);
    const dev = await fetch(`${base}${meetingPath(meeting, '/dev/emit')}`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'Dev route', timestamp: new Date().toISOString() } }) });
    expect(dev.status).toBe(200);
  });
});

describe.skipIf(connectionString === undefined)('existing Postgres auth schema', () => {
  it('removes legacy participant sessions while preserving host sessions on upgrade', async () => {
    if (!connectionString) throw new Error('POSTGRES_URL is missing');
    const postgres = await createPostgresTestSchema(connectionString);
    const pool = postgres.pool;
    try {
      await pool.query(`create table sessions (
        token_hash text primary key, kind text not null, role text, meeting_code text,
        expires_at timestamptz not null, created_at timestamptz not null default now()
      )`);
      await pool.query(`insert into sessions (token_hash, kind, role, meeting_code, expires_at)
        values ('legacy-participant', 'participant', 'chef', 'K7M2Q9', now() + interval '1 hour'),
               ('legacy-host', 'host', null, null, now() + interval '1 hour')`);
      await ensureAuthSchema(pool);
      const rows = await pool.query<{ token_hash: string; meeting_id: string | null }>(
        'select token_hash, meeting_id from sessions order by token_hash');
      expect(rows.rows).toEqual([{ token_hash: 'legacy-host', meeting_id: null }]);
      await ensureAuthSchema(pool);
    } finally {
      await postgres.dispose();
    }
  });
});

