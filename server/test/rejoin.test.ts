import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admission,
  createRejoinGuard,
  createRoomPoll,
  EMPTY_ROOM_PAUSE_MS,
  roomPollIntervalMs,
  REJOIN_POLL_MS,
  RUNNING_ROOM_POLL_MS,
  type AdmissionInput,
  type SeatHolder,
} from '../src/rejoin';

const ada: SeatHolder = { name: 'ada', seat: 'chef' };

function decide(overrides: Partial<AdmissionInput> = {}): string {
  return admission({
    phase: 'running',
    holders: [ada],
    present: [],
    name: 'Ada',
    seat: 'chef',
    graceActive: true,
    ...overrides,
  });
}

describe('admission decision', () => {
  it.each([
    ['the first person ever', { phase: 'lobby', holders: [], graceActive: false }, 'reset'],
    ['a holder returning before Start', { phase: 'lobby', holders: [ada] }, 'resume'],
    ['a stranger before Start', { phase: 'lobby', holders: [ada], name: 'Priya', seat: 'cashier' }, 'reset'],
    ['someone joining an occupied lobby', { phase: 'lobby', present: [{ name: 'Ada' }] }, 'join'],
    ['a holder coming back inside the grace', { phase: 'running' }, 'resume'],
    ['a holder coming back after the grace', { phase: 'running', graceActive: false }, 'reset'],
    ['a stranger inside the grace', { phase: 'running', name: 'Priya', seat: 'cashier' }, 'reset'],
    ['a stranger after the grace', { phase: 'running', name: 'Priya', seat: 'cashier', graceActive: false }, 'reset'],
    ['someone joining a running room with people', { phase: 'running', present: [{ name: 'Ada' }] }, 'join'],
    ['a saved running meeting with no holders', { phase: 'running', holders: [] }, 'resume'],
    ['a running meeting after its holders were pruned', { phase: 'running', holders: [], graceActive: false }, 'reset'],
    ['a holder returning to an abandoned meeting', { phase: 'running', abandoned: true }, 'reset'],
    ['a stranger at an abandoned meeting with no holders', { phase: 'running', holders: [], abandoned: true }, 'reset'],
    ['anyone after the meeting ended', { phase: 'ended' }, 'reset'],
    ['someone joining people still in an ended meeting', { phase: 'ended', present: [{ name: 'Ada' }] }, 'join'],
    ['a holder while a Start is in flight', { phase: 'starting' }, 'resume'],
  ] as const)('gives %s', (_label, overrides, expected) => {
    expect(decide(overrides as Partial<AdmissionInput>)).toBe(expected);
  });

  it('matches a holder by name even when they take another seat', () => {
    expect(decide({ seat: 'cashier' })).toBe('resume');
  });
});

function guardWith(graceMs: number, clock: { now: number }, logs: string[] = []) {
  return createRejoinGuard({ graceMs, now: () => clock.now, log: (line) => logs.push(line) });
}

describe('rejoin grace', () => {
  it('starts a grace window when the room empties and holds it for a known holder', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(120_000, clock, logs);

    guard.emptied();

    expect(guard.isEmpty()).toBe(true);
    expect(guard.graceActive()).toBe(true);
    expect(logs).toContain('[rejoin] grace started');
    expect(decide({ graceActive: guard.wouldHold() })).toBe('resume');
    guard.close();
  });

  it('treats an unobserved empty room as a fresh grace window for the join race', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(120_000, clock, logs);

    expect(guard.wouldHold()).toBe(true);
    guard.beginGrace();
    guard.joined();

    expect(logs).toContain('[rejoin] grace started');
    expect(logs).toContain('[rejoin] resumed after 0 s');
    expect(guard.isEmpty()).toBe(false);
    guard.close();
  });

  it('expires the window, prunes on the hook and refuses the holder afterwards', async () => {
    const guard = createRejoinGuard({ graceMs: 10, log: () => undefined });
    let pruned = 0;
    guard.onGraceExpired(() => {
      pruned += 1;
    });
    guard.emptied();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(guard.graceActive()).toBe(false);
    expect(guard.wouldHold()).toBe(false);
    expect(decide({ graceActive: guard.wouldHold() })).toBe('reset');
    guard.close();
    expect(pruned).toBe(1);
  });

  it('logs when the window expires so the reset is not a surprise', async () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(10, clock, logs);
    guard.emptied();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logs).toContain('[rejoin] grace expired, reset on next join');
    guard.close();
  });

  it('cancels the window when people are back', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.emptied();
    guard.occupied();

    expect(guard.isEmpty()).toBe(false);
    expect(guard.graceActive()).toBe(false);
    guard.close();
  });

  it('resets as soon as someone joins an empty room when the grace is 0', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(0, clock, logs);
    guard.emptied();

    expect(guard.wouldHold()).toBe(false);
    expect(decide({ graceActive: guard.wouldHold() })).toBe('reset');
    expect(logs).toEqual([]);
    guard.close();
  });

  it('forgets the window on a new meeting without pruning', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(10, clock);
    let pruned = 0;
    guard.onGraceExpired(() => {
      pruned += 1;
    });
    guard.emptied();
    guard.reset();

    expect(guard.isEmpty()).toBe(false);
    guard.close();
    expect(pruned).toBe(0);
  });
});

