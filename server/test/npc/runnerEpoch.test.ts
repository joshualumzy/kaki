import { describe, expect, it } from 'vitest';
import type { RunnerMeetingSnapshot } from '@kaki/shared';
import { createMeetingSync, type MeetingSyncRunner } from '../../src/npc/meetingSync';
import { createRunnerMeeting } from '../../src/npc/runnerMeeting';
import { loadScenario } from '../../src/loadScenario';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const epochA = { epoch: 'server-a', seq: 5 };
const epochB = { epoch: 'server-b', seq: 1 };

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
    reconcileMeeting: (state, options) => {
      meeting.apply(state, options);
    },
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

  it('never returns to an epoch it has already retired', async () => {
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

  it('adopts a restarted server on reconnect after a lower-seq snapshot', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 50 } }),
    );
    const logs: string[] = [];
    const sync = syncFor(
      meeting,
      async () => runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { epoch: 'server-b', seq: 1 } }),
      logs,
    );

    sync.connected();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual({ epoch: 'server-b', seq: 1 });
  });

  it('drops a delayed earlier read once a newer snapshot has been accepted', async () => {
    const scenario = await loadScenario('kopitiam');
    const later = deferred<RunnerMeetingSnapshot>();
    const logs: string[] = [];
    const meetingWithLog = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 5 } }),
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
        version: { epoch: 'server-a', seq: 10 },
      }),
    );
    later.resolve(
      runnerSnapshot(scenario, { meetingId: 'meeting-1', agendaIndex: 0, version: { epoch: 'server-a', seq: 5 } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(meetingWithLog.agendaIndex()).toBe(2);
    expect(meetingWithLog.version()).toEqual({ epoch: 'server-a', seq: 10 });
    expect(logs.join('\n')).toMatch(/discarded|stale|older/);
  });
});
