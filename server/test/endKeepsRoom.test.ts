import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createMeetingModule } from '../src/host/meeting';
import { createFakeLlm } from '../src/llm';
import { portOf, waitFor } from './helpers';
import { testScenario } from './fixtures/scenario';

const removals = vi.hoisted(() => [] as string[]);

vi.mock('../src/livekit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/livekit')>()),
  removeRoomHumans: async (roomName: string) => {
    removals.push(roomName);
  },
}));

const apps: KakiApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of apps.splice(0)) await app.close();
  removals.splice(0);
  vi.restoreAllMocks();
});

function connect(port: number, role: string): Promise<{ ws: WebSocket; messages: KakiEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`);
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as KakiEvent));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

describe('ending a meeting keeps its room', () => {
  it('does not remove the people who stay to review and publish the minutes', async () => {
    const app = await createApp({
      scenario: testScenario,
      modules: [createMeetingModule({ llm: createFakeLlm(() => '{}'), notetakerIntervalMs: 60_000 })],
      roomRoster: async () => [],
      speechRecognition: 'browser',
      rejoinGraceMs: 60_000,
    });
    apps.push(app);
    const port = portOf(app);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/open`, { method: 'POST' })).status).toBe(200);
    const joined = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Ada', participantRole: 'chef' }),
    });
    expect(joined.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the meeting to run');
    // Opening and taking the first seat clear the old lobby; only what END does now matters.
    removals.splice(0);

    const screen = await connect(port, 'screen');
    sockets.push(screen.ws);
    screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
    await waitFor(() => (app.session.phase() === 'ended' ? true : undefined), 'the meeting to end');

    expect(app.session.holders()).toHaveLength(1);
    expect(removals).toEqual([]);

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitFor(() => (app.session.phase() === 'lobby' ? true : undefined), 'the reset');
    expect(removals).toHaveLength(1);
  });

  it('removes the practice visitor from the practice room when the practice meeting ends', async () => {
    const app = await createApp({
      scenario: testScenario,
      roomRoster: async () => [],
      speechRecognition: 'browser',
      rejoinGraceMs: 60_000,
    });
    apps.push(app);
    const port = portOf(app);
    const joined = await fetch(`http://127.0.0.1:${port}/api/livekit/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantName: 'Ada', participantRole: 'chef', kind: 'practice' }),
    });
    expect(joined.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/meeting/start`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => (app.session.phase() === 'running' ? true : undefined), 'the practice meeting to run');
    removals.splice(0);

    app.session.end();

    await waitFor(() => (removals.length > 0 ? true : undefined), 'the practice room removal');
    expect(removals).toHaveLength(1);
  });
});
