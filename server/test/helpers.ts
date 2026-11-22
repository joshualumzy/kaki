import WebSocket from 'ws';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type CreateAppOptions, type KakiApp } from '../src/app';
import { testScenario } from './fixtures/scenario';

/** A connected test socket and the events it has received. */
export interface TestClient {
  ws: WebSocket;
  messages: KakiEvent[];
  close(): void;
}

/** Create a listening app with the test-kitchen scenario unless told otherwise. */
export function createTestApp(options: Omit<CreateAppOptions, 'scenario'> = {}): Promise<KakiApp> {
  return createApp({ speechRecognition: 'browser', ...options, scenario: testScenario });
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
