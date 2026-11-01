import { describe, expect, it } from 'vitest';
import { aiCast, demoRoomName, humanAttendeeForRole, humanRoles } from '../src/demo';
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
});
