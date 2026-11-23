/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

// A projection that came back broken (a server bug) must never be swapped for the unprojected
// pack: private pack fields would leak and the browser would never see the failure.
vi.mock('../../src/meeting/scenarioProjection', () => ({
  projectScenario: () => ({}) as unknown as Scenario,
}));

import { createPracticeTestApp, meetingUrl, type TestAppWithMeeting } from '../helpers';
import { createAuth } from '../../src/auth/module';
import { createMemoryAuthStore } from '../../src/auth/store';
import { loadScenario } from '../../src/core/loadScenario';

const pack: Scenario = await loadScenario('kopitiam');

const apps: TestAppWithMeeting[] = [];


afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe('a broken projected scenario', () => {
  it('is refused with an error status, never replaced by the unprojected pack', async () => {
    const auth = createAuth({ store: createMemoryAuthStore() });
    const app = await createPracticeTestApp({
      speechRecognition: 'browser',
      scenario: pack,
      auth,
      roomRoster: async () => [],
    });
    apps.push(app);

    const response = await fetch(meetingUrl(app, app.meetingId, '/api/scenario?kind=practice'), {
      headers: { cookie: app.cookie! },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    // The unprojected pack's demo facts must not travel in the error either.
    expect(JSON.stringify(body)).not.toContain(pack.organisation);
  });
});
