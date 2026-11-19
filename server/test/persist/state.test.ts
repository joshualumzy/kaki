import { describe, expect, it } from 'vitest';
import {
  assertReadableSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  resolveSavedAgenda,
  savedMeetingProblem,
  type StoredMeeting,
} from '../../src/persist/state';
import { testScenario } from '../fixtures/scenario';

function saved(): StoredMeeting {
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:01:00.000Z',
    state: {
      meetingId: 'meeting-1',
      agenda: ['Prep'],
      clock: {
        started: true,
        ended: false,
        paused: false,
        agendaIndex: 0,
        itemElapsedSeconds: 12,
        meetingElapsedSeconds: 12,
      },
      notetaker: {
        pending: [{ speaker: 'Ada (Chef)', text: 'One more thing.' }],
        inFlight: [],
        recentGrounded: [],
        contextAgendaIndex: 0,
        agendaContext: [],
        openQuestions: [{ id: 'q-1', text: 'Who closes?', agendaIndex: 0 }],
        questionCount: 1,
        status: 'ok',
        talkByItem: [[0, { chef: 12 }]],
        talkTotals: [['chef', 12]],
        talkTotal: 12,
      },
      tasks: [
        {
          id: 'task-1',
          title: 'Call the plumber',
          context: 'The sink leaks.',
          suggestedAssignee: 'chef',
          status: 'SUGGESTED',
          updatedAt: '2026-01-01T00:00:30.000Z',
        },
      ],
    },
  };
}

function refusal(make: (meeting: StoredMeeting) => void): string {
  const meeting = saved();
  make(meeting);
  try {
    assertReadableSavedMeeting(meeting, testScenario);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the saved meeting to be refused');
}

describe('saved meeting validation', () => {
  it('accepts a complete snapshot', () => {
    expect(savedMeetingProblem(saved(), testScenario)).toBeUndefined();
    expect(() => assertReadableSavedMeeting(saved(), testScenario)).not.toThrow();
  });

  it.each([
    [
      'a clock that points past the saved agenda',
      (meeting: StoredMeeting) => {
        meeting.state.clock.agendaIndex = 4;
      },
      'its clock points at an agenda item that is not saved',
    ],
    [
      'a notetaker in-flight batch that is not a list',
      (meeting: StoredMeeting) => {
        (meeting.state.notetaker as unknown as { inFlight: unknown }).inFlight = 'lost';
      },
      'its notetaker in-flight lines is not a list of transcript lines',
    ],
    [
      'a task that does not belong to this scenario',
      (meeting: StoredMeeting) => {
        (meeting.state.tasks[0] as unknown as { suggestedAssignee: string }).suggestedAssignee = 'producer';
      },
      'task 1 is not valid for this scenario',
    ],
    [
      'a missing agenda',
      (meeting: StoredMeeting) => {
        delete (meeting.state as unknown as { agenda?: string[] }).agenda;
      },
      'its agenda is not a list of topics',
    ],
  ])('refuses %s before any part is applied', (_label, make, problem) => {
    const message = refusal(make);
    expect(message).toBe(
      `Saved meeting is unreadable (${problem}). Run \`npm run meeting:reset\` to discard it.`,
    );
  });

  it('resolves the saved agenda by topic, in the order it was saved', () => {
    const scenario = {
      ...testScenario,
      agenda: [
        { title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' as const },
        { title: 'Service', minutes: 5, canWait: false, deadline: 'lunch', ownerRole: 'cashier' as const },
      ],
    };
    const meeting = saved();
    meeting.state.agenda = ['Service', 'Prep'];
    meeting.state.clock.agendaIndex = 0;

    expect(resolveSavedAgenda(meeting, scenario).map((item) => item.title)).toEqual(['Service', 'Prep']);
  });

  it('refuses a saved agenda with a topic this scenario no longer has', () => {
    const meeting = saved();
    meeting.state.agenda = ['Retired topic'];

    expect(() => resolveSavedAgenda(meeting, testScenario)).toThrow(
      "Saved meeting's agenda has topics this scenario no longer has (Retired topic). " +
        'Run `npm run meeting:reset` to discard it.',
    );
  });
});
