import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { createRunnerClient } from '../../src/npc/runnerClient';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'correct-horse-battery';
const MEETING_CODE = 'K7M2Q9';
const SERVICE_TOKEN = 'runner-secret';

const transcript = {
  type: 'TRANSCRIPT_CHUNK',
  audience: { kind: 'all' },
  payload: { speaker: 'Ada', text: 'Hello', timestamp: new Date().toISOString() },
} as const;

const suggestion = {
  title: 'Order stock',
  context: 'Lunch prep',
  suggestedAssignee: 'chef',
  agendaItemTitle: 'Prep',
};

describe('the AI runner HTTP client', () => {
  let app: KakiApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  async function authApp(): Promise<{ app: KakiApp; baseUrl: string }> {
    const store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource(MEETING_CODE);
    const auth = createAuth({ store, offeredRoles: () => ['chef', 'cashier'], meetingCode });
    app = await createApp({
      speechRecognition: 'browser',
      scenario: testScenario,
      auth,
      meetingCode,
      serviceToken: SERVICE_TOKEN,
      roomRoster: async () => [],
    });
    return { app, baseUrl: `http://127.0.0.1:${portOf(app)}` };
  }

  it('sends every read and write with the service credential', async () => {
    const started = await authApp();
    const client = createRunnerClient({ baseUrl: started.baseUrl, serviceToken: SERVICE_TOKEN });
    const events: KakiEvent[] = [];
    started.app.hub.subscribe((event) => events.push(event));

    expect((await client.emit(transcript)).status).toBe(200);
    expect(events.find((event) => event.type === 'TRANSCRIPT_CHUNK')).toEqual(transcript);

    expect((await client.suggestTask(suggestion)).status).toBe(200);
    expect(started.app.tasks.list().some((task) => task.title === 'Order stock')).toBe(true);

    const memory = [{ kind: 'decision', item: 'Prep', text: 'Order stock' }] as const;
    await client.postMeetingMemory(memory);
    expect(started.app.memory).toEqual(memory);

    await client.postSettledTopic({ ...suggestion, title: 'Publish the stock list' });
    expect(started.app.tasks.list().some((task) => task.title === 'Publish the stock list')).toBe(true);

    const state = await client.fetchMeetingState();
    expect(state.meetingId).toBe(
      ((await (await fetch(`${started.baseUrl}/api/meeting/state`)).json()) as { meetingId: string }).meetingId,
    );
    const scenario = await client.fetchScenario();
    expect(scenario.id).toBe(testScenario.id);
  });

  it('retries a recognised line with the same id on network errors and a retryable conflict', async () => {
    const line = {
      meetingId: 'meeting-1',
      participantIdentity: 'Ada',
      seat: 'chef',
      text: 'The till is short.',
      source: 'speech' as const,
      clientLineId: 'same-id',
    };
    const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const retryable = () =>
      new Response(JSON.stringify({ error: 'The meeting is starting', retryable: true }), { status: 409 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(retryable())
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    const client = createRunnerClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: fetchMock,
      sleep,
      humanLineRetryBaseMs: 10,
    });

    const response = await client.postHumanLine(line);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ clientLineId: 'same-id' });
    }
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('drops a recognised line after the last attempt and does not retry a final conflict', async () => {
    const line = {
      meetingId: 'meeting-1',
      participantIdentity: 'Ada',
      seat: 'chef',
      text: 'The till is short.',
      source: 'speech' as const,
      clientLineId: 'same-id',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'));
    const client = createRunnerClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: fetchMock,
      sleep: async () => undefined,
    });
    await expect(client.postHumanLine(line)).rejects.toThrow(/offline/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const conflict = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'That line belongs to a different meeting' }), { status: 409 }));
    const second = createRunnerClient({ baseUrl: 'http://127.0.0.1:1', fetch: conflict, sleep: async () => undefined });
    expect((await second.postHumanLine(line)).status).toBe(409);
    expect(conflict).toHaveBeenCalledTimes(1);
  });

  it('does not reach a service route without the credential', async () => {
    const started = await authApp();
    const anonymous = createRunnerClient({ baseUrl: started.baseUrl });
    expect((await anonymous.emit(transcript)).status).toBe(401);
    await expect(anonymous.fetchMeetingState()).rejects.toThrow(/HTTP 401/);
    await expect(anonymous.fetchScenario()).rejects.toThrow(/HTTP 401/);
  });
  it('calls a real meeting through /api/meetings/<id>/runner/..., not /api/meetings/<id>/api/runner/...', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = createRunnerClient({
      baseUrl: 'http://kaki.test',
      apiPrefix: '/api/meetings/m1',
      serviceToken: SERVICE_TOKEN,
      fetch: fakeFetch,
    });
    await client.emit(transcript);
    await client.fetchMeetingState().catch(() => undefined);
    await client.fetchScenario().catch(() => undefined);
    expect(urls).toEqual([
      'http://kaki.test/api/meetings/m1/runner/emit',
      'http://kaki.test/api/meetings/m1/runner/meeting-state',
      'http://kaki.test/api/meetings/m1/scenario/full',
    ]);
  });
});
