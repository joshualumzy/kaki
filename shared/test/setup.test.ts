import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/scenario';
import {
  blankMeetingSetup,
  defaultMeetingSetup,
  demoPackNpcProfileForRole,
  demoPackNpcProfileForSeat,
  isBlankMeetingDraft,
  isPackFreeMeeting,
  parseMeetingSetup,
  type MeetingSetup,
  type SetupFieldError,
} from '../src/setup';
import { testScenario } from './fixtures';

const packScenario: Scenario = {
  ...testScenario,
  npcs: [
    { attendee: 'Ada', voice: 'en-US-AdaNeural', personality: 'Warm', agenda: 'Ship lunch', concerns: ['Timing'], playable: true },
    { attendee: 'Bao', voice: 'en-US-BaoNeural', personality: 'Dry', agenda: 'Count stock', concerns: ['Waste'], playable: true },
  ],
};

function validSetup(): MeetingSetup {
  return {
    title: 'Lunch service readiness',
    agenda: [{ id: 'prep', title: 'Prep', minutes: 5, ownerRoleId: 'chef' }],
    roles: [
      { id: 'chef', label: 'Chef', facilitator: false },
      { id: 'cashier', label: 'Cashier', facilitator: false },
    ],
    seats: [
      { displayName: 'Ada', roleId: 'chef', kind: 'person' },
      { displayName: 'Bao', roleId: 'cashier', kind: 'person' },
    ],
    pace: { ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 },
    source: { title: 'typed', agenda: 'typed', roles: 'typed', seats: 'typed', pace: 'typed' },
  };
}

function errorsFor(value: unknown, npcProfileIds?: readonly string[]): SetupFieldError[] {
  const result = parseMeetingSetup(value, npcProfileIds === undefined ? {} : { npcProfileIds });
  if (result.ok) throw new Error('Expected the setup to be rejected');
  return result.errors;
}

function fields(errors: SetupFieldError[]): string[] {
  return errors.map((error) => error.field);
}

function aiSeat(): MeetingSetup {
  const setup = validSetup();
  setup.seats = [
    { displayName: 'Ada', roleId: 'chef', kind: 'person' },
    { displayName: 'Bao', roleId: 'cashier', kind: 'ai', npcProfileId: 'Bao' },
  ];
  return setup;
}

describe('meeting setup parser', () => {
  it('accepts a valid setup', () => {
    const result = parseMeetingSetup(validSetup());
    expect(result.ok).toBe(true);
  });

  it('builds a demo-pack default that passes the parser', () => {
    const setup = defaultMeetingSetup(packScenario);
    expect(setup.source).toEqual({
      title: 'demo pack',
      agenda: 'demo pack',
      roles: 'demo pack',
      seats: 'demo pack',
      pace: 'demo pack',
    });
    expect(setup.seats.some((seat) => seat.kind === 'person')).toBe(true);
    const ai = setup.seats.filter((seat) => seat.kind === 'ai');
    expect(ai).toHaveLength(1);
    expect(ai[0]?.npcProfileId).toBe('Bao');
    expect(setup.pace).toEqual({ ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 });
    expect(parseMeetingSetup(setup, { npcProfileIds: ['Ada', 'Bao'] }).ok).toBe(true);
  });

  it('finds the demo-pack profile a seat can switch to, and none for a typed seat', () => {
    expect(demoPackNpcProfileForRole(packScenario, 'chef')).toBe('Ada');
    expect(demoPackNpcProfileForRole(packScenario, 'waiter')).toBeUndefined();
    expect(demoPackNpcProfileForRole(testScenario, 'chef')).toBeUndefined();

    expect(
      demoPackNpcProfileForSeat(packScenario, {
        displayName: 'Bao',
        roleId: 'cashier',
        kind: 'ai',
        npcProfileId: 'Bao',
      }),
    ).toBe('Bao');
    expect(
      demoPackNpcProfileForSeat(packScenario, {
        displayName: 'Renamed cashier',
        roleId: 'cashier',
        kind: 'person',
      }),
    ).toBe('Bao');
    expect(
      demoPackNpcProfileForSeat(packScenario, {
        displayName: 'Visitor',
        roleId: 'waiter',
        kind: 'person',
      }),
    ).toBeUndefined();
  });

  it('builds a human-only default when the scenario has no demo pack', () => {
    const setup = defaultMeetingSetup(testScenario);
    expect(setup.seats.every((seat) => seat.kind === 'person')).toBe(true);
    expect(parseMeetingSetup(setup).ok).toBe(true);
  });

  it('requires at least one agenda item', () => {
    const setup = validSetup();
    setup.agenda = [];
    expect(fields(errorsFor(setup))).toContain('agenda');
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['too long', 241],
  ])('rejects %s agenda minutes', (_label, minutes) => {
    const setup = validSetup();
    setup.agenda[0]!.minutes = minutes;
    expect(fields(errorsFor(setup))).toContain('agenda[0].minutes');
  });

  it('rejects an agenda owner that is not a role', () => {
    const setup = validSetup();
    setup.agenda[0]!.ownerRoleId = 'waiter';
    expect(fields(errorsFor(setup))).toContain('agenda[0].ownerRoleId');
  });

  it('rejects duplicate agenda ids and titles', () => {
    const setup = validSetup();
    setup.agenda = [
      { id: 'prep', title: 'Prep', minutes: 5, ownerRoleId: 'chef' },
      { id: 'prep', title: 'Prep', minutes: 5, ownerRoleId: 'cashier' },
    ];
    const found = fields(errorsFor(setup));
    expect(found).toContain('agenda[1].id');
    expect(found).toContain('agenda[1].title');
  });

  it('rejects duplicate role ids and labels', () => {
    const setup = validSetup();
    setup.roles = [
      { id: 'chef', label: 'Chef', facilitator: false },
      { id: 'chef', label: 'Chef', facilitator: false },
    ];
    const found = fields(errorsFor(setup));
    expect(found).toContain('roles[1].id');
    expect(found).toContain('roles[1].label');
  });

  it('rejects an empty display name', () => {
    const setup = validSetup();
    setup.seats[0]!.displayName = '  ';
    expect(fields(errorsFor(setup))).toContain('seats[0].displayName');
  });

  it('rejects a duplicate display name', () => {
    const setup = validSetup();
    setup.seats[1]!.displayName = 'Ada';
    expect(fields(errorsFor(setup))).toContain('seats[1].displayName');
  });

  it('allows AI stand-ins only when the demo pack is loaded', () => {
    const withoutPack = errorsFor(aiSeat());
    expect(fields(withoutPack)).toContain('seats[1].npcProfileId');

    const unknownProfile = errorsFor(aiSeat(), ['Ada']);
    expect(fields(unknownProfile)).toContain('seats[1].npcProfileId');

    expect(parseMeetingSetup(aiSeat(), { npcProfileIds: ['Ada', 'Bao'] }).ok).toBe(true);
  });

  it('rooms a meeting with AI stand-ins for exactly one person', () => {
    const setup = aiSeat();
    setup.seats.push({ displayName: 'Cy', roleId: 'chef', kind: 'person' });
    const found = errorsFor(setup, ['Ada', 'Bao']);
    expect(found).toContainEqual({
      field: 'seats',
      message: 'A meeting with AI stand-ins has room for one person.',
    });
  });

  it('requires at least one person seat', () => {
    const setup = aiSeat();
    setup.seats = [setup.seats[1]!];
    expect(fields(errorsFor(setup, ['Ada', 'Bao']))).toContain('seats');
  });

  it.each([
    ['non-integer', { ownerQuietBelow: 30.5, quietCheckAfter: 120, comingUpBefore: 60 }, 'pace.ownerQuietBelow'],
    ['too small', { ownerQuietBelow: 5, quietCheckAfter: 120, comingUpBefore: 60 }, 'pace.ownerQuietBelow'],
    ['too large', { ownerQuietBelow: 30, quietCheckAfter: 700, comingUpBefore: 60 }, 'pace.quietCheckAfter'],
    ['quiet talk not shorter than check time', { ownerQuietBelow: 60, quietCheckAfter: 60, comingUpBefore: 60 }, 'pace.ownerQuietBelow'],
  ])('rejects %s pace values', (_label, pace, field) => {
    const setup = validSetup();
    setup.pace = pace;
    expect(fields(errorsFor(setup))).toContain(field);
  });
});

