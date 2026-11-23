import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Scenario } from '@kaki/shared';
import { loadScenario } from '../src/core/loadScenario';
import { createApp, type KakiApp } from '../src/app';
import { portOf } from './helpers';

const pack: Scenario = await loadScenario('kopitiam');
const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
});

async function appWith(
  options: { maxPracticeMeetings?: number; devRoutes?: boolean } = {},
): Promise<{ app: KakiApp; port: number }> {
  const app = await createApp({
    speechRecognition: 'browser',
    scenario: pack,
    roomRoster: async () => [],
    rejoinGraceMs: 60_000,
    ...(options.maxPracticeMeetings === undefined ? {} : { maxPracticeMeetings: options.maxPracticeMeetings }),
    ...(options.devRoutes === undefined ? {} : { devRoutes: options.devRoutes }),
  });
  apps.push(app);
  return { app, port: portOf(app) };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (value === undefined || value === '') throw new Error('Expected a cookie');
  return value;
}

async function post(port: number, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie !== undefined) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function startPractice(port: number): Promise<{ meetingId: string; cookie: string }> {
  const response = await post(port, '/api/practice');
  expect(response.status).toBe(200);
  const body = (await response.json()) as { meetingId: string };
  return { meetingId: body.meetingId, cookie: cookieFrom(response) };
}