describe('room poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => vi.useRealTimers());

  function setup(roster: () => Array<{ name: string }> | undefined, graceMs = 120_000) {
    const logs: string[] = [];
    const guard = createRejoinGuard({ graceMs, log: (line) => logs.push(line) });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => true,
      roster: async () => roster(),
      roomName: () => 'kopitiam',
      isHuman: (name) => name !== 'Sam',
      intervalMs: 5_000,
    });
    poll.start();
    return { guard, poll, logs };
  }

  it('sees an empty room and keeps the meeting for the same person inside the window', async () => {
    const { guard, poll, logs } = setup(() => []);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(logs).toContain('[rejoin] grace started');
    expect(decide({ graceActive: guard.wouldHold() })).toBe('resume');
    poll.close();
    guard.close();
  });

  it('clears the window when a person is back in the room', async () => {
    let people: Array<{ name: string }> = [];
    const { guard, poll, logs } = setup(() => people);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logs).toContain('[rejoin] grace started');

    people = [{ name: 'Daniel' }];
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(guard.isEmpty()).toBe(false);
    expect(logs).not.toContain('[rejoin] grace expired, reset on next join');
    poll.close();
    guard.close();
  });

  it('expires after the window a poll saw has passed', async () => {
    const { guard, poll } = setup(() => [], 20);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20);

    expect(guard.wouldHold()).toBe(false);
    expect(decide({ graceActive: guard.wouldHold() })).toBe('reset');
    poll.close();
    guard.close();
  });

  it('changes nothing when LiveKit cannot be asked', async () => {
    const { guard, poll, logs } = setup(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(logs).not.toContain('[rejoin] grace started');
    expect(guard.isEmpty()).toBe(false);
    poll.close();
    guard.close();
  });

  it('pauses only after the room stays empty for ~3 s and resumes at once on a return', async () => {
    let people: Array<{ name: string }> = [{ name: 'Daniel' }];
    const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
    const emptyReads: number[] = [];
    const occupiedReads: number[] = [];
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => true,
      roster: async () => people,
      roomName: () => 'kopitiam',
      isHuman: (name) => name !== 'Sam',
      intervalMs: 1_000,
      onEmpty: () => emptyReads.push(Date.now()),
      onOccupied: () => occupiedReads.push(Date.now()),
    });
    poll.start();

    // A 2 s blip (a page reload) never spans the debounce.
    people = [];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emptyReads).toEqual([]);
    people = [{ name: 'Daniel' }];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(occupiedReads).toHaveLength(1);

    // An empty room across the debounce is a real departure.
    people = [];
    await vi.advanceTimersByTimeAsync(EMPTY_ROOM_PAUSE_MS + 1_000);
    expect(emptyReads.length).toBeGreaterThanOrEqual(1);
    const pausedAt = emptyReads[0]!;

    // A person returning resumes immediately, not after another poll's debounce.
    people = [{ name: 'Daniel' }];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(occupiedReads.at(-1)).toBeGreaterThan(pausedAt);

    poll.close();
    guard.close();
  });

  it('restarts the empty-room debounce after a roster outage', async () => {
    let people: Array<{ name: string }> = [{ name: 'Daniel' }];
    let unavailable = false;
    const emptyReads: number[] = [];
    const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => true,
      roster: async () => (unavailable ? undefined : people),
      roomName: () => 'kopitiam',
      isHuman: (name) => name !== 'Sam',
      intervalMs: 1_000,
      onEmpty: () => emptyReads.push(Date.now()),
    });
    poll.start();

    people = [];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emptyReads).toEqual([]);

    // LiveKit cannot be asked for an interval: the empty spell must not carry across it.
    unavailable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    unavailable = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emptyReads).toEqual([]);

    await vi.advanceTimersByTimeAsync(EMPTY_ROOM_PAUSE_MS);
    expect(emptyReads.length).toBeGreaterThanOrEqual(1);
    poll.close();
    guard.close();
  });

  it('restarts the empty-room debounce after a rejected roster read', async () => {
    let people: Array<{ name: string }> = [{ name: 'Daniel' }];
    let broken = false;
    const emptyReads: number[] = [];
    const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => true,
      roster: async () => {
        if (broken) throw new Error('LiveKit is unreachable');
        return people;
      },
      roomName: () => 'kopitiam',
      isHuman: (name) => name !== 'Sam',
      intervalMs: 1_000,
      onEmpty: () => emptyReads.push(Date.now()),
    });
    poll.start();

    people = [];
    await vi.advanceTimersByTimeAsync(2_000);
    broken = true;
    await vi.advanceTimersByTimeAsync(1_000);
    broken = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emptyReads).toEqual([]);

    await vi.advanceTimersByTimeAsync(EMPTY_ROOM_PAUSE_MS);
    expect(emptyReads.length).toBeGreaterThanOrEqual(1);
    poll.close();
    guard.close();
  });

  it('restarts the empty-room debounce when the meeting or room name is missing', async () => {
    let people: Array<{ name: string }> = [{ name: 'Daniel' }];
    let watching = true;
    let room: string | undefined = 'kopitiam';
    const emptyReads: number[] = [];
    const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => watching,
      roster: async () => people,
      roomName: () => room,
      isHuman: (name) => name !== 'Sam',
      intervalMs: 1_000,
      onEmpty: () => emptyReads.push(Date.now()),
    });
    poll.start();

    people = [];
    await vi.advanceTimersByTimeAsync(2_000);
    watching = false;
    await vi.advanceTimersByTimeAsync(2_000);
    watching = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emptyReads).toEqual([]);

    // The same must hold when the room name disappears for a while.
    room = undefined;
    await vi.advanceTimersByTimeAsync(2_000);
    room = 'kopitiam';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emptyReads).toEqual([]);

    await vi.advanceTimersByTimeAsync(EMPTY_ROOM_PAUSE_MS);
    expect(emptyReads.length).toBeGreaterThanOrEqual(1);
    poll.close();
    guard.close();
  });

  it('forgets the empty-room debounce when the poll is reset', async () => {
    let people: Array<{ name: string }> = [{ name: 'Daniel' }];
    const emptyReads: number[] = [];
    const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => true,
      roster: async () => people,
      roomName: () => 'kopitiam',
      isHuman: (name) => name !== 'Sam',
      intervalMs: 1_000,
      onEmpty: () => emptyReads.push(Date.now()),
    });
    poll.start();

    people = [];
    await vi.advanceTimersByTimeAsync(2_000);
    poll.reset();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emptyReads).toEqual([]);

    await vi.advanceTimersByTimeAsync(EMPTY_ROOM_PAUSE_MS);
    expect(emptyReads.length).toBeGreaterThanOrEqual(1);
    poll.close();
    guard.close();
  });

  it('does nothing while there is no meeting to watch', async () => {
    const logs: string[] = [];
    const guard = createRejoinGuard({ graceMs: 120_000, log: (line) => logs.push(line) });
    const poll = createRoomPoll({
      guard,
      hasMeeting: () => false,
      roster: async () => [],
      roomName: () => 'kopitiam',
      isHuman: () => true,
      intervalMs: 5_000,
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(logs).not.toContain('[rejoin] grace started');
    poll.close();
    guard.close();
  });
});

