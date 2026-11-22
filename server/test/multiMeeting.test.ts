import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ChatMessage, LlmClient } from '../src/services/llm';
import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashToken } from '../src/auth/password';
import { createMemoryAuthStore, type AuthStore } from '../src/auth/store';
import { createAgendaClock } from '../src/host/clock';
import { createMeetingModule } from '../src/host/meeting';
import { createMeetingCodeSource } from '../src/meeting/meetingCode';
import { createMeetingPersistence, type MeetingPersistence } from '../src/persist/persistence';
import type { StoredMeeting } from '../src/persist/state';
import type { MeetingRow } from '../src/meeting/types';
import type { MeetingModules } from '../src/modules';
import { createMemoryMeetingStore } from '../src/meeting/registry';
import { encryptSecret } from '../src/workspace/secrets';
import { createMemoryWorkspaceToolStore, type WorkspaceToolRecord } from '../src/workspace/tools';
import { testScenario } from './fixtures/scenario';
import { portOf, settle, waitFor } from './helpers';

const SERVICE_TOKEN = 'multi-meeting-runner-token';

/** A Gitea connection in each real workspace, so the issue card has somewhere real to go. */
const toolKey = Buffer.alloc(32, 7);
const toolEnv = { KAKI_SECRET_KEY: toolKey.toString('base64') };
function giteaTool(workspaceId: string): WorkspaceToolRecord {
  return {
    workspaceId,
    kind: 'gitea',
    settings: { url: 'http://gitea.test', owner: 'kopitiam', repo: 'issues' },
    ...encryptSecret('secret-token', toolKey),
    connectedBy: 'owner-1',
    connectedAt: new Date('2026-11-01T00:00:00Z'),
    lastOkAt: null,
  };
}

/** The notetaker's empty but valid reply, so a fake model can run without inventing a record. */
function emptyNotetakerReply(): string {
  return JSON.stringify({
    newQuestions: [],
    answeredQuestionIds: [],
    answeredQuestions: [],
    newTasks: [],
    revisions: [],
  });
}

/** The prompts each meeting's fake notetaker saw, keyed by meeting id. */
const promptsByMeeting = new Map<string, string[]>();
/** The live agenda clock of each meeting, read to prove one keeps moving while another ends. */
const elapsedByMeeting = new Map<string, () => number | undefined>();

function fakeModules(meeting: MeetingRow): MeetingModules {
  const prompts: string[] = [];
  promptsByMeeting.set(meeting.id, prompts);
  const llm: LlmClient = {
    async complete(messages: ChatMessage[]) {
      prompts.push(messages.map((message) => `${message.role}: ${message.content}`).join('\n'));
      return emptyNotetakerReply();
    },
  };
  const clock = createAgendaClock({ agenda: testScenario.agenda, speed: 1 });
  const snapshot = () => clock.snapshot();
  const elapsed = () => (snapshot().started ? snapshot().meetingElapsedSeconds : undefined);
  elapsedByMeeting.set(meeting.id, elapsed);
  return {
    modules: [createMeetingModule({ llm, notetakerIntervalMs: 20, clock })],
    meetingElapsedSeconds: elapsed,
    meetingAgendaIndex: () => (snapshot().started ? snapshot().agendaIndex : undefined),
    meetingPaused: () => (snapshot().started ? snapshot().paused === true : undefined),
    meetingPause: {
      paused: () => (snapshot().started ? snapshot().paused === true : undefined),
      kind: () => snapshot().pauseKind,
      pause: (kind) => clock.pause(kind),
      resume: () => clock.resume(),
    },
  };
}

/** One in-memory meeting_state row per meeting id, shared across a restart. */
class FakeStateStore {
  readonly rows = new Map<string, StoredMeeting>();
  forId(id: string) {
    return {
      load: async (): Promise<StoredMeeting | undefined> => this.rows.get(id),
      save: async (meeting: StoredMeeting): Promise<void> => {
        this.rows.set(id, meeting);
      },
      clear: async (): Promise<void> => {
        this.rows.delete(id);
      },
    };
  }
}

interface Socket {
  ws: WebSocket;
  messages: Array<{ type: string; payload: { task?: { id?: string } } }>;
  close(): void;
}

function connect(
  port: number,
  meetingId: string,
  role: string,
  cookie?: string,
  audience?: 'screen' | 'participant' | 'lifecycle',
): Promise<Socket> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = cookie;
  const channel =
    audience === undefined
      ? `role=${encodeURIComponent(role)}`
      : `audience=${encodeURIComponent(audience)}`;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meetingId)}&${channel}`,
    Object.keys(headers).length === 0 ? undefined : { headers },
  );
  const messages: Socket['messages'] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as Socket['messages'][number]));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, close: () => ws.close() }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`upgrade refused with HTTP ${response.statusCode ?? 0}`));
    });
  });
}

function request(port: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function runnerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${SERVICE_TOKEN}` };
}