/** The AI runner connection a practice Start waits for; it acknowledges every prepare. */
function connectService(port: number, meetingId: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meetingId)}&role=service`);
  sockets.push(socket);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      kind?: string;
      request?: { requestId?: string; attempt?: string; meetingId?: string };
    };
    const { requestId, attempt, meetingId: named } = message.request ?? {};
    if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || named === undefined) return;
    socket.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId: named }));
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

describe('POST /api/practice', () => {
  it('creates one practice meeting and sets an HttpOnly cookie naming it', async () => {
    const { port } = await appWith();
    const response = await post(port, '/api/practice');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { meetingId: string };
    expect(body.meetingId).not.toBe('');
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain(`kaki_practice=${body.meetingId}.`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');

    const state = await fetch(`http://127.0.0.1:${port}/api/meetings/${body.meetingId}/meeting/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ meetingId: body.meetingId, kind: 'practice', started: false });
  });

  it('returns the same meeting for a refresh and a second tab', async () => {
    const { port } = await appWith();
    const first = await startPractice(port);
    const again = await post(port, '/api/practice', undefined, first.cookie);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { meetingId: string }).meetingId).toBe(first.meetingId);
  });

  it('gives a fresh practice for a malformed cookie instead of a 500', async () => {
    const { port } = await appWith();
    const first = await startPractice(port);
    for (const cookie of ['kaki_practice=garbage', 'kaki_practice=.nope', 'kaki_practice=nope.']) {
      const response = await post(port, '/api/practice', undefined, cookie);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { meetingId: string }).meetingId).not.toBe(first.meetingId);
    }
  });

  it('refuses a cookie that names a practice with the wrong capability', async () => {
    const { port } = await appWith();
    const first = await startPractice(port);
    const forged = `kaki_practice=${first.meetingId}.not-the-capability`;
    const response = await post(port, '/api/practice', undefined, forged);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('practice-access');
  });

  it('shows the plain practice-full message when every practice room is in use', async () => {
    const { app, port } = await appWith({ maxPracticeMeetings: 1 });
    const first = await startPractice(port);
    expect(app.registry.findPractice(first.meetingId)).toBeDefined();
    const second = await post(port, '/api/practice');
    expect(second.status).toBe(503);
    const body = (await second.json()) as { error: string; message: string };
    expect(body.error).toBe('practice-full');
    expect(body.message).toBe('All practice rooms are in use right now. Please try again in a few minutes.');
  });

  it('keeps two visitors in their own practice meetings', async () => {
    const { app, port } = await appWith();
    const alice = await startPractice(port);
    const ben = await startPractice(port);
    expect(alice.meetingId).not.toBe(ben.meetingId);

    // A practice capability only opens its own meeting's start.
    const foreign = await post(port, `/api/meetings/${ben.meetingId}/meeting/start`, undefined, alice.cookie);
    expect(foreign.status).not.toBe(200);
    expect(app.registry.findPractice(alice.meetingId)).not.toBe(app.registry.findPractice(ben.meetingId));
  });

  it('gives a fresh practice after the old one has ended', async () => {
    const { app, port } = await appWith();
    const first = await startPractice(port);
    await connectService(port, first.meetingId);

    const joined = await post(
      port,
      `/api/meetings/${first.meetingId}/livekit/token`,
      { participantName: 'Alice', participantRole: 'operations_director', kind: 'practice' },
      first.cookie,
    );
    expect(joined.status).toBe(200);
    const started = await post(port, `/api/meetings/${first.meetingId}/meeting/start`, undefined, first.cookie);
    expect(started.status).toBe(200);

    const instance = app.registry.findPractice(first.meetingId);
    instance?.session.end();
    expect(instance?.session.phase()).toBe('ended');

    const next = await post(port, '/api/practice', undefined, first.cookie);
    expect(next.status).toBe(200);
    const nextId = ((await next.json()) as { meetingId: string }).meetingId;
    expect(nextId).not.toBe(first.meetingId);
    // The reply replaces the ended practice's cookie with one naming the new meeting.
    const nextCookie = cookieFrom(next);
    expect(nextCookie).toContain(`kaki_practice=${nextId}.`);
    expect(nextCookie).not.toBe(first.cookie);
    expect(app.registry.findPractice(nextId)).toBeDefined();
  });

  it('frees an ended practice’s share of the practice cap at once', async () => {
    const { app, port } = await appWith({ maxPracticeMeetings: 1 });
    const first = await startPractice(port);
    await connectService(port, first.meetingId);
    const joined = await post(
      port,
      `/api/meetings/${first.meetingId}/livekit/token`,
      { participantName: 'Alice', participantRole: 'operations_director', kind: 'practice' },
      first.cookie,
    );
    expect(joined.status).toBe(200);
    expect((await post(port, `/api/meetings/${first.meetingId}/meeting/start`, undefined, first.cookie)).status).toBe(200);

    const instance = app.registry.findPractice(first.meetingId);
    instance?.session.end();
    expect(instance?.session.phase()).toBe('ended');

    const next = await post(port, '/api/practice', undefined, first.cookie);
    expect(next.status).toBe(200);
    const nextId = ((await next.json()) as { meetingId: string }).meetingId;
    expect(nextId).not.toBe(first.meetingId);
    // The ended practice is still loaded for anyone still in its room.
    expect(app.registry.findPractice(first.meetingId)).toBe(instance);
  });

  it('gives a fresh practice when the cookie names a practice that has been unloaded', async () => {
    const { app, port } = await appWith();
    const first = await startPractice(port);
    await app.registry.unload(first.meetingId);
    expect(app.registry.findPractice(first.meetingId)).toBeUndefined();

    const next = await post(port, '/api/practice', undefined, first.cookie);
    expect(next.status).toBe(200);
    const nextId = ((await next.json()) as { meetingId: string }).meetingId;
    expect(nextId).not.toBe(first.meetingId);
    expect(cookieFrom(next)).toContain(`kaki_practice=${nextId}.`);
    expect(app.registry.findPractice(nextId)).toBeDefined();
  });

  it('runs a practice instance with the practice pack on its own prefixed room, and never a real one', async () => {
    const { app, port } = await appWith();
    const practice = await startPractice(port);
    const practiceInstance = app.registry.findPractice(practice.meetingId);
    expect(practiceInstance?.runnerKind).toBe('practice');
    expect(practiceInstance?.perVisitorPractice).toBe(true);
    expect(practiceInstance?.session.kind()).toBe('practice');
    expect(practiceInstance?.roomName).toContain(practice.meetingId);

    const row = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      title: 'Team meeting',
    });
    const realInstance = await app.registry.get(row.id);
    expect(realInstance?.runnerKind).toBe('real');
    expect(realInstance?.perVisitorPractice).toBe(false);
    expect(realInstance?.session.kind()).toBe('real');
    expect(realInstance?.roomName).toBe(`kaki-${row.id}`);
  });

  it('answers the dev routes under the practice meeting id', async () => {
    const { port } = await appWith({ devRoutes: true });
    const practice = await startPractice(port);
    const response = await post(port, `/api/meetings/${practice.meetingId}/dev/emit`, {
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: 'Ada', text: 'Good morning', timestamp: new Date().toISOString() },
    });
    expect(response.status).toBe(200);
  });

  it('needs the practice cookie to join one visitor’s practice', async () => {
    const { port } = await appWith();
    const first = await startPractice(port);
    const noCookie = await post(port, `/api/meetings/${first.meetingId}/livekit/token`, {
      participantName: 'Mallory',
      participantRole: 'operations_director',
      kind: 'practice',
    });
    expect(noCookie.status).toBe(403);
  });
});
