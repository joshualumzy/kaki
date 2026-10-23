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
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
  ],
  agenda: [{ title: 'Prep', minutes: 5, ownerRole: 'chef' }],
};
