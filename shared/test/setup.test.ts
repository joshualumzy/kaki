import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/scenarioTypes';
import { blankMeetingSetup, isBlankMeetingDraft, parseMeetingSetup } from '../src/setupParse';
import {
  defaultMeetingSetup,
  demoPackNpcProfileForRole,
  demoPackNpcProfileForSeat,
  isPackFreeMeeting,
  meetingScenarioFromSetup,
  setupScenarioRoles,
} from '../src/setupScenario';
import type { MeetingSetup, SetupFieldError } from '../src/setupTypes';
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

  it('accepts an optional team or organisation, trims it, and treats blank as no organisation', () => {
    const withOrg = { ...validSetup(), organisation: '  Northwind Labs  ' };
    const parsed = parseMeetingSetup(withOrg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.organisation).toBe('Northwind Labs');

    for (const blank of [undefined, '', '   ']) {
      const setup: Record<string, unknown> = { ...validSetup() };
      if (blank === undefined) delete setup.organisation;
      else setup.organisation = blank;
      const result = parseMeetingSetup(setup);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.organisation).toBeUndefined();
    }
  });

  it('rejects an organisation longer than the limit', () => {
    const errors = errorsFor({ ...validSetup(), organisation: 'x'.repeat(121) });
    expect(fields(errors)).toContain('organisation');
  });

  it('builds a demo-pack default that passes the parser', () => {
    const setup = defaultMeetingSetup(packScenario);
    expect(setup.organisation).toBe(packScenario.organisation);
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

describe('owner-written meetings take no pack story', () => {
  const storyPack: Scenario = {
    ...packScenario,
    organisation: 'Nanyang Kopi & Toast',
    meetingTitle: 'Raffles Place Flagship Opening Day',
    situation: 'The refurbished Raffles Place flagship opens this morning.',
    background: ['The flagship is at Raffles Place.'],
    vocabulary: ['kopitiam'],
    glossary: { kopitiam: 'coffee shop' },
    roles: packScenario.roles.map((role) => role.id === 'chef'
      ? { ...role, card: { youAre: 'You run the kopitiam kitchen.', facts: ['The oven is old.'], responsibility: 'Keep service moving.' } }
      : role),
  };

  it('leaves the organisation out and drops the pack situation and background when the owner field is blank', () => {
    const setup: MeetingSetup = {
      ...validSetup(),
      title: 'Weekly planning',
      agenda: [{ id: 'typed', title: 'Weekly planning', minutes: 10, ownerRoleId: 'chef' }],
    };
    const derived = meetingScenarioFromSetup(storyPack, setup);
    expect(derived.organisation).toBeUndefined();
    expect(derived.meetingTitle).toBe('Weekly planning');
    expect(derived.situation).toBeUndefined();
    expect(derived.background).toBeUndefined();
    expect(derived.vocabulary).toBeUndefined();
    expect(derived.glossary).toBeUndefined();
    expect(derived.speechRegister).toBeUndefined();
  });

  it('uses the team or organisation the owner typed', () => {
    const setup: MeetingSetup = {
      ...validSetup(),
      title: 'Weekly planning',
      organisation: 'Northwind Labs',
      agenda: [{ id: 'typed', title: 'Weekly planning', minutes: 10, ownerRoleId: 'chef' }],
    };
    const derived = meetingScenarioFromSetup(storyPack, setup);
    expect(derived.organisation).toBe('Northwind Labs');
  });

  it('does not give a reused role id the pack role card', () => {
    const setup: MeetingSetup = {
      ...validSetup(),
      title: 'Weekly planning',
      agenda: [{ id: 'typed', title: 'Weekly planning', minutes: 10, ownerRoleId: 'chef' }],
    };
    const roles = setupScenarioRoles(storyPack, setup);
    expect(roles.find((role) => role.id === 'chef')?.card).toBeUndefined();
    expect(roles.find((role) => role.id === 'chef')?.label).toBe('Chef');
  });

  it('keeps the pack story when a topic still comes from the pack', () => {
    const derived = meetingScenarioFromSetup(storyPack, validSetup());
    expect(derived.organisation).toBe('Nanyang Kopi & Toast');
    expect(derived.situation).toBe(storyPack.situation);
    expect(derived.roles.find((role) => role.id === 'chef')?.card).toBeDefined();
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
