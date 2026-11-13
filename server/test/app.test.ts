import { createServer, request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import { CommandError } from '../src/hub';
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
    app = await createTestApp({ devRoutes: true });
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

  it('closes an over-long unknown role without crashing the server', async () => {
    const role = '€'.repeat(80);
    const unknown = await closeInfoFor(
      `ws://127.0.0.1:${port}/ws?role=${encodeURIComponent(role)}`,
    );
    expect(unknown.code).toBe(1008);
    expect(unknown.reason).toBe('Unknown role');

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
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

  it('does not serve a dev route reached through a dot-segment path', async () => {
    const screen = await connect('screen');
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/../dev/emit', headers: { 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(opening));
    });
    expect(status).toBe(404);

    await settle();
    expect(screen.messages).toEqual([]);
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

  it('replays an identical dev event only once to a late client', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/dev/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opening),
      });
      expect(response.status).toBe(200);
    }

    const screen = await connect('screen');
    await settle();
    expect(screen.messages).toEqual([opening]);
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

  it('settlement reuses a held follow-up card for the same role, kind and topic', async () => {
    const { installAutoDispatch } = await import('../src/host/autoDispatch');
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario, holdUntilSettled: true });
    try {
      const early = app.tasks.suggest({ title: 'Tell the team what we decided', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep' });
      const response = await fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
          suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' }),
      });
      expect(response.status).toBe(200);
      const settled = (await response.json()) as { id: string };
      expect(settled.id).toBe(early.id);
      expect(app.tasks.list()).toHaveLength(1);
      expect(app.tasks.get(early.id)).toMatchObject({ status: 'DISPATCHED', title: 'Post the prep plan',
        context: 'Visitor decision: use fresh stock', decisionSource: 'use fresh stock' });
    } finally { release(); }
  });

  it('settles a held card whose decision is worded exactly like the settlement', async () => {
    const { installAutoDispatch } = await import('../src/host/autoDispatch');
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario, holdUntilSettled: true });
    try {
      const screen = await connect('screen');
      const early = app.tasks.suggest({ title: 'Post the prep plan', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep',
        decisionSource: 'use fresh stock' });
      const response = await fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
          suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep',
          decisionSource: 'use fresh stock' }),
      });
      expect(response.status).toBe(200);
      const settled = (await response.json()) as { id: string };
      expect(settled.id).toBe(early.id);
      expect(app.tasks.list()).toHaveLength(1);
      expect(app.tasks.get(early.id)?.status).toBe('DISPATCHED');
      await settle();
      expect(screen.messages.some((event) => event.type === 'TOPIC_SETTLED')).toBe(true);
    } finally { release(); }
  });

  it('returns the same follow-up when a settlement POST is retried', async () => {
    const { installAutoDispatch } = await import('../src/host/autoDispatch');
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: testScenario, holdUntilSettled: true });
    try {
      const body = { title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' };
      const post = () => fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const first = (await (await post()).json()) as { id: string };
      const retry = (await (await post()).json()) as { id: string };
      expect(retry.id).toBe(first.id);
      expect(app.tasks.list()).toHaveLength(1);
    } finally { release(); }
  });

  it('revises a held card even when the settlement words the decision differently', async () => {
    // The notetaker quotes the visitor in its own words, so matching on decisionSource would leave the early card
    // in place and create a second one for the same work. The settlement is authoritative for the topic.
    const early = app.tasks.suggest({ title: 'Email the supplier', context: 'Ask for stock',
      suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Ask the supplier for stock.' });
    const response = await fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Email the team decision', context: 'Use fresh stock.',
        suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Use fresh stock.' }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).toBe(early.id);
    expect(app.tasks.list()).toHaveLength(1);
    expect(app.tasks.get(early.id)).toMatchObject({ status: 'SUGGESTED', title: 'Email the team decision',
      decisionSource: 'Use fresh stock.' });
  });

  it('revises one held card and dismisses the other for the same topic, role and kind', async () => {
    const first = app.tasks.suggest({ title: 'Post one update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early one' });
    const second = app.tasks.suggest({ title: 'Post another update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early two' });
    const response = await fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).toBe(first.id);
    expect(app.tasks.list()).toHaveLength(2);
    expect(app.tasks.get(first.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post the prep plan' });
    expect(app.tasks.get(second.id)?.status).toBe('DISMISSED');
  });

  it('leaves a held card with a different action kind untouched when settling', async () => {
    const early = app.tasks.suggest({ title: 'Email the supplier', context: 'Ask for stock',
      suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Ask for stock.' });
    const response = await fetch(`http://127.0.0.1:${port}/dev/settle-topic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).not.toBe(early.id);
    expect(app.tasks.list()).toHaveLength(2);
    expect(app.tasks.get(early.id)).toMatchObject({ status: 'SUGGESTED', title: 'Email the supplier' });
  });

  it('returns 400 with the message when a dev suggestion is rejected', async () => {
    const suggest = vi.spyOn(app.tasks, 'suggest').mockImplementation(() => {
      throw new CommandError('Invalid task suggestion');
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/dev/suggest-task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Fix the oven',
          context: 'It trips the fuse.',
          suggestedAssignee: 'chef',
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid task suggestion' });
    } finally {
      suggest.mockRestore();
    }
  });

  it('returns 404 for dev endpoints when dev routes are off', async () => {
    const appWithoutDevRoutes = await createTestApp();
    try {
      const offPort = portOf(appWithoutDevRoutes);
      const emit = await fetch(`http://127.0.0.1:${offPort}/dev/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opening),
      });
      expect(emit.status).toBe(404);

      const suggest = await fetch(`http://127.0.0.1:${offPort}/dev/suggest-task`, {
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
      await appWithoutDevRoutes.close();
    }
  });

  it('rejects createApp with EADDRINUSE when the port is taken', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, () => {
        occupied.off('error', reject);
        resolve();
      });
    });

    try {
      const address = occupied.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected the occupied server to listen on a TCP port');
      }
      await expect(
        createApp({ port: address.port, scenario: testScenario }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
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

  it('loads the shipped Kopitiam scenario', async () => {
    const scenario = await loadScenario('kopitiam');
    expect(scenario.id).toBe('kopitiam');
    expect(scenario.roles.map((role) => role.id)).toEqual([
      'producer',
      'lead_programmer',
      'game_designer',
      'marketing_lead',
      'studio_manager',
    ]);
    expect(scenario.agenda).toHaveLength(4);
  });

  it('keeps the shipped Auntie Mary facts to what the records say', async () => {
    const scenario = await loadScenario('kopitiam');
    const weiLing = scenario.npcs?.find((npc) => npc.attendee === 'Wei Ling');
    const concerns = weiLing?.concerns.join(' ') ?? '';
    expect(concerns).toContain('got screamed at');
    expect(concerns).toContain('refuses to police seats or touch customers\' belongings');
    expect(concerns).not.toMatch(/\b(?:quit|resigned|fired|leaving)\b/i);
  });
});
