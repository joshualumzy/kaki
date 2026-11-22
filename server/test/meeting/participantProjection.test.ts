import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { KakiEvent, Task } from '@kaki/shared';
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

function tasksById(messages: readonly KakiEvent[]): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (const event of messages) {
    if (event.type === 'TASK_UPDATED') tasks.set(event.payload.task.id, event.payload.task);
  }
  return tasks;
}

function taskWithDraft(
  tasks: KakiApp['tasks'],
  input: {
    title: string;
    context: string;
    assignee: 'chef' | 'cashier';
    body: string;
    purpose?: 'meeting_minutes';
  },
): Task {
  const suggestion = {
    title: input.title,
    context: input.context,
    suggestedAssignee: input.assignee,
    actionKind: 'wiki_page' as const,
  };
  const task =
    input.purpose === 'meeting_minutes'
      ? tasks.suggestWithPurpose(suggestion, input.purpose)
      : tasks.suggest(suggestion);
  tasks.transition(task.id, 'DISPATCHED', { assignee: input.assignee });
  tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
  return tasks.transition(task.id, 'DRAFT_READY', {
    draft: { target: 'Wiki: meeting notes', subject: input.title, body: input.body },
  });
}

describe('participant projection', () => {
  it('gives a participant the shared meeting and their own work, redacting other seats', async () => {
    const { app, port } = await authApp();
    const host = cookieFrom(
      await request(port, '/api/auth/login', 'POST', { email: HOST_EMAIL, password: HOST_PASSWORD }),
    );
    expect((await request(port, '/api/meeting/open', 'POST', undefined, host)).status).toBe(200);
    const chef = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'chef' }));
    const cashier = cookieFrom(await request(port, '/api/join', 'POST', { code: CODE, role: 'cashier' }));
    expect(chef).toBeTruthy();
    expect(cashier).toBeTruthy();

    const own = taskWithDraft(app.tasks, {
      title: 'Own job',
      context: 'OWN CONTEXT',
      assignee: 'chef',
      body: 'OWN DRAFT',
    });
    const other = taskWithDraft(app.tasks, {
      title: 'Other job',
      context: 'OTHER CONTEXT',
      assignee: 'cashier',
      body: 'OTHER DRAFT',
    });
    const minutes = taskWithDraft(app.tasks, {
      title: 'Publish meeting minutes to the team wiki',
      context: 'MINUTES CONTEXT',
      assignee: 'cashier',
      body: 'SECRET MINUTES',
      purpose: 'meeting_minutes',
    });

    app.hub.publish(
      {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'The shared line.', timestamp: new Date().toISOString() },
      },
      { retainKey: 'transcript:1' },
    );
    app.hub.publish(
      {
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'screen' },
        payload: {
          agendaIndex: 0,
          openQuestions: [],
          elapsedSeconds: 1,
          speakerTalkSeconds: {},
        },
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
    app.hub.publish(
      {
        type: 'WINGMAN_NOTE',
        audience: { kind: 'role', role: 'cashier' },
        payload: { id: 'other-note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'OTHER NOTE' },
      },
      { retainKey: 'note:cashier' },
    );

    // A participant may not read the owner's screen at all; their projection is the only shared feed.
    expect(await connect(port, 'screen', chef)).toMatchObject({ ok: false });
    const participant = await connect(port, 'participant', chef);
    if (!participant.ok) throw new Error('participant socket did not open');
    const ownerScreen = await connect(port, 'screen', host);
    if (!ownerScreen.ok) throw new Error('owner screen did not open');

    await waitFor(
      () => participant.messages.some((event) => event.type === 'MEETING_RECORD_UPDATED') ? true : undefined,
      'the retained meeting record',
    );
    await settle(50);

    expect(
      participant.messages.some(
        (event) => event.type === 'TRANSCRIPT_CHUNK' && event.payload.text === 'The shared line.',
      ),
    ).toBe(true);
    expect(
      participant.messages.some(
        (event) => event.type === 'WINGMAN_NOTE' && event.payload.text === 'OWN NOTE',
      ),
    ).toBe(true);
    expect(
      participant.messages.some(
        (event) => event.type === 'WINGMAN_NOTE' && event.payload.text === 'OTHER NOTE',
      ),
    ).toBe(false);

    const seen = tasksById(participant.messages);
    expect(seen.get(own.id)).toMatchObject({ context: 'OWN CONTEXT', draft: { body: 'OWN DRAFT' } });
    expect(seen.get(other.id)).toMatchObject({ title: 'Other job', assignee: 'cashier', context: '' });
    expect(seen.get(other.id)?.draft).toBeUndefined();
    expect(seen.has(minutes.id)).toBe(false);

    // The owner keeps the full screen: every task draft, but never another seat's private note.
    const ownerSeen = tasksById(ownerScreen.messages);
    expect(ownerSeen.get(other.id)).toMatchObject({ context: 'OTHER CONTEXT', draft: { body: 'OTHER DRAFT' } });
    expect(ownerSeen.get(minutes.id)).toMatchObject({ context: 'MINUTES CONTEXT', draft: { body: 'SECRET MINUTES' } });
    expect(ownerScreen.messages.some((event) => event.type === 'WINGMAN_NOTE')).toBe(false);

    // Live delivery uses the same rule: an update to another seat's draft stays redacted.
    app.tasks.transition(other.id, 'RUNNING', {
      draft: { target: 'Wiki: meeting notes', subject: 'Other job', body: 'LIVE OTHER DRAFT' },
    });
    const liveOther = await waitFor(
      () =>
        [...participant.messages]
          .reverse()
          .find(
            (event) =>
              event.type === 'TASK_UPDATED' &&
              event.payload.task.id === other.id &&
              event.payload.task.status === 'RUNNING',
          ),
      'the live redacted update',
    );
    expect(liveOther).toMatchObject({ payload: { task: { context: '' } } });
    expect((liveOther as Extract<KakiEvent, { type: 'TASK_UPDATED' }>).payload.task.draft).toBeUndefined();

    // Published minutes become a title and link for the room, never the draft body.
    app.tasks.transition(minutes.id, 'RUNNING');
    app.tasks.transition(minutes.id, 'COMPLETED', { artifactUrl: 'https://wiki.example/minutes' });
    const published = await waitFor(
      () =>
        [...participant.messages]
          .reverse()
          .find(
            (event) =>
              event.type === 'TASK_UPDATED' &&
              event.payload.task.id === minutes.id &&
              event.payload.task.status === 'COMPLETED',
          ),
      'the published minutes',
    );
    const publishedTask = (published as Extract<KakiEvent, { type: 'TASK_UPDATED' }>).payload.task;
    expect(publishedTask).toMatchObject({
      title: 'Publish meeting minutes to the team wiki',
      artifactUrl: 'https://wiki.example/minutes',
      context: '',
    });
    expect(publishedTask.draft).toBeUndefined();
  });

  it('redacts other seats\' task drafts from a practice screen while keeping the visitor\'s own', async () => {
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

    instance.hub.publish(
      {
        type: 'WINGMAN_NOTE',
        audience: { kind: 'role', role: 'chef' },
        payload: { id: 'practice-own-note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'PRACTICE OWN NOTE' },
      },
      { retainKey: 'note:practice:chef' },
    );
    instance.hub.publish(
      {
        type: 'WINGMAN_NOTE',
        audience: { kind: 'role', role: 'cashier' },
        payload: { id: 'practice-other-note', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'PRACTICE OTHER NOTE' },
      },
      { retainKey: 'note:practice:cashier' },
    );

    const own = taskWithDraft(instance.tasks, {
      title: 'Practice own job',
      context: 'PRACTICE OWN CONTEXT',
      assignee: 'chef',
      body: 'PRACTICE OWN DRAFT',
    });
    const other = taskWithDraft(instance.tasks, {
      title: 'Practice other job',
      context: 'PRACTICE OTHER CONTEXT',
      assignee: 'cashier',
      body: 'PRACTICE OTHER DRAFT',
    });

    const screen = await connect(port, 'screen', practiceCookie, meetingId);
    if (!screen.ok) throw new Error('practice screen did not open');
    await waitFor(
      () =>
        tasksById(screen.messages).has(own.id) && tasksById(screen.messages).has(other.id)
          ? true
          : undefined,
      'the practice task catch-up',
    );

    const seen = tasksById(screen.messages);
    expect(seen.get(own.id)).toMatchObject({ context: 'PRACTICE OWN CONTEXT', draft: { body: 'PRACTICE OWN DRAFT' } });
    expect(seen.get(other.id)).toMatchObject({ title: 'Practice other job', context: '' });
    expect(seen.get(other.id)?.draft).toBeUndefined();

    // The Kaki panel reads the practice screen, so the visitor's own notes must arrive there;
    // another seat's notes must not.
    expect(
      screen.messages.some(
        (event) => event.type === 'WINGMAN_NOTE' && event.payload.text === 'PRACTICE OWN NOTE',
      ),
    ).toBe(true);
    expect(
      screen.messages.some(
        (event) => event.type === 'WINGMAN_NOTE' && event.payload.text === 'PRACTICE OTHER NOTE',
      ),
    ).toBe(false);
  });
});
