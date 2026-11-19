import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createMeetingModule } from '../../src/host/meeting';
import { createMeetingPersistence, type MeetingPersistence } from '../../src/persist/persistence';
import {
  assertCompatibleSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  type MeetingStateStore,
  type StoredMeeting,
} from '../../src/persist/state';
import type { KakiApp } from '../../src/app';
import { connectClient, createTestApp, portOf, waitFor, waitForEvent, type TestClient } from '../helpers';

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

const apps: KakiApp[] = [];
const clients: TestClient[] = [];

// These tests drive the task lifecycle themselves; Sam must not dispatch the cards underneath them.
beforeAll(() => {
  process.env.KAKI_AUTO_DISPATCH = '0';
});

afterAll(() => {
  delete process.env.KAKI_AUTO_DISPATCH;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.close();
});

async function startApp(persistence: MeetingPersistence): Promise<KakiApp> {
  const app = await createTestApp({
    modules: [createMeetingModule({ notetakerIntervalMs: 60_000 })],
    persistence,
  });
  apps.push(app);
  return app;
}

async function connectScreen(app: KakiApp): Promise<TestClient> {
  const client = await connectClient(portOf(app), 'screen');
  clients.push(client);
  return client;
}

function say(app: KakiApp, speaker: string, text: string): void {
  app.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { speaker, text, timestamp: new Date().toISOString() },
  });
}

function isRecord(event: KakiEvent): boolean {
  return event.type === 'MEETING_RECORD_UPDATED';
}

describe('meeting persistence across a restart', () => {
  it('restores the record, notetaker progress and tasks, and keeps tracking new talk', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);

    say(app1, 'Ada (Chef)', 'The oven trips the fuse again, it has been happening all morning.');
    say(app1, 'Bao (Cashier)', 'I will check the temperature log before service.');
    const open = app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    const interrupted = app1.tasks.suggest({
      title: 'Email the supplier',
      context: 'The oven part is late.',
      suggestedAssignee: 'chef',
      actionKind: 'email',
    });
    app1.tasks.transition(interrupted.id, 'DISPATCHED', { assignee: 'chef' });
    app1.tasks.transition(interrupted.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    app1.tasks.transition(interrupted.id, 'DRAFT_READY', {
      draft: { target: 'supplier@example.test', subject: 'Part', body: 'When is it coming?' },
    });
    app1.tasks.transition(interrupted.id, 'RUNNING');

    await first.flush();
    const frozen = store.saved;
    expect(frozen).toBeDefined();
    expect(frozen!.state.clock.started).toBe(true);
    expect(frozen!.state.notetaker.talkTotal).toBeGreaterThan(0);
    expect(frozen!.state.tasks).toHaveLength(2);

    await app1.close();
    apps.splice(apps.indexOf(app1), 1);

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second);
    const screen = await connectScreen(app2);

    const restored = await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');
    expect(restored.type === 'MEETING_RESTORED' && restored.payload.startedAt).toBe(frozen!.startedAt);

    const record = await waitFor(
      () => screen.messages.filter(isRecord).at(-1) as Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> | undefined,
      'restored meeting record',
    );
    expect(record.payload.speakerTalkSeconds.chef).toBeGreaterThan(0);
    expect(record.payload.speakerTalkSeconds.cashier).toBeGreaterThan(0);

    expect(app2.tasks.get(open.id)?.status).toBe('SUGGESTED');
    const failed = app2.tasks.get(interrupted.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toBe('Kaki restarted while this was running — tap Retry.');

    // The notetaker carries on from the restored talk time instead of starting from nothing.
    say(
      app2,
      'Ada (Chef)',
      'I have also asked the supplier to call us back this afternoon, and I told them that if the part ' +
        'does not arrive before the lunch rush we will borrow the spare tray warmer from the branch next ' +
        'door, so the front counter keeps moving and nobody has to wait outside in the queue while we ' +
        'sort the oven out properly with the electrician on Monday morning.',
    );
    const later = await waitFor(
      () => {
        const latest = screen.messages.filter(isRecord).at(-1) as
          | Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>
          | undefined;
        return latest !== undefined && (latest.payload.speakerTalkSeconds.chef ?? 0) > (record.payload.speakerTalkSeconds.chef ?? 0)
          ? latest
          : undefined;
      },
      'talk time to keep growing',
    );
    expect(later.payload.agendaIndex).toBe(record.payload.agendaIndex);
  });

  it('clears the saved meeting when the host starts a new one', async () => {
    const store = new MemoryStore();
    const first = createMeetingPersistence({ store, log: () => undefined });
    const app1 = await startApp(first);
    say(app1, 'Ada (Chef)', 'The oven trips the fuse again.');
    app1.tasks.suggest({
      title: 'Call the oven repair man',
      context: 'The oven trips the fuse.',
      suggestedAssignee: 'chef',
    });
    await first.flush();
    const frozen = store.saved!;

    const second = createMeetingPersistence({ store, saved: await store.load(), log: () => undefined });
    const app2 = await startApp(second);
    const screen = await connectScreen(app2);
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESTORED', 'restored notice');

    screen.ws.send(JSON.stringify({ type: 'NEW_MEETING' }));
    await waitForEvent(screen, (event) => event.type === 'MEETING_RESET', 'reset');

    await waitFor(() => (store.saved === undefined ? true : undefined), 'saved meeting to be cleared');
    expect(app2.tasks.list()).toEqual([]);

    say(app2, 'Ada (Chef)', 'A fresh meeting starts here.');
    await waitFor(() => (store.saved !== undefined ? true : undefined), 'the new meeting to be saved');
    expect(store.saved!.startedAt).not.toBe(frozen.startedAt);
  });

  it('refuses a saved meeting from another format with a clear message', () => {
    const saved: StoredMeeting = {
      schemaVersion: MEETING_STATE_SCHEMA_VERSION - 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      savedAt: '2026-01-01T00:00:00.000Z',
      state: {
        clock: {
          started: true,
          ended: false,
          paused: false,
          agendaIndex: 0,
          itemElapsedSeconds: 0,
          meetingElapsedSeconds: 0,
        },
        notetaker: {
          pending: [],
          recentGrounded: [],
          contextAgendaIndex: 0,
          agendaContext: [],
          openQuestions: [],
          questionCount: 0,
          status: 'ok',
          talkByItem: [],
          talkTotals: [],
          talkTotal: 0,
        },
        tasks: [],
      },
    };

    expect(() => assertCompatibleSavedMeeting(saved)).toThrow(
      `Saved meeting is from an older format (v${MEETING_STATE_SCHEMA_VERSION - 1}, need v${MEETING_STATE_SCHEMA_VERSION}). ` +
        'Run `npm run meeting:reset` to discard it.',
    );
  });
});
