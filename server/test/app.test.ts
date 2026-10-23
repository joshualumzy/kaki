import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import { loadScenario } from '../src/loadScenario';
import { createTestApp, connectClient, portOf, settle, type TestClient } from './helpers';
import { testScenario } from './fixtures/scenario';

function closeInfoFor(url: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}

const opening = {
  type: 'HOST_SPEECH_TRIGGERED',
  audience: { kind: 'screen' },
  payload: { kind: 'OPENING', text: 'Welcome to lunch service.' },
};

describe('app', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let port: number;
  let clients: TestClient[];

  beforeEach(async () => {
    app = await createTestApp();
    port = portOf(app);
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await app.close();
  });

  async function connect(role: string): Promise<TestClient> {
    const client = await connectClient(port, role);
    clients.push(client);
    return client;
  }

  it('closes sockets with 1008 for an unknown or missing role', async () => {
    const unknown = await closeInfoFor(`ws://127.0.0.1:${port}/ws?role=waiter`);
    expect(unknown.code).toBe(1008);
    expect(unknown.reason).toContain('Unknown role');

    const missing = await closeInfoFor(`ws://127.0.0.1:${port}/ws`);
    expect(missing.code).toBe(1008);
    expect(missing.reason).toContain('Missing role');
  });

  it('accepts scenario roles and the screen', async () => {
    const chef = await connect('chef');
    const screen = await connect('screen');

    app.hub.publish({
      type: 'NUDGE',
      audience: { kind: 'role', role: 'chef' },
      payload: { text: 'Prep starts now.' },
    });
    await settle();

    expect(chef.messages.some((event) => event.type === 'NUDGE')).toBe(true);
    expect(screen.messages).toEqual([]);
  });

  it('serves the health check and the active scenario', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const scenario = await fetch(`http://127.0.0.1:${port}/api/scenario`);
    expect(scenario.status).toBe(200);
    expect(await scenario.json()).toEqual(testScenario);
  });

  it('accepts a valid dev event and delivers it', async () => {
    const screen = await connect('screen');

    const response = await fetch(`http://127.0.0.1:${port}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opening),
    });

    expect(response.status).toBe(200);
    await settle();
    expect(screen.messages).toEqual([opening]);
  });

  it('rejects an invalid dev event or malformed JSON with 400', async () => {
    const screen = await connect('screen');
    const invalid = { type: 'NUDGE', audience: { kind: 'role', role: 'waiter' }, payload: { text: 'x' } };

    const rejected = await fetch(`http://127.0.0.1:${port}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    expect(rejected.status).toBe(400);

    const malformed = await fetch(`http://127.0.0.1:${port}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);

    await settle();
    expect(screen.messages).toEqual([]);
  });

  it('suggests a task through the dev endpoint', async () => {
    const screen = await connect('screen');

    const response = await fetch(`http://127.0.0.1:${port}/dev/suggest-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Fix the oven',
        context: 'It trips the fuse.',
        suggestedAssignee: 'chef',
        actionKind: 'gitea_issue',
      }),
    });

    expect(response.status).toBe(200);
    const task = (await response.json()) as { id: string; status: string };
    expect(task.status).toBe('SUGGESTED');
    await settle();
    expect(screen.messages.some((event) => event.type === 'TASK_UPDATED')).toBe(true);
  });

  it('returns 404 for dev endpoints in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const productionApp = await createTestApp();
    try {
      const productionPort = portOf(productionApp);
      const emit = await fetch(`http://127.0.0.1:${productionPort}/dev/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opening),
      });
      expect(emit.status).toBe(404);

      const suggest = await fetch(`http://127.0.0.1:${productionPort}/dev/suggest-task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Fix the oven',
          context: 'It trips the fuse.',
          suggestedAssignee: 'chef',
        }),
      });
      expect(suggest.status).toBe(404);
    } finally {
      await productionApp.close();
      process.env.NODE_ENV = previous;
    }
  });

  it('rejects createApp when a module fails to start, naming the module', async () => {
    await expect(
      createApp({
        scenario: testScenario,
        modules: [
          {
            name: 'broken-module',
            start() {
              throw new Error('boom');
            },
          },
        ],
      }),
    ).rejects.toThrow(/broken-module/);
  });

  it('loads the shipped pixel-kampung scenario', async () => {
    const scenario = await loadScenario('pixel-kampung');
    expect(scenario.id).toBe('pixel-kampung');
    expect(scenario.roles.map((role) => role.id)).toEqual([
      'producer',
      'lead_programmer',
      'game_designer',
      'marketing_lead',
    ]);
    expect(scenario.agenda).toHaveLength(4);
  });
});