describe('isPackFreeMeeting', () => {
  it('is true when every seat is a person and no agenda item is a pack topic', () => {
    const setup = validSetup();
    setup.agenda = [{ id: 'typed', title: 'Weekly planning', minutes: 10, ownerRoleId: 'chef' }];
    expect(isPackFreeMeeting(setup, packScenario)).toBe(true);
  });

  it('keeps the pack when an agenda item is a pack topic, even with no AI seats', () => {
    const setup = validSetup();
    expect(setup.agenda[0]?.title).toBe(packScenario.agenda[0]?.title);
    expect(isPackFreeMeeting(setup, packScenario)).toBe(false);
  });

  it('keeps the pack when any seat is an AI stand-in', () => {
    const setup = validSetup();
    setup.agenda = [{ id: 'typed', title: 'Weekly planning', minutes: 10, ownerRoleId: 'chef' }];
    setup.seats[1] = { displayName: 'Bao', roleId: 'cashier', kind: 'ai', npcProfileId: 'Bao' };
    expect(isPackFreeMeeting(setup, packScenario)).toBe(false);
  });
});

describe('blankMeetingSetup', () => {
  it('starts an empty, editable plan with the default pace', () => {
    const setup = blankMeetingSetup();
    expect(setup.title).toBe('');
    expect(setup.agenda).toEqual([]);
    expect(setup.roles).toEqual([]);
    expect(setup.seats).toEqual([]);
    expect(setup.pace).toEqual({ ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 });
    expect(isBlankMeetingDraft(setup)).toBe(true);
  });

  it('rejects the blank plan until it is filled, then validates it', () => {
    expect(parseMeetingSetup(blankMeetingSetup()).ok).toBe(false);

    const filled: MeetingSetup = {
      ...blankMeetingSetup(),
      title: 'Weekly planning',
      roles: [{ id: 'chair', label: 'Chair', facilitator: true }],
      agenda: [{ id: 'agenda-1', title: 'Opening checklist', minutes: 10, ownerRoleId: 'chair' }],
      seats: [{ displayName: 'Alex', roleId: 'chair', kind: 'person' }],
    };
    expect(isBlankMeetingDraft(filled)).toBe(false);
    expect(parseMeetingSetup(filled)).toEqual({ ok: true, value: filled });
    expect(isPackFreeMeeting(filled, packScenario)).toBe(true);
  });
});
