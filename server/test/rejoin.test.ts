import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRejoinGuard, createRoomPoll } from '../src/rejoin';

function guardWith(graceMs: number, clock: { now: number }, logs: string[] = []) {
  return createRejoinGuard({ graceMs, now: () => clock.now, log: (line) => logs.push(line) });
}

describe('rejoin guard', () => {
  it('starts a fresh meeting for the first person ever', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    expect(guard.admit('Daniel')).toEqual({ reset: true });
    guard.close();
  });

  it('has no meeting until the first person joins', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    expect(guard.hasMeeting()).toBe(false);
    guard.joined('Daniel', guard.admit('Daniel'));
    expect(guard.hasMeeting()).toBe(true);
    guard.close();
  });

  it('starts a new meeting for anyone arriving after the meeting ended, even inside the window', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Daniel', guard.admit('Daniel'));
    guard.ended();
    guard.emptied();
    clock.now += 10_000;
    expect(guard.admit('Daniel')).toEqual({ reset: true });
    expect(guard.admit('Priya')).toEqual({ reset: true });

    // The new meeting can be resumed again as usual.
    guard.joined('Priya', guard.admit('Priya'));
    guard.emptied();
    clock.now += 10_000;
    expect(guard.admit('Priya')).toEqual({ reset: false });
    guard.close();
  });

  it('resumes the same person when the room emptied before a poll saw it', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(120_000, clock, logs);
    guard.joined('Daniel', guard.admit('Daniel'));

    // The person left and returned before the next poll, so the guard never observed an empty room.
    const back = guard.admit('Daniel');
    expect(back).toEqual({ reset: false });
    guard.joined('Daniel', back);
    expect(logs).toContain('[rejoin] grace started');
    expect(logs).toContain('[rejoin] resumed after 0 s');
    guard.close();
  });

  it('starts a fresh meeting for a different person before a poll saw the room empty', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Daniel', guard.admit('Daniel'));

    expect(guard.admit('Priya')).toEqual({ reset: true });
    guard.close();
  });

  it('keeps the meeting for the same person returning inside the window', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(120_000, clock, logs);
    const first = guard.admit('Daniel');
    guard.joined('Daniel', first);

    clock.now += 30_000;
    guard.emptied();
    clock.now += 30_000;

    const back = guard.admit('Daniel');
    expect(back).toEqual({ reset: false });
    guard.joined('Daniel', back);
    expect(logs).toContain('[rejoin] grace started');
    expect(logs).toContain('[rejoin] resumed after 30 s');
    guard.close();
  });

  it('remembers a person who joined an occupied room by name and seat', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Ada', guard.admit('Ada'), 'chef');
    guard.remember('Bao', 'cashier');
    clock.now += 10_000;
    guard.emptied();
    clock.now += 5_000;

    // Bao joined a room Ada was already in; when both come back, either order resumes.
    expect(guard.admit('Bao', 'cashier')).toEqual({ reset: false });
    expect(guard.admit('Ada', 'chef')).toEqual({ reset: false });
    guard.close();
  });

  it('starts a fresh meeting for a stranger taking a seat someone left', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Ada', guard.admit('Ada'), 'chef');
    guard.emptied();
    clock.now += 10_000;

    expect(guard.admit('Priya', 'chef')).toEqual({ reset: true });
    guard.close();
  });

  it('starts a fresh meeting for a different person inside the window', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Daniel', guard.admit('Daniel'));
    clock.now += 10_000;
    guard.emptied();
    clock.now += 5_000;

    expect(guard.admit('Priya')).toEqual({ reset: true });
    guard.close();
  });

  it('lets the new person resume after their fresh meeting, not the one who left', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Daniel', guard.admit('Daniel'));
    guard.emptied();
    clock.now += 10_000;

    const fresh = guard.admit('Priya');
    expect(fresh).toEqual({ reset: true });
    guard.joined('Priya', fresh);
    guard.emptied();
    clock.now += 10_000;

    expect(guard.admit('Priya')).toEqual({ reset: false });
    expect(guard.admit('Daniel')).toEqual({ reset: true });
    guard.close();
  });

  it('resets once the window has passed', () => {
    const clock = { now: 1_000 };
    const guard = guardWith(120_000, clock);
    guard.joined('Daniel', guard.admit('Daniel'));
    guard.emptied();
    clock.now += 120_000;

    expect(guard.admit('Daniel')).toEqual({ reset: true });
    guard.close();
  });

  it('logs when the window expires so the reset is not a surprise', async () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(10, clock, logs);
    guard.joined('Daniel', guard.admit('Daniel'));
    guard.emptied();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logs).toContain('[rejoin] grace expired, reset on next join');
    guard.close();
  });

  it('resets as soon as someone joins an empty room when the grace is 0', () => {
    const clock = { now: 1_000 };
    const logs: string[] = [];
    const guard = guardWith(0, clock, logs);
    guard.joined('Daniel', guard.admit('Daniel'));
    guard.emptied();

    expect(guard.admit('Daniel')).toEqual({ reset: true });
    expect(logs).toEqual([]);
    guard.close();
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
    guard.joined('Daniel', guard.admit('Daniel'));
    const poll = createRoomPoll({
      guard,
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
    expect(guard.admit('Daniel')).toEqual({ reset: false });
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

    // The window was cleared, so this arrival is treated as a fresh empty spell and resumes.
    expect(guard.admit('Daniel')).toEqual({ reset: false });
    expect(logs).not.toContain('[rejoin] grace expired, reset on next join');
    poll.close();
    guard.close();
  });

  it('resets after the window a poll saw has passed', async () => {
    const { guard, poll } = setup(() => [], 20);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20);

    expect(guard.admit('Daniel')).toEqual({ reset: true });
    poll.close();
    guard.close();
  });

  it('changes nothing when LiveKit cannot be asked', async () => {
    const { guard, poll, logs } = setup(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(logs).not.toContain('[rejoin] grace started');
    expect(guard.hasMeeting()).toBe(true);
    poll.close();
    guard.close();
  });
});
