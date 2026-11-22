import { describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/core/loadScenario';
import { createRunnerMeeting } from '../../src/npc/runnerMeeting';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const epochA = { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 };
const epochB = { epoch: { startedAt: 2_000, id: 'server-b' }, seq: 1 };

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

  it('treats a newer server epoch as a new sequence, even at a lower seq', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 40 },
      }),
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
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 },
      }),
    );

    expect(meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochB }))).toBe(false);
    expect(meeting.meetingId()).toBe('meeting-1');
  });

  it('refuses an older epoch even through the current connection', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(scenario, runnerSnapshot(scenario, { version: epochB }));

    expect(
      meeting.apply(runnerSnapshot(scenario, { meetingId: 'meeting-2', version: epochA }), {
        currentConnection: true,
      }),
    ).toBe(false);
    expect(meeting.version()).toEqual(epochB);
  });

  it('accepts a newer snapshot and reads everything from it', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 },
      }),
    );
    const cast = (scenario.npcs ?? []).filter((npc) => npc.role === 'host');

    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 5 },
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
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 },
      }),
    );
    meeting.clear('meeting-2');

    expect(meeting.meetingId()).toBe('meeting-2');
    expect(meeting.current()).toBeUndefined();
    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-1',
          version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 },
        }),
      ),
    ).toBe(false);
    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 5 },
        }),
      ),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
  });

  it('adopts the next snapshot after a clear that named no meeting', async () => {
    const scenario = await loadScenario('kopitiam');
    const meeting = createRunnerMeeting(
      scenario,
      runnerSnapshot(scenario, {
        meetingId: 'meeting-1',
        version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 3 },
      }),
    );
    meeting.clear();

    expect(
      meeting.apply(
        runnerSnapshot(scenario, {
          meetingId: 'meeting-2',
          version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 4 },
        }),
      ),
    ).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-2');
  });

  it('re-adopts the unchanged snapshot after clear when the server keeps the same meeting and version', async () => {
    const scenario = await loadScenario('kopitiam');
    const edited = {
      ...scenario,
      agenda: scenario.agenda.slice(0, 1).map((item) => ({ ...item, title: 'Server agenda' })),
    };
    const state = runnerSnapshot(edited, {
      meetingId: 'meeting-1',
      version: { epoch: { startedAt: 1_000, id: 'server-a' }, seq: 7 },
    });
    const meeting = createRunnerMeeting(scenario, state);
    meeting.clear('meeting-1');

    expect(meeting.current()).toBeUndefined();
    expect(meeting.apply(state)).toBe(true);
    expect(meeting.meetingId()).toBe('meeting-1');
    expect(meeting.agenda()[0]?.title).toBe('Server agenda');
    expect(meeting.version()).toEqual(state.version);
  });
});
