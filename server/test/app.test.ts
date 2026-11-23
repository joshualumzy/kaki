import { createServer, request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import { publicToolUrls } from '../src/action/publicToolUrls';
import { CommandError } from '../src/core/hub';
import { loadScenario } from '../src/core/loadScenario';
import {
  connectMeetingClient,
  createPracticeTestApp,
  createRealTestApp,
  meetingUrl,
  meetingWsUrl,
  portOf,
  practiceModulesWith,
  realModulesWith,
  settle,
  waitFor,
  waitForEvent,
  type TestAppWithMeeting,
  type TestClient,
} from './helpers';
import { testScenario } from './fixtures/scenario';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { parseScenario, type Scenario } from '@kaki/shared';

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
  let app: TestAppWithMeeting;
  let port: number;
  let clients: TestClient[];

  beforeEach(async () => {
    app = await createPracticeTestApp({ scenario: testScenario, devRoutes: true });
    port = portOf(app);
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await app.close();
  });

  function url(path: string): string {
    return meetingUrl(app, app.meetingId, path);
  }

  async function connect(role: string): Promise<TestClient> {
    const client = await connectMeetingClient(port, app.meetingId, role);
    clients.push(client);
    return client;
  }

  it('accepts a meeting memory snapshot through the dev route and clears it on reset', async () => {
    const entries = [{ kind: 'invented', item: 'Prep', text: 'The supplier can come at 9 AM.' }];
    const post = (value: unknown) => fetch(url('/dev/meeting-memory'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await post(entries)).status).toBe(200);
    expect(app.memory).toEqual(entries);
    expect((await post([{ kind: 'invented', item: 'Outside this meeting', text: 'No.' }])).status).toBe(400);
    app.session.reset();
    expect(app.memory).toEqual([]);
  });

  it.each(['CLAIMED', 'DRAFT_READY'] as const)('supersedes a %s card and creates a fresh card for a reopened decision', async (status) => {
    const old = app.tasks.suggest({ title: 'First plan', context: 'Original call', suggestedAssignee: 'chef',
      agendaItemTitle: 'Prep', actionKind: 'email', decisionSource: 'Use the first plan.' });
    app.tasks.transition(old.id, 'DISPATCHED', { assignee: 'chef' });
    app.tasks.transition(old.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    if (status === 'DRAFT_READY') app.tasks.transition(old.id, 'DRAFT_READY', {
      draft: { target: 'team@example.com', subject: 'First', body: 'Use the first plan.' },
    });
    const response = await fetch(url('/dev/settle-topic?reopen=1'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Revised plan', context: 'Revised call', suggestedAssignee: 'chef',
        agendaItemTitle: 'Prep', actionKind: 'mattermost_post', decisionSource: 'Use the revised plan.' }),
    });
    expect(response.status).toBe(200);
    const fresh = await response.json() as { id: string; status: string };
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('SUGGESTED');
    expect(app.tasks.get(old.id)?.status).toBe('SUPERSEDED');
  });

  it('supersedes an accepted card for a reopened decision when only the deliverable changed', async () => {
    const old = app.tasks.suggest({ title: 'First plan', context: 'Original call', suggestedAssignee: 'chef',
      agendaItemTitle: 'Prep', actionKind: 'email', decisionSource: 'Use the first plan.' });
    app.tasks.transition(old.id, 'DISPATCHED', { assignee: 'chef' });
    app.tasks.transition(old.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    const response = await fetch(url('/dev/settle-topic?reopen=1'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the same plan', context: 'Same call, different deliverable',
        suggestedAssignee: 'chef', agendaItemTitle: 'Prep', actionKind: 'mattermost_post',
        decisionSource: 'Use the first plan.' }),
    });
    expect(response.status).toBe(200);
    const fresh = await response.json() as { id: string; status: string };
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('SUGGESTED');
    expect(app.tasks.get(old.id)?.status).toBe('SUPERSEDED');
  });

  it('closes sockets with 1008 for an unknown or missing role', async () => {
    const unknown = await closeInfoFor(meetingWsUrl(port, app.meetingId, 'role=waiter'));
    expect(unknown.code).toBe(1008);
    expect(unknown.reason).toContain('Unknown role');

    const missing = await closeInfoFor(meetingWsUrl(port, app.meetingId, 'other=1'));
    expect(missing.code).toBe(1008);
    expect(missing.reason).toContain('Missing role');
  });

  it('closes an over-long unknown role without crashing the server', async () => {
    const role = '€'.repeat(80);
    const unknown = await closeInfoFor(
      meetingWsUrl(port, app.meetingId, `role=${encodeURIComponent(role)}`),
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
      type: 'WINGMAN_NOTE',
      audience: { kind: 'role', role: 'chef' },
      payload: {
        id: 'answer:chef',
        kind: 'answer',
        urgency: 'quiet',
        title: 'Wingman',
        text: 'Prep starts now.',
      },
    });
    await settle();

    expect(chef.messages.some((event) => event.type === 'WINGMAN_NOTE')).toBe(true);
    expect(screen.messages).toEqual([]);
  });

  it('serves the meeting code with sign-in off, so the owner lobby can show it', async () => {
    const response = await fetch(url('/api/meeting-code'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: unknown };
    expect(typeof body.code).toBe('string');
    expect((body.code as string).length).toBeGreaterThan(0);
  });

  it('serves the health check and the active scenario', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const scenario = await fetch(url('/api/scenario'));
    expect(scenario.status).toBe(200);
    expect(await scenario.json()).toEqual({
      ...testScenario,
      toolUrls: publicToolUrls(process.env, '127.0.0.1'),
    });
  });

  it('accepts a valid dev event and delivers it', async () => {
    const screen = await connect('screen');

    const response = await fetch(url('/dev/emit'), {
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
        { host: '127.0.0.1', port, method: 'POST', path: `/api/meetings/${app.meetingId}/../../dev/emit`, headers: { 'content-type': 'application/json' } },
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
    const invalid = {
      type: 'WINGMAN_NOTE',
      audience: { kind: 'role', role: 'waiter' },
      payload: { id: 'note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'x' },
    };

    const rejected = await fetch(url('/dev/emit'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    expect(rejected.status).toBe(400);

    const malformed = await fetch(url('/dev/emit'), {
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
      const response = await fetch(url('/dev/emit'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opening),
      });
      expect(response.status).toBe(200);
    }

    const screen = await connect('screen');
    await settle();
    expect(screen.messages).toEqual([{ ...opening, replayed: true }]);
  });

  it('suggests a task through the dev endpoint', async () => {
    const screen = await connect('screen');

    const response = await fetch(url('/dev/suggest-task'), {
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

  it('rejects a runner body that tries to set the server-internal task purpose', async () => {
    const post = (path: string, body: unknown) => fetch(url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const suggestion = {
      title: 'Pretend minutes',
      context: 'A runner body must not stamp a milestone.',
      suggestedAssignee: 'chef',
      agendaItemTitle: 'Prep',
      purpose: 'meeting_minutes',
    };

    expect((await post('/api/runner/suggest-task', suggestion)).status).toBe(400);
    expect((await post('/api/runner/settle-topic', suggestion)).status).toBe(400);
    expect(app.tasks.list().some((task) => task.purpose === 'meeting_minutes')).toBe(false);
  });

  it('settlement reuses a held follow-up card for the same role, kind and topic', async () => {
    const { installAutoDispatch } = await import('../src/host/autoDispatch');
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, holdUntilSettled: true });
    try {
      const early = app.tasks.suggest({ title: 'Tell the team what we decided', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep' });
      const response = await fetch(url('/dev/settle-topic'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
          suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock',
          cardId: early.id }),
      });
      expect(response.status).toBe(200);
      const settled = (await response.json()) as { id: string };
      expect(settled.id).toBe(early.id);
      expect(app.tasks.list()).toHaveLength(1);
      expect(app.tasks.get(early.id)).toMatchObject({ status: 'DISPATCHED', title: 'Post the prep plan',
        context: 'Visitor decision: use fresh stock', decisionSource: 'use fresh stock' });
    } finally { release(); }
  });

  it('stamps a settled card with the meeting second the call was made, and a retry keeps it', async () => {
    let meetingSeconds = 930;
    const clocked = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      devRoutes: true,
      practiceModules: practiceModulesWith([], {
        meetingElapsedSeconds: () => meetingSeconds,
      }),
    });
    try {
      const post = async (cardId?: string): Promise<{ id: string; sourceSeconds?: number }> => {
        const response = await fetch(meetingUrl(clocked, clocked.meetingId, '/dev/settle-topic'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
            suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep',
            decisionSource: 'use fresh stock', ...(cardId === undefined ? {} : { cardId }) }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { id: string; sourceSeconds?: number };
      };
      const first = await post();
      expect(first.sourceSeconds).toBe(930);
      meetingSeconds = 1200;
      const retried = await post(first.id);
      expect(retried.id).toBe(first.id);
      expect(retried.sourceSeconds).toBe(930);
    } finally {
      await clocked.close();
    }
  });

  it('settles a held card whose decision is worded exactly like the settlement', async () => {
    const { installAutoDispatch } = await import('../src/host/autoDispatch');
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, holdUntilSettled: true });
    try {
      const screen = await connect('screen');
      const early = app.tasks.suggest({ title: 'Post the prep plan', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep',
        decisionSource: 'use fresh stock' });
      const response = await fetch(url('/dev/settle-topic'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
          suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep',
          decisionSource: 'use fresh stock', cardId: early.id }),
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
    const release = installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, holdUntilSettled: true });
    try {
      const body = { title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' };
      const post = (cardId?: string) => fetch(url('/dev/settle-topic'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...(cardId === undefined ? {} : { cardId }) }),
      });
      const first = (await (await post()).json()) as { id: string };
      const retry = (await (await post(first.id)).json()) as { id: string };
      expect(retry.id).toBe(first.id);
      expect(app.tasks.list()).toHaveLength(1);
    } finally { release(); }
  });

  it('revises a held card even when the settlement words the decision differently', async () => {
    // The notetaker quotes the visitor in its own words, so matching on decisionSource would leave the early card
    // in place and create a second one for the same work. The settlement is authoritative for the topic.
    const early = app.tasks.suggest({ title: 'Email the supplier', context: 'Ask for stock',
      suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Ask the supplier for stock.' });
    const response = await fetch(url('/dev/settle-topic'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Email the team decision', context: 'Use fresh stock.',
        suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Use fresh stock.',
        cardId: early.id }),
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
    const response = await fetch(url('/dev/settle-topic'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock',
        cardId: first.id }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).toBe(first.id);
    expect(app.tasks.list()).toHaveLength(2);
    expect(app.tasks.get(first.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post the prep plan' });
    expect(app.tasks.get(second.id)?.status).toBe('DISMISSED');
  });

  it('revises the named held card, not the first one that matches', async () => {
    const first = app.tasks.suggest({ title: 'Post one update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early one' });
    const second = app.tasks.suggest({ title: 'Post another update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early two' });
    const response = await fetch(url('/dev/settle-topic'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock',
        cardId: second.id }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).toBe(second.id);
    expect(app.tasks.get(second.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post the prep plan' });
    expect(app.tasks.get(first.id)?.status).toBe('DISMISSED');
  });

  it('revises the one held card server-side when a settlement names no card', async () => {
    const early = app.tasks.suggest({ title: 'Post one update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early one' });
    const response = await fetch(url('/dev/settle-topic'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).toBe(early.id);
    expect(app.tasks.list()).toHaveLength(1);
    expect(app.tasks.get(early.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post the prep plan',
      decisionSource: 'use fresh stock' });
  });

  it('revises none and warns when a settlement names no card but several held cards match', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = app.tasks.suggest({ title: 'Post one update', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early one' });
      const second = app.tasks.suggest({ title: 'Post another update', context: 'Early note',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early two' });
      const response = await fetch(url('/dev/settle-topic'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
          suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock' }),
      });
      const settled = (await response.json()) as { id: string };
      expect(settled.id).not.toBe(first.id);
      expect(settled.id).not.toBe(second.id);
      expect(app.tasks.get(first.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post one update' });
      expect(app.tasks.get(second.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post another update' });
      expect(warn.mock.calls.some((call) => String(call[0]).includes('none is revised'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('revises nothing when a settlement names an unknown card', async () => {
    const early = app.tasks.suggest({ title: 'Post one update', context: 'Early note',
      suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'early one' });
    const response = await fetch(url('/dev/settle-topic'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
        suggestedAssignee: 'chef', actionKind: 'mattermost_post', agendaItemTitle: 'Prep', decisionSource: 'use fresh stock',
        cardId: 'task-does-not-exist' }),
    });
    const settled = (await response.json()) as { id: string };
    expect(settled.id).not.toBe(early.id);
    expect(app.tasks.get(early.id)).toMatchObject({ status: 'SUGGESTED', title: 'Post one update' });
  });

  it('leaves a held card with a different action kind untouched when settling', async () => {
    const early = app.tasks.suggest({ title: 'Email the supplier', context: 'Ask for stock',
      suggestedAssignee: 'chef', actionKind: 'email', agendaItemTitle: 'Prep', decisionSource: 'Ask for stock.' });
    const response = await fetch(url('/dev/settle-topic'), {
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
      const response = await fetch(url('/dev/suggest-task'), {
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
    const appWithoutDevRoutes = await createPracticeTestApp();
    try {
      const emit = await fetch(meetingUrl(appWithoutDevRoutes, appWithoutDevRoutes.meetingId, '/dev/emit'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opening),
      });
      expect(emit.status).toBe(404);

      const suggest = await fetch(meetingUrl(appWithoutDevRoutes, appWithoutDevRoutes.meetingId, '/dev/suggest-task'), {
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
      occupied.listen(0, '127.0.0.1', () => {
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
        createApp({ speechRecognition: 'browser', port: address.port, scenario: testScenario }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('reports a module that fails to start, naming the module', async () => {
    const broken = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      meetingModules: realModulesWith([
        {
          name: 'broken-module',
          start() {
            throw new Error('boom');
          },
        },
      ]),
    });
    try {
      await expect(
        broken.registry.create({ workspaceId: 'workspace-1', ownerUserId: 'test-owner', title: 'Broken' })
          .then((row) => broken.registry.get(row.id)),
      ).rejects.toThrow(/broken-module/);
    } finally {
      await broken.close();
    }
  });

  it('loads the shipped Kopitiam scenario', async () => {
    const scenario = await loadScenario('kopitiam');
    expect(scenario.id).toBe('kopitiam');
    expect(scenario.roles.map((role) => role.id)).toEqual([
      'operations_director',
      'tech_pos_lead',
      'menu_store_lead',
      'marketing_lead',
      'general_manager',
    ]);
    expect(scenario.agenda).toHaveLength(5);
    expect(scenario.excludedPairs).toHaveLength(2);
  });

  it('serves a parseable meeting scenario after a join, never splicing the pack', async () => {
    const full = await loadScenario('kopitiam');
    const agendaReference = full.agenda;
    const meeting = await createRealTestApp(
      { speechRecognition: 'browser', scenario: full, roomRoster: async () => [] },
      { title: 'Weekly planning', agenda: full.agenda.slice(0, 2) },
    );
    try {
      const joined = await fetch(meetingUrl(meeting, meeting.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'test-room', participantName: 'Visitor', participantRole: full.roles[0]!.id }),
      });
      expect(joined.status).toBe(200);
      const response = await fetch(meetingUrl(meeting, meeting.meetingId, '/api/scenario'));
      expect(response.status).toBe(200);
      const parsed = parseScenario(await response.json(), { requireOrganisation: false });
      expect(parsed.agenda).toHaveLength(2);
      // The active meeting is its own value now: the pack the server was given is never spliced.
      expect(full.agenda).toBe(agendaReference);
      expect(full.agenda).toHaveLength(5);
      const packTitles = new Set(full.agenda.map((item) => item.title));
      expect(parsed.agenda.every((item) => packTitles.has(item.title))).toBe(true);
    } finally {
      await meeting.close();
    }
  });

  it('keeps the shipped Auntie Mary facts to what the records say', async () => {
    const scenario = await loadScenario('kopitiam');
    const noShow = scenario.agenda.find((item) => item.title === 'One counter staff short for the opening rush');
    const fact = noShow?.seatFacts?.operations_director ?? '';
    expect(fact).toContain('rest day');
    expect(fact).toContain('double pay');
    expect(fact).toContain('free to say no');
    expect(noShow?.offScreen?.name).toBe('Auntie Mary');
  });
});

describe('one server-owned meeting start', () => {
  it('fails visibly until the AI runner confirms it opened, then starts on retry', async () => {
    const scenario: Scenario = {
      ...testScenario,
      npcs: [
        { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host' },
      ],
    };
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario,
      startAckTimeoutMs: 100,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      practiceModules: practiceModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    });
    const port = portOf(app);
    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    const sockets: WebSocket[] = [];
    let runner: WebSocket | undefined;
    let mode: 'silent' | 'failed' | 'ready' = 'silent';
    const warning = vi.spyOn(console, 'warn');
    const join = () => fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie! },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Bao', participantRole: 'cashier', kind: 'practice' }),
    });
    const startMeeting = () => fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
      method: 'POST',
      headers: { cookie: app.cookie! },
    });
    const connectService = (): Promise<WebSocket> => {
      const socket = new WebSocket(meetingWsUrl(port, app.meetingId, 'role=service'));
      sockets.push(socket);
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    };
    try {
      expect((await join()).status).toBe(200);
      const unavailable = await startMeeting();
      expect(unavailable.status).toBe(503);
      const unavailableBody = (await unavailable.json()) as { error?: string; retryable?: boolean };
      expect(unavailableBody.error).toMatch(/AI attendees are not connected/i);
      expect(unavailableBody.retryable).toBe(true);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(0);

      runner = await connectService();
      runner.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          kind?: string;
          request?: { requestId?: string; attempt?: string; meetingId?: string };
        };
        const { requestId, attempt, meetingId } = message.request ?? {};
        if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
          return;
        }
        if (mode === 'ready') runner?.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
        else if (mode === 'failed') {
          runner?.send(JSON.stringify({ kind: 'failed', requestId, attempt, meetingId, reason: 'cast initialization failed' }));
        }
      });

      const timedOut = await startMeeting();
      expect(timedOut.status).toBe(503);
      expect(((await timedOut.json()) as { error?: string }).error).toMatch(/did not open the meeting/i);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(0);

      mode = 'failed';
      const failed = await startMeeting();
      expect(failed.status).toBe(503);
      const failedBody = (await failed.json()) as { error?: string };
      expect(failedBody.error).toBe('The AI attendees did not open the meeting. Check that npm run npc is running, then try again.');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cast initialization failed'));
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(0);

      mode = 'ready';
      const started = await startMeeting();
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ started: true });
      await waitForEvent(screen, (event) => event.type === 'MEETING_STARTED', 'the acknowledged start');
    } finally {
      warning.mockRestore();
      runner?.terminate();
      for (const socket of sockets) socket.terminate();
      screen.close();
      await app.close();
    }
  });

  it('needs no runner acknowledgement when the meeting has no AI stand-ins', async () => {
    const app = await createRealTestApp(
      { speechRecognition: 'browser', scenario: testScenario, roomRoster: async () => [] },
      { title: 'Weekly planning' },
    );
    try {
      expect((await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'test-room', participantName: 'Ada', participantRole: 'chef' }),
      })).status).toBe(200);
      const started = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ started: true });
    } finally {
      await app.close();
    }
  });

  it('starts once, lets B join a running meeting, and never opens a second time', async () => {
    const app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario: testScenario,
        roomRoster: async () => [],
        rejoinGraceMs: 60_000,
        meetingModules: realModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
      },
      { title: 'Weekly planning' },
    );
    const port = portOf(app);
    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    const join = (participantName: string, participantRole: string) => fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomName: 'test-room', participantName, participantRole }),
    });
    try {
      const a = await join('Ada', 'chef');
      const aBody = (await a.json()) as { started?: boolean };
      expect(a.status).toBe(200);
      expect(aBody.started).toBe(false);
      const resetsBefore = screen.messages.filter((event) => event.type === 'MEETING_RESET').length;

      const first = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ started: true });
      await waitForEvent(screen, (event) => event.type === 'MEETING_STARTED', 'the start event');

      const b = await join('Bao', 'cashier');
      const bBody = (await b.json()) as { started?: boolean; resumed?: boolean };
      expect(b.status).toBe(200);
      expect(bBody.started).toBe(true);
      expect(bBody.resumed).toBe(true);

      const resets = screen.messages.filter((event) => event.type === 'MEETING_RESET');
      expect(resets).toHaveLength(resetsBefore);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(1);

      const second = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ started: true, alreadyStarted: true });
      await settle(120);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(1);

      // A later speech line does not open the meeting again.
      app.hub.publish({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'screen' },
        payload: { speaker: 'Ada (Chef)', text: 'Let us begin.', timestamp: new Date().toISOString() },
      });
      await settle(120);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(1);
    } finally {
      screen.close();
      await app.close();
    }
  });

  it('refuses Start before anyone joins, then starts once a person is admitted', async () => {
    const app = await createRealTestApp(
      { speechRecognition: 'browser', scenario: testScenario, roomRoster: async () => [] },
      { title: 'Weekly planning' },
    );
    try {
      const refused = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'Join the meeting before pressing Start.' });

      const joined = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'test-room', participantName: 'Ada', participantRole: 'chef' }),
      });
      expect(joined.status).toBe(200);
      expect(((await joined.json()) as { started?: boolean }).started).toBe(false);

      const started = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({ started: true });
    } finally {
      await app.close();
    }
  });

  it('starts the agenda clock at Start, not at the first speech', async () => {
    const clock = createAgendaClock({ agenda: testScenario.agenda });
    const app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario: testScenario,
        roomRoster: async () => [],
        meetingModules: realModulesWith([createMeetingModule({ clock, notetakerIntervalMs: 60_000 })]),
      },
      { title: 'Weekly planning', agenda: testScenario.agenda },
    );
    try {
      const joined = await fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'test-room', participantName: 'Ada', participantRole: 'chef' }),
      });
      expect(joined.status).toBe(200);

      app.hub.publish({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'screen' },
        payload: { speaker: 'Ada (Chef)', text: 'We started early.', timestamp: new Date().toISOString() },
      });
      await settle(120);
      expect(clock.snapshot().started).toBe(false);

      const started = await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' });
      expect(started.status).toBe(200);
      await waitFor(() => (clock.snapshot().started ? true : undefined), 'the clock to start');

      app.hub.publish({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'screen' },
        payload: { speaker: 'Ada (Chef)', text: 'Now we begin.', timestamp: new Date().toISOString() },
      });
      await settle(120);
      expect(clock.snapshot().meetingElapsedSeconds).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe('rejoin and start races', () => {
  type Roster = Array<{ name: string; role?: string }> | undefined;

  function connectService(port: number, meetingId: string): Promise<WebSocket> {
    const socket = new WebSocket(meetingWsUrl(port, meetingId, 'role=service'));
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  const hostScenario: Scenario = {
    ...testScenario,
    npcs: [
      { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host' },
    ],
  };

  async function practiceSeatApp(startAckTimeoutMs = 1_000): Promise<TestAppWithMeeting> {
    return createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: hostScenario,
      startAckTimeoutMs,
      roomRoster: async () => [],
      rejoinGraceMs: 60_000,
      rejoinPollMs: 60_000,
      practiceModules: practiceModulesWith([createMeetingModule({ notetakerIntervalMs: 60_000 })]),
    });
  }

  it('never starts a reset replacement from a late acknowledgement', async () => {
    const app = await practiceSeatApp();
    const port = portOf(app);
    let screen = await connectMeetingClient(port, app.meetingId, 'screen');
    const runner = await connectService(port, app.meetingId);
    let ackMode: 'none' | 'ready' = 'none';
    const prepares: Array<{ requestId: string; attempt: string; meetingId: string }> = [];
    const join = () => fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie! },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Bao', participantRole: 'cashier', kind: 'practice' }),
    });
    const startMeeting = () => fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
      method: 'POST',
      headers: { cookie: app.cookie! },
    });
    try {
      runner.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          kind?: string;
          request?: { requestId?: string; attempt?: string; meetingId?: string };
        };
        const { requestId, attempt, meetingId } = message.request ?? {};
        if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
          return;
        }
        prepares.push({ requestId, attempt, meetingId });
        if (ackMode === 'ready') {
          runner.send(JSON.stringify({ kind: 'ready', requestId, attempt, meetingId }));
        }
      });

      expect((await join()).status).toBe(200);
      const firstStart = startMeeting();
      await waitFor(() => (prepares[0] === undefined ? undefined : prepares[0]), 'the first prepare');
      const oldPrepare = prepares[0]!;

      // The meeting is reset while the runner is still preparing the old one.
      const replacement = app.session.reset();
      runner.send(
        JSON.stringify({
          kind: 'ready',
          requestId: oldPrepare.requestId,
          attempt: oldPrepare.attempt,
          meetingId: oldPrepare.meetingId,
        }),
      );

      const resetStart = await firstStart;
      expect(resetStart.status).toBe(503);
      await settle(100);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(0);
      const afterReset = (await (await fetch(meetingUrl(app, app.meetingId, '/api/meeting/state'))).json()) as {
        meetingId: string;
        started: boolean;
      };
      expect(afterReset).toMatchObject({ meetingId: replacement, started: false });

      // The replacement meeting gets its own attempt; the old acknowledgement cannot satisfy it.
      // The reset revokes the practice screen, but the visitor's cookie still opens the same
      // practice, so they rejoin and reconnect without a new capability.
      expect((await join()).status).toBe(200);
      screen = await connectMeetingClient(port, app.meetingId, 'screen');
      ackMode = 'ready';
      const secondStart = await startMeeting();
      expect(secondStart.status).toBe(200);
      expect(prepares).toHaveLength(2);
      expect(prepares[1]!.meetingId).toBe(replacement);
      expect(prepares[1]!.attempt).not.toBe(oldPrepare.attempt);
      await waitForEvent(screen, (event) => event.type === 'MEETING_STARTED', 'the replacement start');
      const startedEvent = screen.messages.find((event) => event.type === 'MEETING_STARTED');
      expect(startedEvent?.type === 'MEETING_STARTED' ? startedEvent.payload.meetingId : undefined).toBe(replacement);
    } finally {
      runner.terminate();
      screen.close();
      await app.close();
    }
  });

  it('never commits a meeting whose reset lands after the acknowledgement but before the start', async () => {
    const app = await practiceSeatApp();
    const port = portOf(app);
    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    const runner = await connectService(port, app.meetingId);
    const prepares: Array<{ requestId: string; attempt: string; meetingId: string }> = [];
    const join = () => fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: app.cookie! },
      body: JSON.stringify({ roomName: 'test-room', participantName: 'Bao', participantRole: 'cashier', kind: 'practice' }),
    });
    const startMeeting = () => fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
      method: 'POST',
      headers: { cookie: app.cookie! },
    });
    try {
      runner.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          kind?: string;
          request?: { requestId?: string; attempt?: string; meetingId?: string };
        };
        const { requestId, attempt, meetingId } = message.request ?? {};
        if (message.kind !== 'prepare' || requestId === undefined || attempt === undefined || meetingId === undefined) {
          return;
        }
        prepares.push({ requestId, attempt, meetingId });
      });

      expect((await join()).status).toBe(200);
      const firstStart = startMeeting();
      await waitFor(() => (prepares[0] === undefined ? undefined : prepares[0]), 'the prepare');
      const oldPrepare = prepares[0]!;

      // The hub calls the meeting's service handler first, which resolves the Start waiter; ours runs
      // next, still synchronously, so the reset lands after acknowledgement and before the commit.
      let replacement: string | undefined;
      app.hub.onServiceMessage?.((message) => {
        if (message.requestId !== oldPrepare.requestId) return;
        replacement = app.session.reset();
      });
      runner.send(
        JSON.stringify({
          kind: 'ready',
          requestId: oldPrepare.requestId,
          attempt: oldPrepare.attempt,
          meetingId: oldPrepare.meetingId,
        }),
      );

      const resetStart = await firstStart;
      expect(resetStart.status).toBe(503);
      await settle(100);
      expect(screen.messages.filter((event) => event.type === 'MEETING_STARTED')).toHaveLength(0);
      const afterReset = (await (await fetch(meetingUrl(app, app.meetingId, '/api/meeting/state'))).json()) as {
        meetingId: string;
        started: boolean;
      };
      expect(afterReset).toMatchObject({ meetingId: replacement, started: false });
    } finally {
      runner.terminate();
      screen.close();
      await app.close();
    }
  });

  async function twoInAStartedMeeting(
    graceMs: number,
    pollMs: number,
  ): Promise<{
    app: TestAppWithMeeting;
    screen: TestClient;
    people: { value: Roster };
    taskId: string;
    code: string;
    join: (participantName: string) => Promise<Response>;
  }> {
    const people: { value: Roster } = { value: [] };
    const app = await createRealTestApp(
      {
        speechRecognition: 'browser',
        scenario: testScenario,
        roomRoster: async () => people.value,
        rejoinGraceMs: graceMs,
        rejoinPollMs: pollMs,
        admissionReservationMs: 20,
      },
      { title: 'Weekly planning', agenda: [{ title: 'Prep', minutes: 5 }] },
    );
    const port = portOf(app);
    const screen = await connectMeetingClient(port, app.meetingId, 'screen');
    // The owner's open carries the meeting into the next one after the grace; while it runs it answers 409 harmlessly.
    const join = async (participantName: string): Promise<Response> => {
      await fetch(meetingUrl(app, app.meetingId, '/api/meeting/open'), { method: 'POST' });
      return fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: 'test-room', participantName }),
      });
    };
    expect((await join('Ada')).status).toBe(200);
    people.value = [{ name: 'Ada' }];
    expect((await join('Bao')).status).toBe(200);
    people.value = [{ name: 'Ada' }, { name: 'Bao' }];
    expect((await fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), { method: 'POST' })).status).toBe(200);
    const code = app.instance.meetingCode();
    const assignee = app.session.holders()[0]?.seat ?? 'everyone';
    const task = app.tasks.suggest({ title: 'Keep this card', context: 'Before the break', suggestedAssignee: assignee });
    await settle(120);
    return { app, screen, people, taskId: task.id, code, join };
  }

  it('keeps the meeting when one leaves while the other stays, and when both return in either order', async () => {
    const { app, screen, people, taskId, code, join } = await twoInAStartedMeeting(60_000, 5);
    try {
      const resetsBefore = screen.messages.filter((event) => event.type === 'MEETING_RESET').length;
      // Ada leaves, Bao stays: the poll sees a person, so there is no grace and no reset.
      people.value = [{ name: 'Bao' }];
      await settle(50);
      expect(screen.messages.filter((event) => event.type === 'MEETING_RESET')).toHaveLength(resetsBefore);

      // Bao leaves too: the grace starts. Ada returns first, then Bao.
      people.value = [];
      await settle(50);
      const adaBack = await join('Ada');
      const adaBody = (await adaBack.json()) as { started?: boolean };
      expect(adaBack.status).toBe(200);
      expect(adaBody.started).toBe(true);
      expect(app.instance.meetingCode()).toBe(code);
      people.value = [{ name: 'Ada' }];
      const baoBack = await join('Bao');
      const baoBody = (await baoBack.json()) as { started?: boolean };
      expect(baoBack.status).toBe(200);
      expect(baoBody.started).toBe(true);
      expect(app.tasks.get(taskId)?.title).toBe('Keep this card');
      expect(screen.messages.filter((event) => event.type === 'MEETING_RESET')).toHaveLength(resetsBefore);
    } finally {
      screen.close();
      await app.close();
    }
  });

  it('keeps the meeting when both return in the other order', async () => {
    const { app, screen, people, taskId, code, join } = await twoInAStartedMeeting(60_000, 5);
    try {
      const resetsBefore = screen.messages.filter((event) => event.type === 'MEETING_RESET').length;
      people.value = [];
      await settle(50);
      const baoBack = await join('Bao');
      expect(baoBack.status).toBe(200);
      people.value = [{ name: 'Bao' }];
      const adaBack = await join('Ada');
      const adaBody = (await adaBack.json()) as { started?: boolean };
      expect(adaBack.status).toBe(200);
      expect(adaBody.started).toBe(true);
      expect(app.instance.meetingCode()).toBe(code);
      expect(app.tasks.get(taskId)?.title).toBe('Keep this card');
      expect(screen.messages.filter((event) => event.type === 'MEETING_RESET')).toHaveLength(resetsBefore);
    } finally {
      screen.close();
      await app.close();
    }
  });

});
