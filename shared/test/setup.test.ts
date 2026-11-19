import { describe, expect, it } from 'vitest';
import type { Scenario } from '../src/scenario';
import {
  defaultMeetingSetup,
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
