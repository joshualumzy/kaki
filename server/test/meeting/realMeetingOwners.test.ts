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

  it('keeps a selected owner’s seat while they are absent, then hands the item and cues to them', () => {
    const row = realBaseScenario({
      id: 'owner-test',
      title: 'Planning',
      ownerUserId: 'owner-1',
      agenda: [
        { title: 'Budget', minutes: 5, ownerUserId: 'member-1' },
        { title: 'Hiring', minutes: 5 },
      ],
    });
    const ownerSeat = userRoomIdentity('owner-1');
    const memberSeat = userRoomIdentity('member-1');
    const ownerOnly = [{ name: 'mei', displayName: 'Mei Tan', seat: ownerSeat }];
    const setup = defaultMeetingSetup(row);

    // The owner starts the meeting before the agenda owner joins.
    const sealed = realMeetingSetup(row, ownerOnly, setup);
    expect(sealed.agenda[0]?.ownerRoleId).toBe(memberSeat);
    expect(sealed.agenda[1]?.ownerRoleId).toBe('everyone');

    const atStart = realMeetingScenario(row, ownerOnly, sealed);
    expect(atStart.agenda[0]?.ownerRole).toBe(memberSeat);
    const absentRole = atStart.roles.find((role) => role.id === memberSeat);
    expect(absentRole?.label).toBe('Agenda owner');
    expect(absentRole?.label).not.toBe('Everyone');
    // An item nobody owns stays the generic role; identity is never invented.
    expect(atStart.agenda[1]?.ownerRole).toBe('everyone');

    // The agenda owner joins a minute later with the seat identity the row named.
    const raj = { name: 'raj', displayName: 'Raj', seat: memberSeat };
    const afterJoin = realMeetingScenario(atStart, [...ownerOnly, raj], sealed);
    expect(afterJoin.agenda[0]?.ownerRole).toBe(memberSeat);
    expect(afterJoin.roles.find((role) => role.id === memberSeat)?.label).toBe('Raj');
    // The up-next cue reads this ownerRole and asks for the present holder of exactly that seat.
    expect(afterJoin.agenda[0]?.ownerRole).toBe(raj.seat);
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
