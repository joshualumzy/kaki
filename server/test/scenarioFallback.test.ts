/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

// A projection that came back broken (a server bug) must never be swapped for the unprojected
// pack: private pack fields would leak and the browser would never see the failure.
vi.mock('../src/scenarioProjection', () => ({
  projectScenario: () => ({}) as unknown as Scenario,
}));

import { createApp, type KakiApp } from '../src/app';
import { createAuth } from '../src/auth/module';
import { hashPassword } from '../src/auth/password';
import { createMemoryAuthStore } from '../src/auth/store';
import { joinSeatRoles } from '@kaki/shared';
import { loadScenario } from '../src/loadScenario';
import { createMeetingCodeSource } from '../src/meetingCode';
import { portOf } from './helpers';

const CODE = 'K7M2Q9';
const HOST_EMAIL = 'host@example.com';
const HOST_PASSWORD = 'host-password';
const pack: Scenario = await loadScenario('kopitiam');

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe('a broken projected scenario', () => {
  it('is refused with an error status, never replaced by the unprojected pack', async () => {
    const store = createMemoryAuthStore();
    await store.createUser({ email: HOST_EMAIL, passwordHash: await hashPassword(HOST_PASSWORD) });
    const meetingCode = createMeetingCodeSource(CODE);
    const auth = createAuth({
      store,
      offeredRoles: () => joinSeatRoles(pack).map((role) => role.id),
      meetingCode,
    });
    const app = await createApp({
      speechRecognition: 'browser',
      scenario: pack,
      auth,
      meetingCode,
      roomRoster: async () => [],
    });
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${portOf(app)}/api/scenario`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    // The unprojected pack's demo facts must not travel in the error either.
    expect(JSON.stringify(body)).not.toContain(pack.organisation);
  });
});
