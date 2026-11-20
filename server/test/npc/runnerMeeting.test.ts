import { describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/loadScenario';
import { createRunnerMeeting } from '../../src/npc/runnerMeeting';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

describe('RunnerMeeting', () => {
  it('rejects an older version for the same meeting', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { version: 4 }));
    const current = meeting.current();

    expect(meeting.apply(runnerSnapshot(scenario, { version: 3, agendaIndex: 1 }))).toBe(false);
    expect(meeting.current()).toBe(current);
    expect(meeting.agendaIndex()).toBe(0);
  });

  it('treats another meeting id as a new sequence, even at a lower version', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 40 }));

    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: 1 }), { newSequence: true }),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.version()).toBe(1);
  });

  it('refuses another meeting id on an unfenced path', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 4 }));

    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: 5 }))).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-1');
  });

  it('accepts a newer snapshot and reads everything from it', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 4 }));
    const cast = (scenario.npcs ?? []).filter((npc) => npc.role === 'host');

    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: 5,
          phase: 'running',
          started: true,
          agendaIndex: 1,
          cast,
          hostIsHuman: true,
        }),
        { newSequence: true },
      ),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.started()).toBe(true);
    expect(meeting.agendaIndex()).toBe(1);
    expect(meeting.cast()).toEqual(cast);
    expect(meeting.hostIsHuman()).toBe(true);
  });

  it('forgets the snapshot on clear but still fences the next meeting by id', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 4 }));
    meeting.clear('meeting-2');

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.current()).toBeUndefined();
    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-1', version: 4 }))).toBe(false);
    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: 5 }))).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
  });
});
