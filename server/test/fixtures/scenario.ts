import type { Scenario } from '@kaki/shared';

/** A test scenario whose roles do not appear in any shipped scenario. */
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
