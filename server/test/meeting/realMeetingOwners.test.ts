import { describe, expect, it } from 'vitest';
import { defaultMeetingSetup, parseScenario } from '@kaki/shared';
import {
  realBaseScenario,
  realMeetingScenario,
  realMeetingSetup,
  realScenarioWithPeople,
  userRoomIdentity,
} from '../../src/meeting/realMeeting';

const base = realBaseScenario({
  id: 'owner-test', title: 'Planning', ownerUserId: null,
  agenda: [{ title: 'Budget', minutes: 5 }],
});
const holders = [
  { name: 'raj', displayName: 'Raj', seat: 'person_a' },
  { name: 'raj', displayName: 'Raj', seat: 'person_b' },
];

describe('real agenda owner identity', () => {
  it('registers every selected owner’s stable seat even before they join', () => {
    const row = realBaseScenario({
      id: 'owner-test',
      title: 'Planning',
      ownerUserId: 'owner-1',
      agenda: [{ title: 'Budget', minutes: 5, ownerUserId: 'member-1' }],
    });
    expect(row.roles.map((role) => role.id)).toContain(userRoomIdentity('member-1'));

    // The room builds its scenario through this path; an unknown owner role used to fail here.
    const scenario = realScenarioWithPeople(row, [
      { name: 'owner', displayName: 'Owner', seat: userRoomIdentity('owner-1') },
    ]);
    expect(() =>
      parseScenario(scenario, {
        requireOrganisation: false,
        allowEmptyAgenda: true,
        allowEmptyRoles: true,
      }),
    ).not.toThrow();
  });

  it('turns a member id into their stable seat, not their name', () => {
    const row = realBaseScenario({
      id: 'owner-test',
      title: 'Planning',
      ownerUserId: null,
      agenda: [{ title: 'Budget', minutes: 5, ownerUserId: 'member-1' }],
    });
    expect(row.agenda[0]?.ownerRole).toBe(userRoomIdentity('member-1'));
  });

  it('seals the pace the owner chose', () => {
    const setup = defaultMeetingSetup(base);
    setup.pace = { quietCheckAfter: 90, comingUpBefore: 45 };
    expect(realMeetingSetup(base, holders, setup).pace).toEqual({
      quietCheckAfter: 90,
      comingUpBefore: 45,
    });
  });

  it('keeps the second Raj seat through sealing and roster refresh', () => {
    const setup = defaultMeetingSetup(base);
    setup.agenda[0]!.ownerRoleId = 'person_b';
    const sealed = realMeetingSetup(base, holders, setup);
    expect(sealed.agenda[0]?.ownerRoleId).toBe('person_b');
    expect(realMeetingScenario(base, [...holders].reverse(), sealed).agenda[0]?.ownerRole).toBe('person_b');
  });

  it.each([
    { label: 'absent', people: [holders[0]!] },
    { label: 'multiply held', people: [...holders, { ...holders[1]!, name: 'Other person' }] },
  ])('leaves an $label owner seat unowned', ({ people }) => {
    const setup = defaultMeetingSetup(base);
    setup.agenda[0]!.ownerRoleId = 'person_b';
    expect(realMeetingSetup(base, people, setup).agenda[0]?.ownerRoleId).toBe('everyone');
    expect(realMeetingScenario(base, people, setup).agenda[0]?.ownerRole).toBe('everyone');
  });

  it('does not infer a seat even when only one person has the configured name', () => {
    const setup = defaultMeetingSetup(base);
    setup.agenda[0]!.ownerRoleId = 'budget_lead';
    setup.seats = [{ roleId: 'budget_lead', kind: 'person', displayName: 'Raj' }];
    expect(realMeetingSetup(base, [holders[0]!], setup).agenda[0]?.ownerRoleId).toBe('everyone');
  });

  it.each(['Raj', 'Raj (2)'])('never guesses a stable seat from the setup name %s', (displayName) => {
    const setup = defaultMeetingSetup(base);
    setup.agenda[0]!.ownerRoleId = 'budget_lead';
    setup.seats = [{ roleId: 'budget_lead', kind: 'person', displayName }];
    // An unresolvable role stays unowned, never substitute either Raj.
    expect(realMeetingSetup(base, holders, setup).agenda[0]?.ownerRoleId).toBe('everyone');
  });
});
