import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { createApp, type CreateAppOptions, type KakiApp } from '../src/app';
import type { KakiModule } from '../src/core/modules';
import type { MeetingPauseControl } from '../src/host';
import type { MeetingInstance } from '../src/meeting/instance';
import type { MeetingRow } from '../src/meeting/types';
import type { MeetingModules } from '../src/modules';
import { testScenario } from './fixtures/scenario';

/** A connected test socket and the events it has received. */
export interface TestClient {
  ws: WebSocket;
  messages: KakiEvent[];
  close(): void;
}

/** Create a listening app with the test-kitchen scenario unless told otherwise. */
export function createTestApp(
  options: Omit<CreateAppOptions, 'scenario'> & { scenario?: Scenario } = {},
): Promise<KakiApp> {
  // Tests that need a meeting module inject it; by default a meeting runs none, as the old shared
  // instance did, so a test's own task lifecycle is never changed underneath it.
  return createApp({
    speechRecognition: 'browser',
    meetingModules: realModulesWith([]),
    practiceModules: practiceModulesWith([]),
    ...options,
    scenario: options.scenario ?? testScenario,
  });
}

/** Read the OS-assigned port from a listening test server. */
export function portOf(app: KakiApp): number {
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to listen on a TCP port');
  }
  return address.port;
}