async function joinAndStart(port: number, meetingId: string, name: string): Promise<void> {
  expect((await request(port, `/api/meetings/${meetingId}/meeting/open`, 'POST')).status).toBe(200);
  const joined = await request(port, `/api/meetings/${meetingId}/livekit/token`, 'POST', {
    participantName: name,
    participantRole: 'chef',
  });
  expect(joined.status).toBe(200);
  const started = await request(port, `/api/meetings/${meetingId}/meeting/start`, 'POST');
  expect(started.status).toBe(200);
}

async function emitLine(port: number, meetingId: string, speaker: string, text: string): Promise<void> {
  const response = await request(port, `/api/meetings/${meetingId}/runner/emit`, 'POST', {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: { speaker, text, timestamp: new Date().toISOString() },
  }, runnerHeaders());
  expect(response.status).toBe(200);
}

function savedText(store: FakeStateStore, id: string): string {
  return JSON.stringify(store.rows.get(id) ?? {});
}

const apps: KakiApp[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  promptsByMeeting.clear();
  elapsedByMeeting.clear();
});

describe('many meetings at once', () => {
  it('keeps two meetings isolated end to end', async () => {
    const meetings = createMemoryMeetingStore();
    const workspaceTools = createMemoryWorkspaceToolStore();
    await workspaceTools.save(giteaTool('workspace-1'));
    await workspaceTools.save(giteaTool('workspace-2'));
    const state = new FakeStateStore();
    const persistenceFor = async (id: string): Promise<MeetingPersistence | undefined> => {
      const store = state.forId(id);
      return createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    };
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      meetings,
      persistenceFor,
      workspaceTools,
      actionTools: { env: toolEnv },
      meetingModules: fakeModules,
    });
    apps.push(app);
    const port = portOf(app);

    const meetingA = await app.registry.create({
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      title: 'A',
    });
    const meetingB = await app.registry.create({
      workspaceId: 'workspace-2',
      ownerUserId: 'owner-2',
      title: 'B',
    });
    expect(meetingA.id).not.toBe(meetingB.id);

    const instanceA = await app.registry.get(meetingA.id);
    const instanceB = await app.registry.get(meetingB.id);
    if (instanceA === undefined || instanceB === undefined) throw new Error('the meetings did not load');

    const socketA = await connect(port, meetingA.id, '', undefined, 'screen');
    const socketB = await connect(port, meetingB.id, '', undefined, 'screen');
    sockets.push(socketA, socketB);

    await joinAndStart(port, meetingA.id, 'Ana');
    await joinAndStart(port, meetingB.id, 'Ben');

    // 2. A's speech reaches only A; B sees nothing and its notetaker saw none of A's words.
    await emitLine(port, meetingA.id, 'Ana', 'The signup form is broken on mobile.');
    await waitFor(
      () => (promptsByMeeting.get(meetingA.id)?.some((prompt) => prompt.includes('signup form is broken')) ? true : undefined),
      "A's notetaker to see A's line",
    );
    await settle(120);
    expect(promptsByMeeting.get(meetingB.id)?.some((prompt) => prompt.includes('signup form is broken'))).not.toBe(true);
    expect(socketB.messages.some((event) => JSON.stringify(event).includes('signup form is broken'))).toBe(false);
    expect(instanceB.tasks.list()).toHaveLength(0);

    // 3. A suggested task is only A's.
    const suggested = await request(port, `/api/meetings/${meetingA.id}/runner/suggest-task`, 'POST', {
      title: 'Fix the broken signup form',
      context: 'The signup form is broken on mobile.',
      suggestedAssignee: instanceA.session.holders()[0]?.seat,
      actionKind: 'gitea_issue',
    }, runnerHeaders());
    expect(suggested.status).toBe(200);
    const task = (await suggested.json()) as { id: string };
    expect(instanceA.tasks.list().map((candidate) => candidate.id)).toContain(task.id);
    expect(instanceB.tasks.list()).toHaveLength(0);
    await waitFor(
      () => socketA.messages.find((event) => event.type === 'TASK_UPDATED' && event.payload.task?.id === task.id),
      "A's task card",
    );
    expect(socketB.messages.some((event) => event.type === 'TASK_UPDATED')).toBe(false);

    // 4. Ending A leaves B running, and B's clock keeps moving.
    instanceA.session.end();
    await settle(50);
    expect(instanceA.session.phase()).toBe('ended');
    expect(instanceB.session.phase()).toBe('running');
    const elapsedBefore = elapsedByMeeting.get(meetingB.id)?.() ?? 0;
    await waitFor(
      () => ((elapsedByMeeting.get(meetingB.id)?.() ?? 0) > elapsedBefore ? true : undefined),
      "B's clock to keep moving after A ends",
      3_000,
    );

    // 6. A restart rebuilds each meeting from its own saved row, nothing crossed.
    const beforeRestartB = instanceB.tasks.list().length;
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    socketA.close();
    socketB.close();

    const restarted = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      meetings,
      persistenceFor,
      workspaceTools,
      actionTools: { env: toolEnv },
      meetingModules: fakeModules,
    });
    apps.push(restarted);
    const rebuiltA = await restarted.registry.get(meetingA.id);
    const rebuiltB = await restarted.registry.get(meetingB.id);
    if (rebuiltA === undefined || rebuiltB === undefined) throw new Error('the meetings did not rebuild');
    expect(rebuiltA.tasks.list().map((candidate) => candidate.id)).toContain(task.id);
    expect(rebuiltA.tasks.list().map((candidate) => candidate.title)).not.toContain('B task');
    expect(rebuiltB.tasks.list()).toHaveLength(beforeRestartB);
    expect(savedText(state, meetingA.id)).toContain('signup form is broken');
    expect(savedText(state, meetingB.id)).not.toContain('signup form is broken');
  });

  it('tells the runner which meetings are open on the control channel and accepts their service sockets', async () => {
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      meetingModules: fakeModules,
    });
    apps.push(app);
    const port = portOf(app);

    const control = new WebSocket(
      `ws://127.0.0.1:${port}/ws?audience=service-control`,
      { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
    );
    const controlMessages: Array<{ type: string; meetingId?: string; kind?: string; roomName?: string }> = [];
    control.on('message', (data) => controlMessages.push(JSON.parse(data.toString()) as (typeof controlMessages)[number]));
    await new Promise<void>((resolve, reject) => {
      control.once('open', () => resolve());
      control.once('error', reject);
    });
    await waitFor(
      () => controlMessages.find((message) => message.type === 'MEETING_OPENED' && message.meetingId === 'meeting'),
      "the legacy meeting on the control channel",
    );
    expect(controlMessages.find((message) => message.meetingId === 'meeting')).toMatchObject({ kind: 'practice' });

    const meeting = await app.registry.create({ workspaceId: 'w1', ownerUserId: 'o1', title: 'Runner meeting' });
    await app.registry.get(meeting.id);
    const opened = await waitFor(
      () => controlMessages.find((message) => message.type === 'MEETING_OPENED' && message.meetingId === meeting.id),
      'the new meeting on the control channel',
    );
    expect(opened).toMatchObject({ kind: 'real', roomName: `kaki-${meeting.id}` });

    const service = new WebSocket(
      `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(meeting.id)}&audience=service`,
      { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } },
    );
    await new Promise<void>((resolve, reject) => {
      service.once('open', () => resolve());
      service.once('error', reject);
    });
    service.close();

    await app.registry.unload(meeting.id);
    await waitFor(
      () => controlMessages.find((message) => message.type === 'MEETING_CLOSED' && message.meetingId === meeting.id),
      'the closed meeting on the control channel',
    );
    control.close();
  });

  it('refuses a seat from meeting A on meeting B, and an unknown meeting', async () => {
    const store: AuthStore = createMemoryAuthStore();
    const meetingCode = createMeetingCodeSource();
    const auth = createAuth({ store, meetingCode });
    const meetings = createMemoryMeetingStore();
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
      auth,
      meetings,
      meetingModules: fakeModules,
    });
    apps.push(app);
    const port = portOf(app);

    const meetingA = await app.registry.create({ workspaceId: 'w1', ownerUserId: 'o1', title: 'A' });
    const meetingB = await app.registry.create({ workspaceId: 'w2', ownerUserId: 'o2', title: 'B' });
    const token = 'a-seat-token';
    await store.enterSeat({
      meetingId: meetingA.id,
      role: 'chef',
      session: {
        tokenHash: hashToken(token),
        kind: 'participant',
        role: 'chef',
        meetingCode: meetingCode.value,
        meetingId: meetingA.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cookie = `kaki_session=${token}`;

    // The seat works on its own meeting...
    const own = await connect(port, meetingA.id, 'chef', cookie, 'participant');
    sockets.push(own);
    // ...and is refused on the other meeting, over HTTP and the WebSocket upgrade.
    const refusedHttp = await request(port, `/api/meetings/${meetingB.id}/meeting/participants`, 'GET', undefined, { cookie });
    expect(refusedHttp.status).toBe(401);
    await expect(connect(port, meetingB.id, 'chef', cookie, 'participant')).rejects.toThrow();

    const unknownHttp = await request(port, '/api/meetings/does-not-exist/meeting/state');
    expect(unknownHttp.status).toBe(404);
    expect(await unknownHttp.json()).toMatchObject({ error: 'meeting-not-found' });
    await expect(connect(port, 'does-not-exist', 'chef')).rejects.toThrow();
  });

  it('refuses a second practice start while the legacy practice meeting is running', async () => {
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
    });
    apps.push(app);
    const port = portOf(app);

    const first = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Ana',
      participantRole: 'chef',
      kind: 'practice',
    });
    expect(first.status).toBe(200);
    // This app has sign-in off; a practice meeting can start without a runner because browser
    // recognition is enabled.
    expect((await request(port, '/api/meeting/start', 'POST')).status).toBe(200);

    const second = await request(port, '/api/livekit/token', 'POST', {
      participantName: 'Ben',
      participantRole: 'chef',
      kind: 'practice',
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: 'practice-busy',
      message:
        'Someone is using the practice meeting right now. It frees up when they finish, usually within 15 minutes.',
    });
  });
});
