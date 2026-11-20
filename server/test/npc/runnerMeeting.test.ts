import { describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/loadScenario';
import { createRunnerMeeting } from '../../src/npc/runnerMeeting';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const epochA = { epoch: 'server-a', seq: 4 };
const epochB = { epoch: 'server-b', seq: 1 };

describe('RunnerMeeting', () => {
  it('rejects an older seq for the same epoch', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { version: epochA }));
    const current = meeting.current();

    expect(
      meeting.apply(runnerSnapshot(scenario, { version: { ...epochA, seq: 3 }, agendaIndex: 1 })),
    ).toBe(false);
    expect(meeting.current()).toBe(current);
    expect(meeting.agendaIndex()).toBe(0);
  });

  it('treats another server epoch as a new sequence, even at a lower seq', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 40 } }),
    );

    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB }), {
        currentConnection: true,
      }),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toEqual(epochB);
  });

  it('refuses a new epoch on an unfenced path', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 4 } }),
    );

    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB }))).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-1');
  });

  it('accepts a newer snapshot and reads everything from it', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 4 } }),
    );
    const cast = (scenario.npcs ?? []).filter((npc) => npc.role === 'host');

    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: { epoch: 'server-a', seq: 5 },
          phase: 'running',
          started: true,
          agendaIndex: 1,
          cast,
          hostIsHuman: true,
        }),
      ),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.started()).toBe(true);
    expect(meeting.agendaIndex()).toBe(1);
    expect(meeting.cast()).toEqual(cast);
    expect(meeting.hostIsHuman()).toBe(true);
  });

  it('forgets the snapshot on clear but still fences the next one by seq', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 4 } }),
    );
    meeting.clear('meeting-2');

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.current()).toBeUndefined();
    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-1', version: { epoch: 'server-a', seq: 4 } })),
    ).toBe(false);
    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: { epoch: 'server-a', seq: 5 } })),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
  });
});
