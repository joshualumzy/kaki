import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createWingmanModule } from '../../src/wingman/module';
import { portOf, settle, waitFor } from '../helpers';
import { testScenario } from '../fixtures/scenario';

const CODE = 'K7M2Q9';
const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'host-password';

type SocketResult = { ok: true; ws: WebSocket; messages: KakiEvent[] } | { ok: false; status: number };

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

function connect(port: number, role: string, cookie?: string, meetingId?: string): Promise<SocketResult> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const meetingQuery = meetingId === undefined ? '' : `&meeting=${encodeURIComponent(meetingId)}`;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}${meetingQuery}`,
    Object.keys(headers).length === 0 ? undefined : { headers },
  );
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  sockets.push(ws);
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ok: true, ws, messages }));
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once('error', () => resolve({ ok: false, status: 0 }));
  });
}

async function authApp(): Promise<{ app: KakiApp; port: number }> {
  const store = createMemoryAuthStore();
  await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
  const meetingCode = createMeetingCodeSource(CODE);
  const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
  const app = await createApp({
    scenario: testScenario,
    auth,
    meetingCode,
    modules: [createWingmanModule({ env: {}, askedCheckDelayMs: 0 })],
    // Every practice instance gets its own Wingman, never the legacy instance's module.
    practiceModules: () => ({ modules: [createWingmanModule({ env: {}, askedCheckDelayMs: 0 })] }),
    roomRoster: async () => [],
    speechRecognition: 'browser',
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

async function request(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const note: KakiEvent = {
  type: 'WINGMAN_NOTE',
  audience: { kind: 'role', role: 'chef' },
  payload: {
    id: 'answer:chef',
    kind: 'answer',
    urgency: 'quiet',
    title: 'Wingman',
    text: 'Ada only.',
  },
};

function notes(messages: readonly KakiEvent[]): Array<Extract<KakiEvent, { type: 'WINGMAN_NOTE' }>> {
  return messages.filter(
    (event): event is Extract<KakiEvent, { type: 'WINGMAN_NOTE' }> => event.type === 'WINGMAN_NOTE',
  );
}

describe('Wingman note delivery', () => {
  it('reaches only the participant it is for, never another seat or the owner screen', async () => {
    const { app, port } = await authApp();
    const host = cookieFrom(
      await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
    );
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const chef = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'chef' }));
    const cashier = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'cashier' }));

    const own = await connect(port, 'participant', chef);
    const other = await connect(port, 'participant', cashier);
    const screen = await connect(port, 'screen', host);
    if (!own.ok || !other.ok || !screen.ok) throw new Error('a socket did not open');

    app.hub.publish(note, { retainKey: 'wingman:chef:answer' });

    const received = await waitFor(() => notes(own.messages)[0], 'the chef note');
    await settle(50);
    expect(received.payload.text).toBe('Ada only.');
    expect(notes(other.messages)).toHaveLength(0);
    expect(notes(screen.messages)).toHaveLength(0);

    // A reload of the same person's feed replays their current notes.
    const reloaded = await connect(port, 'participant', chef);
    if (!reloaded.ok) throw new Error('the reloaded chef socket did not open');
    const replayed = await waitFor(() => notes(reloaded.messages)[0], 'the retained chef note');
    expect(replayed.payload.text).toBe('Ada only.');
  });

  it('reaches the practice screen of that seat only', async () => {
    const { app, port } = await authApp();
    const created = await request(port, '/api/practice', 'POST');
    const practiceCookie = cookieFrom(created);
    const { meetingId } = (await created.json()) as { meetingId: string };
    const practice = await request(
      port,
      `/api/meetings/${meetingId}/livekit/token`,
      'POST',
      { participantName: 'Ada', participantRole: 'chef', kind: 'practice' },
      practiceCookie,
    );
    expect(practice.status).toBe(200);
    const instance = app.registry.findPractice(meetingId);
    if (instance === undefined) throw new Error('the practice meeting did not load');

    const practiceScreen = await connect(port, 'screen', practiceCookie, meetingId);
    if (!practiceScreen.ok) throw new Error('the practice screen did not open');

    instance.hub.publish(note, { retainKey: 'wingman:practice:chef' });

    const received = await waitFor(() => notes(practiceScreen.messages)[0], 'the practice note');
    expect(received.payload.text).toBe('Ada only.');

    // The practice screen can also ask its own Wingman; the role comes from its practice seat.
    practiceScreen.ws.send(JSON.stringify({ type: 'ASK_WINGMAN', question: 'What did I miss?' }));
    const answer = await waitFor(
      () =>
        notes(practiceScreen.messages).find(
          (event) => event.payload.kind === 'answer' && event.payload.questionText === 'What did I miss?',
        ),
      'the practice answer',
    );
    expect(answer.payload.text).toBe('Nothing on that in this meeting or your workspace.');
  });
});
