import { describe, expect, it } from 'vitest';
import { createMeetingPersistence } from '../../src/persist/persistence';
import type { MeetingStateStore, SavedMeetingState, StoredMeeting } from '../../src/persist/state';

function stateWithAgenda(agendaIndex: number): SavedMeetingState {
  return {
    meetingId: 'meeting-1',
    agenda: ['Prep', 'Service', 'Close'],
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
      inFlight: [],
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

class OrderedStore implements MeetingStateStore {
  saved: StoredMeeting | undefined;
  events: string[] = [];
  clearFailures = 0;
  private readonly gate = deferred();
  private first = true;

  async load(): Promise<StoredMeeting | undefined> {
    return this.saved;
  }

  async save(meeting: StoredMeeting): Promise<void> {
    this.events.push(`save:${meeting.state.clock.agendaIndex}`);
    if (this.first) {
      this.first = false;
      await this.gate.promise;
    }
    this.saved = meeting;
  }

  async clear(): Promise<void> {
    if (this.clearFailures > 0) {
      this.clearFailures -= 1;
      this.events.push('clear:failed');
      throw new Error('database is down');
    }
    this.events.push('clear');
    this.saved = undefined;
  }

  releaseFirst(): void {
    this.gate.resolve();
  }
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

  it('keeps save and clear in call order, so a new meeting is not cleared by an earlier reset', async () => {
    const store = new OrderedStore();
    let agendaIndex = 0;
    const persistence = createMeetingPersistence({ store, log: () => undefined });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(agendaIndex) }));

    persistence.scheduleSave();
    await Promise.resolve();
    expect(store.events).toEqual(['save:0']);

    // The old meeting is still being written when the host starts a new one and the new meeting speaks.
    agendaIndex = 1;
    const cleared = persistence.clearSaved();
    agendaIndex = 2;
    persistence.scheduleSave();

    store.releaseFirst();
    await cleared;
    await persistence.flush();

    expect(store.events).toEqual(['save:0', 'clear', 'save:2']);
    expect(store.saved?.state.clock.agendaIndex).toBe(2);
  });

  it('retries a failed clear before any later save and reports the failure to its caller', async () => {
    const store = new OrderedStore();
    store.releaseFirst();
    const logs: string[] = [];
    let agendaIndex = 0;
    const persistence = createMeetingPersistence({ store, log: (message) => logs.push(message) });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(agendaIndex) }));

    persistence.scheduleSave();
    await persistence.flush();
    expect(store.events).toEqual(['save:0']);

    store.clearFailures = 1;
    await expect(persistence.clearSaved()).rejects.toThrow('database is down');
    expect(store.events).toEqual(['save:0', 'clear:failed']);

    // The next save must clear first; otherwise the discarded meeting would come back.
    agendaIndex = 2;
    persistence.scheduleSave();
    await persistence.flush();

    expect(store.events).toEqual(['save:0', 'clear:failed', 'clear', 'save:2']);
    expect(store.saved?.state.clock.agendaIndex).toBe(2);
    expect(logs).toContain('[persist] clear failed: database is down');
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

  it('retries a failed clear once when flushing, so shutdown can still clear the saved meeting', async () => {
    const store = new OrderedStore();
    store.releaseFirst();
    const logs: string[] = [];
    const persistence = createMeetingPersistence({ store, log: (message) => logs.push(message) });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(0) }));

    persistence.scheduleSave();
    await persistence.flush();
    store.clearFailures = 1;
    await expect(persistence.clearSaved()).rejects.toThrow('database is down');

    // The retry at shutdown succeeds, so the discarded meeting does not come back.
    await persistence.flush();

    expect(store.events).toEqual(['save:0', 'clear:failed', 'clear']);
    expect(store.saved).toBeUndefined();
    expect(logs).not.toContain(
      'kaki persist: could not clear the saved meeting; it will be restored on next start. Run npm run meeting:reset to discard it.',
    );
  });

  it('logs loudly when the clear still fails while closing', async () => {
    const store = new OrderedStore();
    store.releaseFirst();
    const logs: string[] = [];
    const persistence = createMeetingPersistence({ store, log: (message) => logs.push(message) });
    persistence.registerSource(() => ({ startedAt: '2026-01-01T00:00:00.000Z', state: stateWithAgenda(0) }));

    persistence.scheduleSave();
    await persistence.flush();
    store.clearFailures = 1;
    await expect(persistence.clearSaved()).rejects.toThrow('database is down');
    store.clearFailures = 1;

    await persistence.close();

    expect(store.events).toEqual(['save:0', 'clear:failed', 'clear:failed']);
    expect(store.saved).toBeDefined();
    expect(logs).toContain(
      'kaki persist: could not clear the saved meeting; it will be restored on next start. Run npm run meeting:reset to discard it.',
    );
  });
});
