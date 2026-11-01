import { describe, expect, it } from 'vitest';
import { demoRoomName, humanAttendeeForRole, humanRoles } from '../src/demo';
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
});
