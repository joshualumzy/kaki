import { describe, expect, it } from 'vitest';
import { createMeetingPersistence } from '../../src/persist/persistence';
import type { MeetingStateStore, SavedMeetingState, StoredMeeting } from '../../src/persist/state';

function stateWithAgenda(agendaIndex: number): SavedMeetingState {
  return {
    clock: {
      started: true,
      ended: false,
      paused: false,
      agendaIndex,
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
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class SlowStore implements MeetingStateStore {
  saves: StoredMeeting[] = [];
  saved: StoredMeeting | undefined;
  inFlight = 0;
  maxInFlight = 0;
  private first = true;
  private readonly firstGate = deferred();

  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }

  async save(meeting: StoredMeeting): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.saves.push(meeting);
    if (this.first) {
      this.first = false;
      await this.firstGate.promise;
    } else {
      await Promise.resolve();
    }
    this.inFlight -= 1;
    this.saved = meeting;
  }

  async clear(): Promise<void> {
    this.saved = undefined;
  }

  releaseFirst(): void {
    this.firstGate.resolve();
  }
}

class FailingStore implements MeetingStateStore {
  saves = 0;

  async load(): Promise<StoredMeeting | undefined> {
    return undefined;
  }

  async save(): Promise<void> {
    this.saves += 1;
    throw new Error('database is down');
  }

  async clear(): Promise<void> {}
}

describe('meeting persistence saver', () => {
  it('writes once for a burst of changes and keeps the latest state', async () => {
    const store = new SlowStore();
    let agendaIndex = 0;
    const persistence = createMeetingPersistence({
      store,
      log: () => undefined,
    });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(agendaIndex) }));

    persistence.scheduleSave();
    persistence.scheduleSave();
    persistence.scheduleSave();
    await Promise.resolve();
    expect(store.saves).toHaveLength(1);

    // A change while the first write is in flight is saved next, not alongside it.
    agendaIndex = 2;
    persistence.scheduleSave();
    persistence.scheduleSave();
    expect(store.saves).toHaveLength(1);

    store.releaseFirst();
    await persistence.flush();

    expect(store.saves).toHaveLength(2);
    expect(store.saves[1]?.state.clock.agendaIndex).toBe(2);
    expect(store.maxInFlight).toBe(1);
  });

  it('logs a failed save every time and never throws at the caller', async () => {
    const store = new FailingStore();
    const logs: string[] = [];
    const persistence = createMeetingPersistence({
      store,
      log: (message) => logs.push(message),
    });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(0) }));

    persistence.scheduleSave();
    await expect(persistence.flush()).resolves.toBeUndefined();
    expect(store.saves).toBe(1);
    expect(logs).toEqual(['[persist] save failed: database is down']);

    persistence.scheduleSave();
    await persistence.flush();
    expect(store.saves).toBe(2);
    expect(logs).toEqual(['[persist] save failed: database is down', '[persist] save failed: database is down']);
  });

  it('skips writing until the meeting has started', async () => {
    const store = new SlowStore();
    store.releaseFirst();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    persistence.registerSource(() => undefined);

    persistence.scheduleSave();
    await persistence.flush();

    expect(store.saves).toHaveLength(0);
  });

  it('cancels a queued save and clears after a write already in flight', async () => {
    const store = new SlowStore();
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(0) }));

    persistence.scheduleSave();
    await Promise.resolve();
    expect(store.saves).toHaveLength(1);

    const cleared = persistence.clearSaved();
    store.releaseFirst();
    await cleared;
    await persistence.flush();

    expect(store.saves).toHaveLength(1);
    expect(store.saved).toBeUndefined();
  });
});
