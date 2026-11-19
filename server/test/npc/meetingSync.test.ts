import { describe, expect, it, vi } from 'vitest';
import { createMeetingSync, parsePrepareRequest, parseStartedEvent } from '../../src/npc/meetingSync';
import type { RunnerMeetingState, RunnerStartState } from '../../src/npc/runner';

function fakeRunner(meetingId: string | undefined) {
  return {
    meetingId: () => meetingId,
    wasPreparedFor: (_id: string) => false,
    reconcileMeeting: vi.fn((_state: RunnerMeetingState) => undefined),
    markStarted: vi.fn(async (_state: RunnerStartState & { meetingId?: string }) => undefined),
    resetMeeting: vi.fn((next?: string) => {
      meetingId = next;
    }),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('service channel identity', () => {
  it('refuses a prepare request that names no meeting', () => {
    expect(parsePrepareRequest({ requestId: 'request-1', attempt: 'attempt-1' })).toBeUndefined();
    expect(parsePrepareRequest({ requestId: 'request-1', attempt: 'attempt-1', meetingId: '   ' })).toBeUndefined();
    expect(parsePrepareRequest({ requestId: 'request-1', attempt: 'attempt-1', meetingId: 'meeting-1', agendaIndex: 0, resumed: false }))
      .toEqual({ requestId: 'request-1', attempt: 'attempt-1', meetingId: 'meeting-1', agendaIndex: 0, resumed: false });
  });

  it('refuses MEETING_STARTED that names no meeting', () => {
    expect(parseStartedEvent({})).toBeUndefined();
    expect(parseStartedEvent({ meetingId: '' })).toBeUndefined();
    expect(parseStartedEvent({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false }))
      .toEqual({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });
  });
});

describe('meeting sync', () => {
  it('opens a prepared attempt directly, with the welcome a fresh start expects', () => {
    const runner = fakeRunner('meeting-1');
    runner.wasPreparedFor = () => true;
    const fetchState = vi.fn();
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.started({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });

    expect(fetchState).not.toHaveBeenCalled();
    expect(runner.markStarted).toHaveBeenCalledWith({ meetingId: 'meeting-1', agendaIndex: 0, resumed: false });
  });

  it('discards a state answer asked for before the meeting started', async () => {
    const runner = fakeRunner('meeting-1');
    runner.wasPreparedFor = () => true;
    const state = deferred<RunnerMeetingState>();
    const fetchState = vi.fn(() => state.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.connected();
    sync.started({ meetingId: 'meeting-1', resumed: false });
    state.resolve({ meetingId: 'meeting-1', started: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.markStarted).toHaveBeenCalledTimes(1);
    expect(runner.reconcileMeeting).not.toHaveBeenCalled();
  });

  it('discards a delayed hydration answer after a reset', async () => {
    const runner = fakeRunner('meeting-1');
    const state = deferred<RunnerMeetingState>();
    const fetchState = vi.fn(() => state.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.started({ meetingId: 'meeting-1' });
    sync.reset('meeting-2');
    state.resolve({ meetingId: 'meeting-1', started: true, agendaIndex: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The old meeting's hydration must never reopen the runner after the reset.
    expect(runner.markStarted).not.toHaveBeenCalled();
    expect(runner.resetMeeting).toHaveBeenCalledWith('meeting-2');
  });

  it('reconciles on reconnect and discards an answer a newer connection superseded', async () => {
    const runner = fakeRunner('meeting-1');
    const first = deferred<RunnerMeetingState>();
    const second = deferred<RunnerMeetingState>();
    const fetchState = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.connected();
    sync.connected();
    second.resolve({ meetingId: 'meeting-2', started: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.resolve({ meetingId: 'meeting-1', started: true, agendaIndex: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.reconcileMeeting).toHaveBeenCalledTimes(1);
    expect(runner.reconcileMeeting).toHaveBeenCalledWith({ meetingId: 'meeting-2', started: false });
  });
});
