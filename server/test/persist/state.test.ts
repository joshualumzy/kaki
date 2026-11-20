import { describe, expect, it } from 'vitest';
import type { MeetingSetup } from '@kaki/shared';
import {
  assertCompatibleSavedMeeting,
  assertReadableSavedMeeting,
  MEETING_STATE_SCHEMA_VERSION,
  resolveSavedAgenda,
  savedMeetingProblem,
  type StoredMeeting,
} from '../../src/persist/state';
import { testScenario } from '../fixtures/scenario';

function setup(): MeetingSetup {
  return {
    title: 'Lunch service readiness',
    agenda: [{ id: 'agenda-1', title: 'Prep', minutes: 5, ownerRoleId: 'chef' }],
    roles: [
      { id: 'chef', label: 'Chef', facilitator: true },
      { id: 'cashier', label: 'Cashier', facilitator: false },
    ],
    seats: [
      { displayName: 'Ada', roleId: 'chef', kind: 'person' },
      { displayName: 'Bao', roleId: 'cashier', kind: 'person' },
    ],
    pace: { ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 },
    source: {
      title: 'demo pack',
      agenda: 'demo pack',
      roles: 'demo pack',
      seats: 'demo pack',
      pace: 'demo pack',
    },
  };
}

function saved(): StoredMeeting {
  return {
    schemaVersion: MEETING_STATE_SCHEMA_VERSION,
    meetingId: 'meeting-1',
    phase: 'running',
    draft: setup(),
    draftTouched: true,
    sealed: setup(),
    holders: [{ name: 'ada', seat: 'chef' }],
    meetingCode: 'AB12CD',
    startedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-01T00:01:00.000Z',
    state: {
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
      'an invalid phase',
      (meeting: StoredMeeting) => {
        (meeting as unknown as { phase: string }).phase = 'paused';
      },
      'its phase is not valid',
    ],
    [
      'a lobby meeting with a seal',
      (meeting: StoredMeeting) => {
        (meeting as unknown as { phase: string }).phase = 'lobby';
      },
      'its sealed setup is not valid for this phase',
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
    meeting.sealed!.agenda = [
      { id: 'agenda-1', title: 'Service', minutes: 5, ownerRoleId: 'cashier' },
      { id: 'agenda-2', title: 'Prep', minutes: 5, ownerRoleId: 'chef' },
    ];
    meeting.state.clock.agendaIndex = 0;

    expect(resolveSavedAgenda(meeting, scenario).map((item) => item.title)).toEqual(['Service', 'Prep']);
  });

  it('refuses a saved agenda with a topic this scenario no longer has', () => {
    const meeting = saved();
    meeting.sealed!.agenda = [{ id: 'agenda-1', title: 'Retired topic', minutes: 5, ownerRoleId: 'chef' }];

    expect(() => resolveSavedAgenda(meeting, testScenario)).toThrow(
      "Saved meeting's agenda has topics this scenario no longer has (Retired topic). " +
        'Run `npm run meeting:reset` to discard it.',
    );
  });

  it('refuses a corrupt saved setup, naming the field and the reset command', () => {
    const meeting = saved();
    meeting.draft.agenda[0]!.minutes = 0;

    expect(() => assertReadableSavedMeeting(meeting, testScenario)).toThrow(
      /its draft setup is invalid at agenda\[0\]\.minutes: .*Run `npm run meeting:reset` to discard it\./,
    );
  });

  it('accepts a pre-Start draft with no start time', () => {
    const meeting = saved();
    delete meeting.startedAt;
    meeting.phase = 'lobby';
    delete meeting.sealed;
    meeting.state.clock.started = false;
    meeting.state.clock.itemElapsedSeconds = 0;
    meeting.state.clock.meetingElapsedSeconds = 0;

    expect(savedMeetingProblem(meeting, testScenario)).toBeUndefined();
  });
  it('accepts an ended meeting that kept its seal and the next draft', () => {
    const meeting = saved();
    meeting.phase = 'ended';
    meeting.state.clock.ended = true;
    meeting.draft = { ...setup(), title: 'Next meeting' };
    meeting.draftEditedSinceSeal = true;

    expect(savedMeetingProblem(meeting, testScenario)).toBeUndefined();
  });

  it('refuses a running saved meeting that lost its start time', () => {
    const meeting = saved();
    delete meeting.startedAt;

    expect(() => assertReadableSavedMeeting(meeting, testScenario)).toThrow(
      'Saved meeting is unreadable (its start time is missing). Run `npm run meeting:reset` to discard it.',
    );
  });

  it('refuses the previous v3 save with the reset hint', () => {
    const meeting = saved();
    meeting.schemaVersion = 3;

    expect(() => assertCompatibleSavedMeeting(meeting)).toThrow(
      'Saved meeting is from an older format (v3, need v' +
        `${MEETING_STATE_SCHEMA_VERSION}). Run \`npm run meeting:reset\` to discard it.`,
    );
  });

  it("accepts a save written in this build's format", () => {
    const meeting = saved();
    meeting.schemaVersion = MEETING_STATE_SCHEMA_VERSION;

    expect(() => assertCompatibleSavedMeeting(meeting)).not.toThrow();
  });

  it('refuses a save from a newer revision than this build', () => {
    const meeting = saved();
    meeting.schemaVersion = MEETING_STATE_SCHEMA_VERSION + 1;

    expect(() => assertCompatibleSavedMeeting(meeting)).toThrow(
      `Saved meeting is from a newer format (v${MEETING_STATE_SCHEMA_VERSION + 1}, need v${MEETING_STATE_SCHEMA_VERSION}). Run \`npm run meeting:reset\` to discard it.`,
    );
  });
});
