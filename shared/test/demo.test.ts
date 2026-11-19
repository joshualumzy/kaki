import { describe, expect, it } from 'vitest';
import { itemMode, resolveAgendaPick, shuffleAgendaForRole, codeProblem, normalizeMeetingCode, aiCast, hostRole, seatProblem, humanSeatCapacity, humanSeatCount, MAX_TYPED_LENGTH, parseControlMessage, demoRoomName, humanAttendeeForRole, humanRoles } from '../src/demo';
import type { Scenario } from '../src/scenario';
import { testScenario } from './fixtures';

const withAi: Scenario = {
  ...testScenario,
  npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }],
};

describe('demo meeting helpers', () => {
  it('accepts the explicit decision lock control', () => {
    expect(parseControlMessage({ kind: 'lock' })).toEqual({ kind: 'lock' });
  });
  it('names the room after the scenario', () => {
    expect(demoRoomName(testScenario)).toBe('kaki-demo-test-kitchen');
  });

  it('offers a person only the roles no AI attendee plays', () => {
    expect(humanRoles(testScenario).map((role) => role.id)).toEqual(['chef', 'cashier']);
    expect(humanRoles(withAi).map((role) => role.id)).toEqual(['cashier']);
  });

  it('maps a chosen role, by id or label, to the attendee the transcript will call them', () => {
    expect(humanAttendeeForRole(withAi, 'cashier')?.zoomDisplayName).toBe('Bao (Cashier)');
    expect(humanAttendeeForRole(withAi, ' CASHIER ')?.name).toBe('Bao');
    expect(humanAttendeeForRole(withAi, 'Chef')).toBeUndefined();
    expect(humanAttendeeForRole(withAi, 'astronaut')).toBeUndefined();
  });

  it('lets a person take the seat of a playable character, and the AIs are the rest', () => {
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const seats: Scenario = {
      ...testScenario,
      npcs: [
        { ...npc, attendee: 'Ada', playable: true },
        { ...npc, attendee: 'Bao', playable: true },
      ],
    };
    expect(humanRoles(seats).map((role) => role.id)).toEqual(['chef', 'cashier']);
    expect(humanAttendeeForRole(seats, 'chef')?.name).toBe('Ada');
    expect(aiCast(seats, 'Ada').map((profile) => profile.attendee)).toEqual(['Bao']);
    expect(aiCast(seats, 'Bao').map((profile) => profile.attendee)).toEqual(['Ada']);
    // Before anyone joins, only the characters nobody can play are in the room.
    expect(aiCast(seats)).toEqual([]);
    expect(aiCast({ ...seats, npcs: [...(seats.npcs ?? []), { ...npc, attendee: 'Host' } as never] }).map((p) => p.attendee)).toEqual(['Host']);
  });

  it('never offers a facilitator role', () => {
    const scenario: Scenario = {
      ...testScenario,
      roles: testScenario.roles.map((role) => (role.id === 'chef' ? { ...role, facilitator: true } : role)),
    };
    expect(humanRoles(scenario).map((role) => role.id)).toEqual(['cashier']);
  });

  it('reads control messages from the wire, and refuses anything else', () => {
    expect(parseControlMessage({ kind: 'stop' })).toEqual({ kind: 'stop' });
    expect(parseControlMessage({ kind: 'typing', extra: 1 })).toEqual({ kind: 'typing' });
    expect(parseControlMessage({ kind: 'start' })).toEqual({ kind: 'start' });
    expect(parseControlMessage({ kind: 'start', requestId: 'req-1', session: 'visitor-1' })).toEqual({
      kind: 'start',
      requestId: 'req-1',
      session: 'visitor-1',
    });
    // Only a start with neither field is the legacy message; a partial or malformed pair is refused.
    expect(parseControlMessage({ kind: 'start', requestId: '' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', session: 'visitor-1' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: 'req-1' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: '', session: 'visitor-1' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: 'req-1', session: '' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: 1, session: 'visitor-1' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: 'req-1', session: 1 })).toBeUndefined();
    expect(parseControlMessage({ kind: 'start', requestId: '   ', session: 'visitor-1' })).toBeUndefined();
    expect(parseControlMessage({ kind: 'text', text: '  hello  ' })).toEqual({ kind: 'text', text: 'hello' });
    expect(parseControlMessage({ kind: 'text', text: 'x'.repeat(MAX_TYPED_LENGTH + 50) })).toEqual({
      kind: 'text',
      text: 'x'.repeat(MAX_TYPED_LENGTH),
    });
    for (const bad of [null, 'stop', 3, {}, { kind: 'text' }, { kind: 'text', text: '   ' }, { kind: 'text', text: 5 }, { kind: 'jump' }]) {
      expect(parseControlMessage(bad)).toBeUndefined();
    }
  });

  it('offers the host seat only when the facilitator role has a playable character', () => {
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const base: Scenario = {
      ...testScenario,
      roles: [...testScenario.roles, { id: 'manager', label: 'Manager', facilitator: true }],
      attendees: [...testScenario.attendees, { name: 'Sam', role: 'manager', zoomDisplayName: 'Sam' }],
    };
    expect(hostRole(base)).toBeUndefined();
    expect(hostRole({ ...base, npcs: [{ ...npc, attendee: 'Sam', role: 'host' }] })).toBeUndefined();
    const playable: Scenario = { ...base, npcs: [{ ...npc, attendee: 'Sam', role: 'host', playable: true }] };
    expect(hostRole(playable)?.id).toBe('manager');
    expect(humanAttendeeForRole(playable, 'Manager')?.name).toBe('Sam');
    // The host seat is not a participant role.
    expect(humanRoles(playable).map((role) => role.id)).not.toContain('manager');
  });

  it('refuses a taken seat, and takes exactly one person when the meeting has AI stand-ins', () => {
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const cast = Array.from({ length: 5 }, (_, i) => ({ ...npc, attendee: i === 0 ? testScenario.attendees[0]!.name : `AI ${i}`, role: 'participant' as const, playable: true }));
    const scenario: Scenario = { ...testScenario, npcs: cast };
    const role = humanRoles(scenario)[0]!;
    expect(humanSeatCapacity(scenario, 3)).toBe(1);
    expect(seatProblem(scenario, [], role.label, 3)).toBeUndefined();
    expect(seatProblem(scenario, [{ role: role.label }], role.label, 3)).toMatch(/seat is taken/);
    expect(seatProblem(scenario, [{ role: 'someone else' }], role.label, 3)).toMatch(/full.*AI stand-ins take one person/);
  });

  it('never exceeds the human seats of a human-only meeting, whatever the requested cap says', () => {
    expect(seatProblem(testScenario, Array.from({ length: humanSeatCount(testScenario) }, () => ({})), 'chef', 99)).toMatch(/full/);
  });

  it('takes its default capacity from the configured human seats, not an implicit one-person cap', () => {
    expect(humanSeatCount(testScenario)).toBe(2);
    expect(humanSeatCapacity(testScenario)).toBe(2);
    expect(seatProblem(testScenario, [], 'chef')).toBeUndefined();
    expect(seatProblem(testScenario, [{ role: 'chef' }], 'cashier')).toBeUndefined();
    expect(seatProblem(testScenario, [{ role: 'chef' }, { role: 'cashier' }], 'chef')).toMatch(/seat is taken/);
    expect(seatProblem(testScenario, [{ role: 'chef' }, { role: 'cashier' }], undefined)).toMatch(/full/);
    // A scenario with one human seat still admits only one person.
    const oneSeat: Scenario = { ...testScenario, npcs: [{ attendee: 'Bao', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }] };
    expect(humanSeatCount(oneSeat)).toBe(1);
    expect(humanSeatCapacity(oneSeat)).toBe(1);
    expect(seatProblem(oneSeat, [{ role: 'chef' }], undefined)).toMatch(/full/);
  });
});

describe('meeting code', () => {
  it('lets the first person in without a code, and checks everyone after', () => {
    expect(codeProblem(0, 'K7QX', undefined)).toBeUndefined();
    expect(codeProblem(1, 'K7QX', undefined)).toMatch(/needs its code/);
    expect(codeProblem(1, 'K7QX', 'zzzz')).toMatch(/not right/);
    expect(codeProblem(2, 'K7QX', ' k7-qx ')).toBeUndefined();
    expect(normalizeMeetingCode(undefined)).toBe('');
  });
});

describe('itemMode', () => {
  const scenario = parseScenarioForTest();
  function parseScenarioForTest() {
    return {
      roles: [
        { id: 'producer', label: 'Producer' },
        { id: 'lead', label: 'Lead Programmer' },
      ],
    } as never;
  }
  const item = (extra: object) => ({ title: 'T', minutes: 5, ownerRole: 'lead', ...extra }) as never;

  it('depends on who the person is: their own item involves them, others are watched, a contested one is theirs to settle', () => {
    expect(itemMode(scenario, item({}), 'Lead Programmer')).toBe('involve');
    expect(itemMode(scenario, item({}), 'lead')).toBe('involve');
    expect(itemMode(scenario, item({}), 'Producer')).toBe('observe');
    expect(itemMode(scenario, item({ contested: true }), 'Producer')).toBe('decide');
    expect(itemMode(scenario, undefined, 'Producer')).toBe('observe');
    expect(itemMode(scenario, item({}), undefined)).toBe('observe');
  });

  it('shuffles the agenda and puts an item the visitor participates in first', () => {
    const fullScenario: Scenario = {
      ...testScenario,
      roles: [
        { id: 'producer', label: 'Producer' },
        { id: 'lead', label: 'Lead Programmer' },
        { id: 'marketing', label: 'Marketing Lead' },
      ],
      agenda: [
        { title: 'Item A', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'lead', contested: true },
        { title: 'Item B', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'lead', contested: true },
        { title: 'Item C', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'marketing' },
      ],
    };
    const forMarketing = shuffleAgendaForRole(fullScenario, 'Marketing Lead', () => 0.1);
    expect(forMarketing[0]?.title).toBe('Item B');
    expect(forMarketing).toHaveLength(3);

    const forProducer = shuffleAgendaForRole(fullScenario, 'Producer', () => 0.99);
    expect(forProducer[0]?.title).not.toBe('Item A');
    expect(itemMode(fullScenario, forProducer[0], 'Producer')).toBe('decide');

    const capped = shuffleAgendaForRole(fullScenario, 'Marketing Lead', () => 0.1, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]?.title).toBe('Item B');
    expect(capped[1]?.title).toBe('Item C');
  });
});

describe('agenda pair rules', () => {
  const scenario: Scenario = {
    ...testScenario,
    roles: [
      { id: 'producer', label: 'Producer' },
      { id: 'lead', label: 'Lead Programmer' },
      { id: 'marketing', label: 'Marketing Lead' },
    ],
    agenda: [
      { title: 'Item A', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'lead', contested: true },
      { title: 'Item B', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'lead', contested: true },
      { title: 'Item C', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'marketing' },
    ],
  };

  it('never draws a pair listed in excludedPairs', () => {
    const withExcluded: Scenario = { ...scenario, excludedPairs: [['Item B', 'Item C']] };
    const picked = shuffleAgendaForRole(withExcluded, 'Marketing Lead', () => 0.1, 2);
    expect(picked.map((item) => item.title)).toEqual(['Item B', 'Item A']);
    const wide = shuffleAgendaForRole(withExcluded, undefined, () => 0.1, 5);
    const titles = wide.map((item) => item.title);
    expect(titles.includes('Item B') && titles.includes('Item C')).toBe(false);
  });

  it('fixes the picked items and order from titles or indexes, and fails loudly on bad input', () => {
    expect(resolveAgendaPick(scenario, 'Item C, 0').map((item) => item.title)).toEqual(['Item C', 'Item A']);
    expect(resolveAgendaPick(scenario, 'item a').map((item) => item.title)).toEqual(['Item A']);
    expect(() => resolveAgendaPick(scenario, '')).toThrow(/at least one/);
    expect(() => resolveAgendaPick(scenario, 'Dinner')).toThrow(/unknown agenda title "Dinner".*Known titles/);
    expect(() => resolveAgendaPick(scenario, '7')).toThrow(/out of range/);
    expect(() => resolveAgendaPick(scenario, 'Item A,Item A')).toThrow(/more than once/);
    expect(() => resolveAgendaPick({ ...scenario, excludedPairs: [['Item A', 'Item C']] }, 'Item C,Item A')).toThrow(/excluded pair/);
  });
});
