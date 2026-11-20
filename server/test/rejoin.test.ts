import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admission,
  createRejoinGuard,
  createRoomPoll,
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
