import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerMeetingSnapshot } from '@kaki/shared';
import { createApp, type KakiApp } from '../src/app';
import { createMeetingModule } from '../src/host/meeting';
import { createMeetingPersistence } from '../src/persist/persistence';
import type { MeetingStateStore, StoredMeeting } from '../src/persist/state';
import { loadScenario } from '../src/loadScenario';
import { portOf } from './helpers';

const TOKEN = 'runner-revision-token';
const apps: KakiApp[] = [];

class MemoryStore implements MeetingStateStore {
  saved: StoredMeeting | undefined;
  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }
  async save(meeting: StoredMeeting): Promise<void> {
    this.saved = meeting;
  }
  async clear(): Promise<void> {
    this.saved = undefined;
  }
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function openApp(store: MemoryStore): Promise<{
  app: KakiApp;
  persistence: ReturnType<typeof createMeetingPersistence>;
}> {
  const persistence = createMeetingPersistence({ store, saved: store.saved, log: () => undefined });
  const app = await createApp({
    scenario: await loadScenario('kopitiam'),
    serviceToken: TOKEN,
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    persistence,
    roomRoster: async () => [],
  });
  apps.push(app);
  return { app, persistence };
}

async function stateOf(app: KakiApp): Promise<RunnerMeetingSnapshot> {
  const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/runner/meeting-state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerMeetingSnapshot;
}

describe('the runner snapshot revision across restarts', () => {
  it('continues a saved meeting revision, and a fresh server starts a new meeting sequence', async () => {
    const store = new MemoryStore();
    const first = await openApp(store);
    const firstState = await stateOf(first.app);
    first.persistence.scheduleSave();
    await first.persistence.flush();
    expect(store.saved?.runnerRevision).toBe(firstState.version);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const restored = await openApp(store);
    const restoredState = await stateOf(restored.app);
    expect(restoredState.meetingId).toBe(firstState.meetingId);
    expect(restoredState.version).toBeGreaterThan(firstState.version);

    const fresh = await openApp(new MemoryStore());
    const freshState = await stateOf(fresh.app);
    expect(freshState.meetingId).not.toBe(firstState.meetingId);
    expect(freshState.version).toBeLessThan(restoredState.version);
  });
});
