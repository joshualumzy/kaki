import { describe, expect, it } from 'vitest';
import { itemMode, codeProblem, newMeetingCode, normalizeMeetingCode, aiCast, hostRole, seatProblem, MAX_TYPED_LENGTH, parseControlMessage, demoRoomName, humanAttendeeForRole, humanRoles } from '../src/demo';
import type { Scenario } from '../src/scenario';
import { testScenario } from './fixtures';

const withAi: Scenario = {
  ...testScenario,
  npcs: [{ attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }],
};

describe('demo meeting helpers', () => {
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

  it('refuses a taken seat, and a join that would leave no AI or pass the cap', () => {
    const npc = { voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    const cast = Array.from({ length: 5 }, (_, i) => ({ ...npc, attendee: i === 0 ? testScenario.attendees[0]!.name : `AI ${i}`, role: 'x', playable: true }));
    const scenario: Scenario = { ...testScenario, npcs: cast };
    const role = humanRoles(scenario)[0]!;
    expect(seatProblem(scenario, [], role.label, 3)).toBeUndefined();
    expect(seatProblem(scenario, [{ role: role.label }], role.label, 3)).toMatch(/seat is taken/);
    expect(seatProblem(scenario, [{ role: 'a' }, { role: 'b' }, { role: 'c' }], role.label, 3)).toMatch(/full/);
    // Never every character: at least one stays AI, whatever the cap says.
    const cap = Math.max(1, cast.length - 1);
    expect(seatProblem(scenario, Array.from({ length: cap }, () => ({})), role.label, 99)).toMatch(/full/);
  });
});

describe('meeting code', () => {
  it('makes four easy-to-read characters', () => {
    for (let n = 0; n < 50; n += 1) expect(newMeetingCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
  });
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
});
