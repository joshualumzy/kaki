import { describe, expect, it } from 'vitest';
import type { RunnerMeetingSnapshot } from '@kaki/shared';
import { createMeetingSync, type MeetingSyncRunner } from '../../src/npc/meetingSync';
import { createRunnerMeeting } from '../../src/npc/runnerMeeting';
import { loadScenario } from '../../src/core/loadScenario';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const epochA = { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 5 };
const epochB = { epoch: { startedAt: 2_000, id: 'server-b' }, seq: 1 };
const epochC = { epoch: { startedAt: 3_000, id: 'server-c' }, seq: 1 };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syncFor(
  meeting: ReturnType<typeof createRunnerMeeting>,
  fetchState: () => Promise<RunnerMeetingSnapshot>,
  log: string[] = [],
) {
  const runner: MeetingSyncRunner = {
    meetingId: () => meeting.meetingId(),
    wasPreparedFor: () => false,
    reconcileMeeting: (state, options) => meeting.apply(state, options),
    prepareMeeting: async () => undefined,
    markStarted: async () => undefined,
    resetMeeting: (id) => meeting.clear(id),
  };
  return createMeetingSync({ runner, fetchState, log: (line) => log.push(line) });
}

describe('the server-incarnation fence', () => {
  it('adopts a restarted server at a lower seq when the new epoch arrives through the current connection', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: epochA }),
    );

    const accepted = meeting.apply(
      runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB }),
      { currentConnection: true },
    );

    expect(accepted).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual(epochB);
  });

  it('refuses a different epoch on a read that is not from the current connection', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: epochA }),
    );

    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB })),
    ).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-1');
    expect(meeting.version()).toEqual(epochA);
  });

  it('drops a same-epoch snapshot whose seq is lower than the one already accepted', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: epochA }),
    );
    const current = meeting.current();

    expect(
      meeting.apply(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', agendaIndex: 1, version: { ...epochA, seq: 4 } }),
        { currentConnection: true },
      ),
    ).toBe(false);
    expect(meeting.current()).toBe(current);
    expect(meeting.agendaIndex()).toBe(0);
  });

  it('refuses an older incarnation even after adopting a newer one', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: epochA }),
    );
    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB }), {
      currentConnection: true,
    })).toBe(true);

    expect(
      meeting.apply(
        runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { ...epochA, seq: 99 } }),
        { currentConnection: true },
      ),
    ).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual(epochB);
  });

  it('refuses a late older incarnation after a newer one was adopted (E1 -> E3 -> late E2)', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: epochA }),
    );

    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-3', version: epochC }), {
        currentConnection: true,
      }),
    ).toBe(true);
    expect(
      meeting.apply(
        runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { ...epochB, seq: 9 } }),
        { currentConnection: true },
      ),
    ).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-3');
    expect(meeting.version()).toEqual(epochC);
  });

  it('adopts a restarted server on reconnect after a lower-seq snapshot', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 50 },
      }),
    );
    const logs: string[] = [];
    const sync = syncFor(
      meeting,
      async () =>
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: { epoch: { startedAt: 2_000, id: 'server-b' }, seq: 1 },
        }),
      logs,
    );

    sync.connected();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual({ epoch: { startedAt: 2_000, id: 'server-b' }, seq: 1 });
  });

  it('drops a delayed earlier read once a newer snapshot has been accepted', async () => {
    const scenario = await loadScenario('kopitiam');
    const later = deferred<RunnerMeetingSnapshot>();
    const logs: string[] = [];
    const meetingWithLog = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 5 } }),
      (line) => logs.push(line),
    );
    const sync = syncFor(meetingWithLog, () => later.promise, logs);

    sync.connected();
    sync.snapshot(
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        phase: 'running',
        started: true,
        agendaIndex: 2,
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 10 },
      }),
    );
    later.resolve(
      runnerSnapshot(scenario, { meetingId: 'meeting-1', agendaIndex: 0, version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 5 } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(meetingWithLog.agendaIndex()).toBe(2);
    expect(meetingWithLog.version()).toEqual({ epoch: { startedAt: 1_000, id: 'server-a' }, seq: 10 });
    expect(logs.join('\n')).toMatch(/discarded|stale|older/);
  });

  it('keeps refusing an older start time from an event or prepare path', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: epochB.epoch, seq: 5 } }),
    );

    // Events and prepares are not authoritative for an epoch whose clock moved back.
    expect(
      meeting.apply(
        runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { epoch: epochA.epoch, seq: 1 } }),
        { currentConnection: true },
      ),
    ).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-1');
    expect(meeting.version()).toEqual({ epoch: epochB.epoch, seq: 5 });
  });

  it('still refuses a prepare that carries an older start time', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: epochB.epoch, seq: 5 } }),
    );
    const sync = syncFor(meeting, async () =>
      runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { epoch: epochA.epoch, seq: 1 } }),
    );

    await sync.prepare({ requestId: 'r', attempt: 'a', meetingId: 'meeting-2' });

    expect(meeting.meetingId()).toBe('meeting-1');
    expect(meeting.version()).toEqual({ epoch: epochB.epoch, seq: 5 });
  });

  it('accepts an older start time from the reconnect read, with a loud log', async () => {
    const scenario = await loadScenario('kopitiam');
    const logs: string[] = [];
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: epochB.epoch, seq: 5 } }),
      (line) => logs.push(line),
    );
    const sync = syncFor(
      meeting,
      async () =>
        runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { epoch: epochA.epoch, seq: 1 } }),
      logs,
    );

    sync.connected();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual({ epoch: epochA.epoch, seq: 1 });
    expect(logs).toContain('[runner] adopted server epoch with older start time (clock moved back?)');
  });
});
