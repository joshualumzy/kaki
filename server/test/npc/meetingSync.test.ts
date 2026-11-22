import { describe, expect, it, vi } from 'vitest';
import type { RunnerMeetingSnapshot } from '@kaki/shared';
import { createMeetingSync, parsePrepareRequest, parseStartedEvent } from '../../src/npc/meetingSync';
import { testScenario } from '../fixtures/scenario';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

function stateOf(meetingId: string, started: boolean, agendaIndex = 0): RunnerMeetingSnapshot {
  return runnerSnapshot(testScenario, {
    meetingId,
    ...(started ? { phase: 'running' as const, started: true } : {}),
    agendaIndex,
  });
}

type RunnerStartState = { agendaIndex?: number; resumed?: boolean };

function fakeRunner(meetingId: string | undefined) {
  return {
    meetingId: () => meetingId,
    wasPreparedFor: (_id: string) => false,
    reconcileMeeting: vi.fn((_state: RunnerMeetingSnapshot) => true),
    prepareMeeting: vi.fn(async (_request: unknown) => undefined),
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
    const state = deferred<RunnerMeetingSnapshot>();
    const fetchState = vi.fn(() => state.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.connected();
    sync.started({ meetingId: 'meeting-1', resumed: false });
    state.resolve(stateOf('meeting-1', false));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.markStarted).toHaveBeenCalledTimes(1);
    expect(runner.reconcileMeeting).not.toHaveBeenCalled();
  });

  it('discards a delayed hydration answer after a reset', async () => {
    const runner = fakeRunner('meeting-1');
    const state = deferred<RunnerMeetingSnapshot>();
    const fetchState = vi.fn(() => state.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.started({ meetingId: 'meeting-1' });
    sync.reset('meeting-2');
    state.resolve(stateOf('meeting-1', true, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The old meeting's hydration must never reopen the runner after the reset.
    expect(runner.markStarted).not.toHaveBeenCalled();
    expect(runner.resetMeeting).toHaveBeenCalledWith('meeting-2');
  });

  it('reconciles on reconnect and discards an answer a newer connection superseded', async () => {
    const runner = fakeRunner('meeting-1');
    const first = deferred<RunnerMeetingSnapshot>();
    const second = deferred<RunnerMeetingSnapshot>();
    const fetchState = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.connected();
    sync.connected();
    second.resolve(stateOf('meeting-2', false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.resolve(stateOf('meeting-1', true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.reconcileMeeting).toHaveBeenCalledTimes(1);
    expect(runner.reconcileMeeting).toHaveBeenCalledWith(stateOf('meeting-2', false), {
      currentConnection: true,
      authoritative: true,
    });
  });

  it('reports a meeting change learned on reconnect so the old meeting queue can be dropped', async () => {
    const runner = fakeRunner('meeting-1');
    runner.reconcileMeeting = vi.fn((state: RunnerMeetingSnapshot) => {
      runner.meetingId = () => state.meetingId;
      return true;
    });
    const changed: string[] = [];
    const sync = createMeetingSync({
      runner,
      fetchState: async () => stateOf('meeting-2', false),
      log: () => undefined,
      onMeetingChanged: (meetingId) => changed.push(meetingId),
    });

    sync.connected();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(changed).toEqual(['meeting-2']);
  });

  it('re-reads the meeting state through the fence when a resume is expected', async () => {
    const runner = fakeRunner('meeting-1');
    const state = stateOf('meeting-1', true);
    const fetchState = vi.fn(async () => state);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.recheck('the runner is paused locally and waiting for a resume');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchState).toHaveBeenCalledTimes(1);
    expect(runner.reconcileMeeting).toHaveBeenCalledWith(state, { currentConnection: true });
  });

  it('discards a re-read answer that a reset superseded', async () => {
    const runner = fakeRunner('meeting-1');
    const stale = deferred<RunnerMeetingSnapshot>();
    const sync = createMeetingSync({ runner, fetchState: () => stale.promise, log: () => undefined });

    sync.recheck('the runner is paused locally and waiting for a resume');
    sync.reset('meeting-2');
    stale.resolve(stateOf('meeting-1', true));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runner.reconcileMeeting).not.toHaveBeenCalled();
  });

  it('does not stack re-reads while one is still in flight', async () => {
    const runner = fakeRunner('meeting-1');
    const pending = deferred<RunnerMeetingSnapshot>();
    const fetchState = vi.fn(() => pending.promise);
    const sync = createMeetingSync({ runner, fetchState, log: () => undefined });

    sync.recheck('first');
    sync.recheck('second');
    expect(fetchState).toHaveBeenCalledTimes(1);

    pending.resolve(stateOf('meeting-1', true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.reconcileMeeting).toHaveBeenCalledTimes(1);
  });

  it('prepares the exact snapshot it fetched for the attempt', async () => {
    const runner = fakeRunner('meeting-1');
    const state = stateOf('meeting-1', false);
    const sync = createMeetingSync({ runner, fetchState: async () => state, log: () => undefined });

    const outcome = await sync.prepare({ requestId: 'request-1', attempt: 'attempt-1', meetingId: 'meeting-1' });

    expect(outcome).toEqual({ kind: 'prepared' });
    expect(runner.prepareMeeting).toHaveBeenCalledWith({
      meetingId: 'meeting-1',
      attempt: 'attempt-1',
      snapshot: state,
    });
  });

  it('refuses a prepare whose snapshot arrived after a reset and never touches the newer meeting', async () => {
    const runner = fakeRunner('meeting-1');
    const stale = deferred<RunnerMeetingSnapshot>();
    const sync = createMeetingSync({ runner, fetchState: () => stale.promise, log: () => undefined });

    const outcome = sync.prepare({ requestId: 'request-1', attempt: 'attempt-1', meetingId: 'meeting-1' });
    sync.reset('meeting-2');
    stale.resolve(stateOf('meeting-1', false));

    await expect(outcome).resolves.toMatchObject({ kind: 'superseded' });
    expect(runner.prepareMeeting).not.toHaveBeenCalled();
    expect(runner.meetingId()).toBe('meeting-2');
  });

  it('refuses a prepare whose snapshot names another meeting', async () => {
    const runner = fakeRunner('meeting-1');
    const sync = createMeetingSync({
      runner,
      fetchState: async () => stateOf('meeting-2', false),
      log: () => undefined,
    });

    const outcome = await sync.prepare({ requestId: 'request-1', attempt: 'attempt-1', meetingId: 'meeting-1' });

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(runner.prepareMeeting).not.toHaveBeenCalled();
  });
});