describe('room poll interval', () => {
  it('uses the quick interval while a meeting is running', () => {
    expect(roomPollIntervalMs(false, REJOIN_POLL_MS)).toBe(REJOIN_POLL_MS);
    expect(roomPollIntervalMs(true, REJOIN_POLL_MS)).toBe(RUNNING_ROOM_POLL_MS);
    expect(RUNNING_ROOM_POLL_MS).toBeLessThan(REJOIN_POLL_MS);
  });

  it('asks for the interval again after every poll, so it can follow the phase', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const guard = createRejoinGuard({ graceMs: 120_000, log: () => undefined });
      let running = false;
      let reads = 0;
      const poll = createRoomPoll({
        guard,
        hasMeeting: () => true,
        roster: async () => {
          reads += 1;
          return [];
        },
        roomName: () => 'kopitiam',
        isHuman: () => true,
        intervalMs: () => (running ? RUNNING_ROOM_POLL_MS : REJOIN_POLL_MS),
      });
      poll.start();

      await vi.advanceTimersByTimeAsync(REJOIN_POLL_MS - 1);
      expect(reads).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(1);

      // The pending 5 s wait still runs; once a poll happens while the meeting is running, the
      // next wait is the quick one.
      running = true;
      await vi.advanceTimersByTimeAsync(REJOIN_POLL_MS);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(RUNNING_ROOM_POLL_MS);
      expect(reads).toBe(3);

      poll.close();
      guard.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
