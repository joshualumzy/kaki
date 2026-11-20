import type { Scenario } from '../src/scenario';

/** A small scenario with roles that do not come from any shipped scenario. */
export const testScenario: Scenario = {
  id: 'test-kitchen',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service readiness',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
  ],
  agenda: [{ title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' }],
};