/** Connect a test client as the screen or a role and collect its messages. */
export function connectClient(port: number, role?: string): Promise<TestClient> {
  const query = role === undefined ? '' : `?role=${encodeURIComponent(role)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const messages: KakiEvent[] = [];

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as KakiEvent);
  });

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, close: () => ws.close() }));
    ws.once('error', reject);
  });
}

/** Wait briefly so a negative delivery assertion can be trusted. */
export function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until a check returns a value, then return it; fail loudly on timeout. */
export async function waitFor<T>(
  check: () => T | undefined,
  label = 'condition',
  timeoutMs = 4_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value !== undefined) return value;
    await settle(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Wait for the first event on a client that matches a predicate. */
export function waitForEvent(
  client: TestClient,
  predicate: (event: KakiEvent) => boolean,
  label = 'event',
  timeoutMs = 4_000,
): Promise<KakiEvent> {
  return waitFor(() => client.messages.find(predicate), label, timeoutMs);
}

/** The statuses of every TASK_UPDATED a client saw for one task. */
export function taskStatuses(client: TestClient, taskId: string): string[] {
  return client.messages.flatMap((event) =>
    event.type === 'TASK_UPDATED' && event.payload.task.id === taskId
      ? [event.payload.task.status]
      : [],
  );
}

/** One registry meeting a test acts on, with the parts the old shared instance used to expose. */
export interface TestMeeting {
  id: string;
  instance: MeetingInstance;
  hub: MeetingInstance['hub'];
  tasks: MeetingInstance['tasks'];
  session: MeetingInstance['session'];
  memory: MeetingInstance['memory'];
  roomName: string;
  /** The practice visitor's capability cookie; absent for a real meeting. */
  cookie?: string;
}

function wrapMeeting(instance: MeetingInstance, cookie?: string): TestMeeting {
  return {
    id: instance.id,
    instance,
    hub: instance.hub,
    tasks: instance.tasks,
    session: instance.session,
    memory: instance.memory,
    roomName: instance.roomName,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

/** The canonical path of one meeting route: every meeting lives under `/api/meetings/:id`. */
export function meetingPath(meeting: { id: string } | string, path: string): string {
  const id = typeof meeting === 'string' ? meeting : meeting.id;
  const rest = path.startsWith('/api') ? path.slice(4) : path;
  return `/api/meetings/${encodeURIComponent(id)}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

/** The absolute URL of one meeting route, for a server listening on `app`. */
export function meetingUrl(app: KakiApp, meeting: { id: string } | string, path: string): string {
  return `http://127.0.0.1:${portOf(app)}${meetingPath(meeting, path)}`;
}

/** Create a real meeting row and load its instance; every owner route is open when sign-in is off. */
export async function openRealMeeting(
  app: KakiApp,
  options: {
    workspaceId?: string;
    ownerUserId?: string;
    title?: string;
    agenda?: MeetingRow['agenda'];
  } = {},
): Promise<TestMeeting> {
  const row = await app.registry.create({
    workspaceId: options.workspaceId ?? 'workspace-1',
    ownerUserId: options.ownerUserId ?? 'test-owner',
    title: options.title ?? 'Test meeting',
    ...(options.agenda === undefined ? {} : { agenda: options.agenda }),
  });
  const instance = await app.registry.get(row.id);
  if (instance === undefined) throw new Error(`the real meeting ${row.id} did not load`);
  return wrapMeeting(instance);
}

/** Create one visitor's practice meeting and the cookie that names it. */
export async function openPracticeMeeting(app: KakiApp): Promise<TestMeeting> {
  const instance = await app.registry.createPractice();
  const capability = randomUUID();
  instance.session.beginPractice({ token: capability });
  return wrapMeeting(instance, `kaki_practice=${instance.id}.${capability}`);
}

/** The LiveKit/command WebSocket URL for one meeting's audience or role. */
export function meetingWsUrl(
  port: number,
  meeting: { id: string } | string,
  query: string,
): string {
  const id = typeof meeting === 'string' ? meeting : meeting.id;
  return `ws://127.0.0.1:${port}/ws?meeting=${encodeURIComponent(id)}&${query}`;
}

/** A pause control that never pauses, for injected test modules. */
export function noMeetingPause(): MeetingPauseControl {
  return {
    paused: () => undefined,
    kind: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  };
}

/** Fresh modules for every practice meeting, with the test's own module list. */
export function practiceModulesWith(
  modules: KakiModule[],
  extras: Partial<MeetingModules> = {},
): () => MeetingModules {
  return () => ({
    modules,
    meetingElapsedSeconds: () => undefined,
    meetingAgendaIndex: () => undefined,
    meetingPaused: () => undefined,
    meetingPause: noMeetingPause(),
    ...extras,
  });
}

/** Fresh modules for every real meeting, with the test's own module list. */
export function realModulesWith(
  modules: KakiModule[],
  extras: Partial<MeetingModules> = {},
): (row: MeetingRow) => MeetingModules {
  return () => ({
    modules,
    meetingElapsedSeconds: () => undefined,
    meetingAgendaIndex: () => undefined,
    meetingPaused: () => undefined,
    meetingPause: noMeetingPause(),
    ...extras,
  });
}

/** A test app whose registry already holds one meeting, with that meeting's parts on the app. */
export type TestAppWithMeeting = KakiApp & TestMeeting & { meetingId: string };

/** The app plus one practice meeting, so tests act on a real per-visitor instance. */
export async function createPracticeTestApp(
  options: Omit<CreateAppOptions, 'scenario'> & { scenario?: Scenario } = {},
): Promise<TestAppWithMeeting> {
  const app = (await createTestApp(options)) as TestAppWithMeeting;
  const meeting = await openPracticeMeeting(app);
  return Object.assign(app, meeting, { meetingId: meeting.id });
}

/** The app plus one real meeting row and its instance. */
export async function createRealTestApp(
  options: Omit<CreateAppOptions, 'scenario'> & { scenario?: Scenario } = {},
  meetingOptions: Parameters<typeof openRealMeeting>[1] = {},
): Promise<TestAppWithMeeting> {
  const app = (await createTestApp(options)) as TestAppWithMeeting;
  const meeting = await openRealMeeting(app, meetingOptions);
  return Object.assign(app, meeting, { meetingId: meeting.id });
}

/** Connect a test client to one meeting's screen or role. */
export function connectMeetingClient(
  port: number,
  meeting: { id: string } | string,
  role?: string,
): Promise<TestClient> {
  const query = role === undefined ? 'audience=screen' : `role=${encodeURIComponent(role)}`;
  const ws = new WebSocket(meetingWsUrl(port, meeting, query));
  const messages: KakiEvent[] = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as KakiEvent);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, close: () => ws.close() }));
    ws.once('error', reject);
  });
}
