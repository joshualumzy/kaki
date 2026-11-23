import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from '../../src/auth/module';
import { hashToken } from '../../src/auth/password';
import { createMemoryAuthStore } from '../../src/auth/store';
import { createRealTestApp, meetingUrl, type TestAppWithMeeting } from '../helpers';

const apps: TestAppWithMeeting[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Race {
  app: TestAppWithMeeting;
  join(): Promise<Response>;
  start(): Promise<Response>;
  /** Make the next seat claim wait for this gate, and say when it has reached it. */
  holdClaim(): { reached: Promise<void>; release(): void };
  /** Reset the meeting just after the next seat claim succeeds. */
  resetAfterClaim(): void;
}

async function setupRace(): Promise<Race> {
  const baseAuth = createAuth({ store: createMemoryAuthStore() });
  let gate: Promise<void> | undefined;
  let reachingClaim: (() => void) | undefined;
  let afterClaimReset: (() => void) | undefined;
  const auth: Auth = {
    ...baseAuth,
    async enterSeat(request, response, role, meetingId) {
      if (gate !== undefined) {
        reachingClaim?.();
        reachingClaim = undefined;
        await gate;
      }
      const entered = await baseAuth.enterSeat(request, response, role, meetingId);
      if (entered) afterClaimReset?.();
      return entered;
    },
  };
  const owner = await baseAuth.store.createGoogleUser({
    googleSub: randomUUID(),
    name: 'Ada',
    email: `${randomUUID()}@example.com`,
  });
  const ownerToken = randomUUID();
  await baseAuth.store.createSession({
    tokenHash: hashToken(ownerToken),
    kind: 'user',
    role: null,
    meetingCode: null,
    meetingId: null,
    displayName: 'Ada',
    userId: owner.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const app = await createRealTestApp(
    { speechRecognition: 'browser', auth, roomRoster: async () => [] },
    { title: 'Weekly planning', ownerUserId: owner.id, agenda: [{ title: 'Prep', minutes: 5 }] },
  );
  apps.push(app);
  const guest = await baseAuth.createGuestSession(app.meetingId, 'Guest');
  return {
    app,
    join: () =>
      fetch(meetingUrl(app, app.meetingId, '/api/livekit/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: guest },
        body: JSON.stringify({ participantName: 'Guest' }),
      }),
    start: () =>
      fetch(meetingUrl(app, app.meetingId, '/api/meeting/start'), {
        method: 'POST',
        headers: { cookie: `kaki_session=${ownerToken}` },
      }),
    holdClaim() {
      const wait = deferred();
      const reached = deferred();
      gate = wait.promise;
      reachingClaim = reached.resolve;
      return { reached: reached.promise, release: wait.resolve };
    },
    resetAfterClaim() {
      afterClaimReset = () => app.session.reset();
    },
  };
}

describe('a real meeting joins and starts across a reset', () => {
  it('refuses an admission whose meeting changed while its seat was being claimed', async () => {
    const race = await setupRace();
    const claim = race.holdClaim();
    const joining = race.join();
    await claim.reached;
    race.app.session.reset();
    claim.release();

    const response = await joining;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(race.app.session.holders()).toEqual([]);
  });

  it('refuses a join whose meeting changed after its seat was claimed', async () => {
    const race = await setupRace();
    race.resetAfterClaim();

    const response = await race.join();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(race.app.session.holders()).toEqual([]);
  });

  it('refuses a Start that waited through a reset instead of starting the replacement meeting', async () => {
    const race = await setupRace();
    const claim = race.holdClaim();
    const joining = race.join();
    await claim.reached;
    const starting = race.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    race.app.session.reset();
    claim.release();

    expect((await joining).status).toBe(409);
    const started = await starting;
    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({
      error: 'The meeting was reset before it could start; press Start again.',
    });
  });
});
