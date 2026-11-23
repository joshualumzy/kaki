import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
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
});

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

function connectPage(port: number, audiences: readonly string[], cookie: string): Promise<SocketResult> {
  const query = new URLSearchParams();
  for (const audience of audiences) query.append('audiences', audience);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query.toString()}`, {
    headers: { cookie },
  });
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

describe('a page multiplexes its feeds over one socket', () => {
  it('delivers the projection and its own role feed once each, and commands act as the named feed', async () => {
    const { app, port } = await authApp();
    const host = cookieFrom(
      await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
    );
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const chef = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'chef' }));

    app.hub.publish(
      {
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'screen' },
        payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 1, speakerTalkSeconds: {} },
      },
      { retainKey: 'record' },
    );
    app.hub.publish(
      {
        type: 'WINGMAN_NOTE',
        audience: { kind: 'role', role: 'chef' },
        payload: { id: 'own-note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'OWN NOTE' },
      },
      { retainKey: 'note:chef' },
    );

    const page = await connectPage(port, ['participant', 'role:chef'], chef);
    if (!page.ok) throw new Error(`page socket did not open (${page.status})`);

    await waitFor(
      () => page.messages.some((event) => event.type === 'WINGMAN_NOTE') ? true : undefined,
      'the retained role note',
    );
    await settle(50);

    expect(
      page.messages.some((event) => event.type === 'MEETING_RECORD_UPDATED'),
    ).toBe(true);
    // The note is visible to both feeds on this socket, but it must arrive once.
    expect(
      page.messages.filter(
        (event) => event.type === 'WINGMAN_NOTE' && event.payload.text === 'OWN NOTE',
      ),
    ).toHaveLength(1);

    // A command names the feed it acts as: a role command must reach the task store as the seat.
    page.ws.send(
      JSON.stringify({
        type: 'MULTIPLEX_COMMAND',
        audience: { kind: 'role', role: 'chef' },
        command: { type: 'CLAIM_TASK', taskId: 'missing', mode: 'MANUAL' },
      }),
    );
    const rejection = await waitFor(
      () =>
        page.messages.find(
          (event) => event.type === 'COMMAND_REJECTED' && event.payload.commandType === 'CLAIM_TASK',
        ),
      'the role command rejection',
    );
    expect(rejection).toMatchObject({ audience: { kind: 'role', role: 'chef' } });
  });
});
