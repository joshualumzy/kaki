import { afterEach, describe, expect, it } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createAuth } from '../../src/auth/module';
import { hashPassword } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createMeetingCodeSource } from '../../src/meetingCode';
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
    const auth = createAuth({ store, roles: ['chef', 'cashier'], meetingCode });
    app = await createApp({
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

  it('does not reach a service route without the credential', async () => {
    const started = await authApp();
    const anonymous = createRunnerClient({ baseUrl: started.baseUrl });
    expect((await anonymous.emit(transcript)).status).toBe(401);
    await expect(anonymous.fetchScenario()).rejects.toThrow(/HTTP 401/);
  });
});
