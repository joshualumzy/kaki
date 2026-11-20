import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { parseScenario, type KakiEvent, type Scenario } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword, hashToken } from '../../src/auth/password';
import { createPostgresAuthStore } from '../../src/auth/postgres';
import { ensureAuthSchema } from '../../src/auth/schema';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import type { MeetingPauseControl } from '../../src/host';
import { createAgendaClock } from '../../src/host/clock';
import { createMeetingModule } from '../../src/host/meeting';
import { createMeetingCodeSource } from '../../src/meetingCode';
import { createRunnerClient } from '../../src/npc/runnerClient';
import { testScenario } from '../fixtures/scenario';
import { portOf, settle, waitFor } from '../helpers';

const code = 'K7M2Q9';
const serviceToken = 'local-test-runner-token';
const password = 'correct-horse-battery';
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
    { name: 'Mia', role: 'manager', zoomDisplayName: 'Mia (Manager)' },
  ],
  agenda: [{ ...testScenario.agenda[0]!, directions: ['private direction'], seatFacts: {
    chef: 'chef agenda secret', cashier: 'cashier agenda secret', manager: 'manager agenda secret',
  } }],
};

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie');
  return value;
}

async function socket(port: number, role: string, credentials: { cookie?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (credentials.cookie) headers.cookie = credentials.cookie;
  if (credentials.token) headers.authorization = `Bearer ${credentials.token}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`, { headers });
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
    let bootstrap: Pool | undefined;
    let schema: string | undefined;
    let pool: Pool | undefined;
    let meetingId: string | undefined;
    const sessionHashes: string[] = [];
    const sockets: WebSocket[] = [];

    afterEach(async () => {
      for (const ws of sockets.splice(0)) ws.terminate();
      if (pool && meetingId) {
        // App.close closes the auth store's pool; remove only this test's rows first.
        await pool.query('delete from seat_claims where meeting_id = $1', [meetingId]);
        await pool.query('delete from sessions where token_hash = any($1)', [sessionHashes]);
      }
      if (app) await app.close();
      if (bootstrap && schema) await bootstrap.query(`drop schema "${schema}" cascade`);
      if (bootstrap) await bootstrap.end();
      app = undefined;
      pool = undefined;
      bootstrap = undefined;
      schema = undefined;
      meetingId = undefined;
      sessionHashes.length = 0;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('admits guests before the host, protects runner traffic, and revokes the old meeting', async () => {
      vi.stubEnv('KAKI_AUTH', '1');
      // The meeting module is here for its one pause owner; this check creates its follow-up cards
      // explicitly, so Sam must not auto-dispatch the earlier suggestion behind its back.
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
        schema = `cloud_flow_${randomUUID().replaceAll('-', '')}`;
        bootstrap = new Pool({ connectionString });
        await bootstrap.query(`create schema "${schema}"`);
        pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
        await ensureAuthSchema(pool);
        store = createPostgresAuthStore(pool);
      } else {
        store = createMemoryAuthStore();
      }
      await store.createUser({ email: 'demo', passwordHash: await hashPassword(password) });
      const meetingCode = createMeetingCodeSource(code);
      const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier', 'manager'], meetingCode, secureCookies: true });
      let roster: Array<{ name: string; role: string }> = [];
      const clock = createAgendaClock({ agenda: scenario.agenda });
      const pause: MeetingPauseControl = {
        paused: () => (clock.snapshot().started ? clock.snapshot().paused === true : undefined),
        kind: () => clock.snapshot().pauseKind,
        pause: (kind) => clock.pause(kind),
        resume: () => clock.resume(),
      };
      app = await createApp({ scenario: structuredClone(scenario), auth, meetingCode, serviceToken,
        modules: [createMeetingModule({ clock, notetakerIntervalMs: 60_000 })],
        roomRoster: async () => roster, rejoinGraceMs: 25, rejoinPollMs: 5, admissionReservationMs: 5,
        meetingAgendaIndex: () => (clock.snapshot().started ? clock.snapshot().agendaIndex : undefined),
        meetingPaused: pause.paused,
        meetingPause: pause });
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
      const remember = (value: string) => {
        sessionHashes.push(hashToken(decodeURIComponent(value.slice(value.indexOf('=') + 1))));
        return value;
      };
      const state = async () => (await (await request('/api/meeting/state')).json()) as { meetingId: string; started: boolean };
      meetingId = (await state()).meetingId;

      // 1. Anonymous readers get a parser-valid public projection.
      const publicScenario = parseScenario(await (await request('/api/scenario')).json());
      expect(publicScenario.roles.map((role) => role.card?.facts ?? [])).toEqual([[], [], []]);
      expect(publicScenario.agenda[0]?.directions).toBeUndefined();
      expect(publicScenario.agenda[0]?.seatFacts).toBeUndefined();

      // 2. The code holder reaches RTC admission before the host exists.
      const guestResponse = await request('/api/livekit/token', 'POST',
        { participantName: 'Ada', participantRole: 'chef', meetingCode: code });
      const joinLines = joinLog.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[join]'));
      expect(joinLines.some((line) => line.includes('seat=chef'))).toBe(true);
      expect(joinLines.some((line) => line.includes('Ada'))).toBe(false);
      expect(guestResponse.status).toBe(200);
      expect((await guestResponse.json()) as { token: string }).toHaveProperty('token');
      const guest = remember(cookie(guestResponse));
      const guestView = parseScenario(await (await request('/api/scenario', 'GET', undefined, { cookie: guest })).json());
      expect(guestView.roles.map((role) => role.card?.facts ?? [])).toEqual([['chef secret'], [], []]);
      expect(guestView.agenda[0]?.seatFacts).toEqual({ chef: 'chef agenda secret' });
      roster = [{ name: 'Ada', role: 'chef' }];
      const guestSocket = await socket(port, 'chef', { cookie: guest });
      expect(guestSocket.ok).toBe(true);
      if (!guestSocket.ok) throw new Error('Guest socket did not open');
      sockets.push(guestSocket.ws);

      // 3. A phone joins another seat and stays connected across the host's admission.
      const phoneResponse = await request('/api/join', 'POST', { code, role: 'cashier' });
      expect(phoneResponse.status).toBe(200);
      const phone = remember(cookie(phoneResponse));
      const phoneView = parseScenario(await (await request('/api/scenario', 'GET', undefined, { cookie: phone })).json());
      expect(phoneView.roles.map((role) => role.card?.facts ?? [])).toEqual([[], ['cashier secret'], []]);
      const phoneSocket = await socket(port, 'cashier', { cookie: phone });
      expect(phoneSocket.ok).toBe(true);
      if (!phoneSocket.ok) throw new Error('Phone socket did not open');
      sockets.push(phoneSocket.ws);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).toBe(200);

      // 4. The owner signs in as demo, takes the remaining seat, reads the code and starts.
      const login = await request('/api/auth/login', 'POST', { email: 'demo', password });
      expect(login.status).toBe(200);
      let host = remember(cookie(login));
      expect(login.headers.get('set-cookie')).toContain('Secure');
      const hostAdmission = await request('/api/livekit/token', 'POST',
        { participantName: 'Mia', participantRole: 'manager' }, { cookie: host });
      expect(hostAdmission.status).toBe(200);
      host = remember(cookie(hostAdmission));
      roster.push({ name: 'Mia', role: 'manager' });
      const hostView = parseScenario(await (await request('/api/scenario', 'GET', undefined, { cookie: host })).json());
      expect(hostView.roles.map((role) => role.card?.facts ?? [])).toEqual([[], [], ['manager secret']]);
      expect((await (await request('/api/meeting-code', 'GET', undefined, { cookie: host })).json()) as { code: string }).toEqual({ code });
      expect((await request('/api/meeting/start', 'POST', {}, { cookie: guest })).status).toBe(403);
      expect((await request('/api/meeting/start', 'POST', {}, { cookie: host })).status).toBe(200);
      expect((await state()).started).toBe(true);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).toBe(200);
      expect(phoneSocket.ws.readyState).toBe(WebSocket.OPEN);

      // 5. Use the actual client from npc/main against the app and the same bearer socket path.
      const runner = createRunnerClient({ baseUrl: base, serviceToken });
      // A seated person's Stop goes straight from their browser socket to the server; the runner
      // is not involved, and the shared runner snapshot shows the pause.
      guestSocket.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: true }));
      await waitFor(
        () => (clock.snapshot().pauseKind === 'person' ? true : undefined),
        'the seated guest pause',
      );
      expect((await runner.fetchMeetingState()).paused).toBe(true);
      guestSocket.ws.send(JSON.stringify({ type: 'SET_PAUSED', paused: false }));
      await waitFor(() => (clock.snapshot().paused === false ? true : undefined), 'the guest resume');
      const serviceSocket = await socket(port, 'service', { token: serviceToken });
      const screenSocket = await socket(port, 'screen', { token: serviceToken });
      expect(serviceSocket.ok).toBe(true);
      expect(screenSocket.ok).toBe(true);
      if (!serviceSocket.ok || !screenSocket.ok) throw new Error('Runner socket did not open');
      sockets.push(serviceSocket.ws, screenSocket.ws);
      screenSocket.ws.send(JSON.stringify({ type: 'SET_HOST_MODE', human: true }));
      await settle(20);
      expect(screenSocket.messages.some((message) => message.type === 'COMMAND_REJECTED')).toBe(false);
      for (const credentials of [{}, { cookie: guest }, { cookie: phone }, { cookie: host }]) {
        expect((await request('/api/scenario/full', 'GET', undefined, credentials)).status).toBe(401);
        expect((await socket(port, 'service', credentials)).ok).toBe(false);
      }
      const event: KakiEvent = { type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() } };
      expect((await runner.emit(event)).status).toBe(200);
      await waitFor(() => guestSocket.messages.find((message) => message.type === 'TRANSCRIPT_CHUNK'), 'runner transcript');
      const suggestion = { title: 'Order stock', context: 'Lunch prep', suggestedAssignee: 'chef' as const,
        agendaItemTitle: 'Prep' };
      expect((await runner.suggestTask(suggestion)).status).toBe(200);
      expect(app.tasks.list().some((task) => task.title === 'Order stock')).toBe(true);
      await runner.postMeetingMemory([{ kind: 'decision', item: 'Prep', text: 'Order stock' }]);
      expect(app.memory).toEqual([{ kind: 'decision', item: 'Prep', text: 'Order stock' }]);
      await runner.postSettledTopic({ ...suggestion, title: 'Publish stock list' });
      expect(app.tasks.list().some((task) => task.title === 'Publish stock list')).toBe(true);
      expect((await runner.fetchScenario()).roles[0]?.card?.facts).toEqual(['chef secret']);
      const runnerState = await runner.fetchMeetingState();
      expect(runnerState.meetingId).toBe((await state()).meetingId);
      expect(runnerState.agendaIndex).toBe(0);
      const serviceState = await request('/api/runner/meeting-state', 'GET', undefined, { token: serviceToken });
      expect(serviceState.status).toBe(200);
      expect(await serviceState.json()).toMatchObject({ meetingId: (await state()).meetingId, started: true });
      for (const [path, body] of [
        ['/api/runner/emit', event], ['/api/runner/suggest-task', suggestion],
        ['/api/runner/meeting-memory', [{ kind: 'decision', item: 'Prep', text: 'Order stock' }]],
        ['/api/runner/settle-topic', { ...suggestion, title: 'Publish stock list' }],
      ] as const) {
        for (const credentials of [{}, { cookie: guest }, { cookie: phone }, { cookie: host }]) {
          expect((await request(path, 'POST', body, credentials)).status).toBe(401);
        }
      }

      // 6. After the grace, a guest cannot reset, but the host can. Old sessions lose authority.
      roster = [];
      await settle(90);
      const beforeRestart = await state();
      const blocked = await request('/api/livekit/token', 'POST',
        { participantName: 'Ada', participantRole: 'chef', meetingCode: code }, { cookie: guest });
      expect(blocked.status).toBe(409);
      expect(await state()).toEqual(beforeRestart);
      const restart = await request('/api/livekit/token', 'POST',
        { participantName: 'Mia', participantRole: 'manager' }, { cookie: host });
      expect(restart.status).toBe(200);
      host = remember(cookie(restart));
      const nextMeeting = await state();
      expect(nextMeeting.meetingId).not.toBe(beforeRestart.meetingId);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: guest })).status).not.toBe(200);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: phone })).status).not.toBe(200);
      expect((await socket(port, 'chef', { cookie: guest })).ok).toBe(false);
      expect((await socket(port, 'cashier', { cookie: phone })).ok).toBe(false);
      expect((await request('/api/meeting/start', 'POST', {}, { cookie: guest })).status).not.toBe(200);
      expect((await request('/api/meeting/start', 'POST', {}, { cookie: phone })).status).not.toBe(200);
      await waitFor(() => guestSocket.ws.readyState === WebSocket.CLOSED ? true : undefined, 'old guest socket close');
      await waitFor(() => phoneSocket.ws.readyState === WebSocket.CLOSED ? true : undefined, 'old phone socket close');

      // 7. Signing in again transfers the host's active seat to the new cookie.
      const relogin = await request('/api/auth/login', 'POST', { email: 'demo', password }, { cookie: host });
      expect(relogin.status).toBe(200);
      const newHost = remember(cookie(relogin));
      const newView = parseScenario(await (await request('/api/scenario', 'GET', undefined, { cookie: newHost })).json());
      expect(newView.roles.find((role) => role.id === 'manager')?.card?.facts).toEqual(['manager secret']);
      expect((await request('/api/auth/me', 'GET', undefined, { cookie: host })).status).toBe(401);

      // The browser needs only lifecycle identity and status; runner details stay service-only.
      for (const credentials of [{}, { cookie: guest }, { cookie: phone }, { cookie: newHost }]) {
        const publicState = await request('/api/meeting/state', 'GET', undefined, credentials);
        expect(publicState.status).toBe(200);
        expect(Object.keys((await publicState.json()) as Record<string, unknown>).sort()).toEqual(['meetingId', 'started']);
        expect((await request('/api/runner/meeting-state', 'GET', undefined, credentials)).status).toBe(401);
      }
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

  it('shows the first arrival the code and permits dev routes and a tokenless local runner', async () => {
    vi.stubEnv('KAKI_AUTH', '0');
    vi.stubEnv('KAKI_DEV_ROUTES', '1');
    const meetingCode = createMeetingCodeSource(code);
    app = await createApp({ scenario: structuredClone(testScenario), meetingCode, devRoutes: true,
      roomRoster: async () => [] });
    const port = portOf(app);
    const base = `http://127.0.0.1:${port}`;
    const first = await fetch(`${base}/api/livekit/token`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Ada', participantRole: 'chef' }) });
    expect(first.status).toBe(200);
    expect((await first.json()) as { meetingCode: string }).toHaveProperty('meetingCode', code);
    const runner = createRunnerClient({ baseUrl: base });
    expect((await runner.emit({ type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
      payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() } })).status).toBe(200);
    const serviceSocket = await socket(port, 'service');
    expect(serviceSocket.ok).toBe(true);
    if (serviceSocket.ok) sockets.push(serviceSocket.ws);
    const dev = await fetch(`${base}/dev/emit`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'TRANSCRIPT_CHUNK', audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'Dev route', timestamp: new Date().toISOString() } }) });
    expect(dev.status).toBe(200);
  });
});

describe.skipIf(connectionString === undefined)('existing Postgres auth schema', () => {
  it('removes legacy participant sessions while preserving host sessions on upgrade', async () => {
    if (!connectionString) throw new Error('POSTGRES_URL is missing');
    const bootstrap = new Pool({ connectionString });
    const schema = `cloud_migration_${randomUUID().replaceAll('-', '')}`;
    await bootstrap.query(`create schema "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
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
      await pool.end();
      await bootstrap.query(`drop schema "${schema}" cascade`);
      await bootstrap.end();
    }
  });
});
