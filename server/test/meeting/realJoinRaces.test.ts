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
  /** Hold the second request after it resolves its principal, before it claims a seat. */
  holdSecondPrincipal(): { reached: Promise<void>; release(): void };
  /** Say when a Start has captured the meeting identity it will wait on. */
  holdStartIdentity(): { reached: Promise<void>; restore(): void };
  /** Reset the meeting just after the next seat claim succeeds. */
  resetAfterClaim(): void;
}

async function setupRace(): Promise<Race> {
  const baseAuth = createAuth({ store: createMemoryAuthStore() });
  let gate: Promise<void> | undefined;
  let reachingClaim: (() => void) | undefined;
  let afterClaimReset: (() => void) | undefined;
  let principals = 0;
  let principalGate: Promise<void> | undefined;
  let reachingSecondPrincipal: (() => void) | undefined;
  const auth: Auth = {
    ...baseAuth,
    async resolvePrincipal(request, meetingId) {
      const principal = await baseAuth.resolvePrincipal(request, meetingId);
      principals += 1;
      if (principals === 2 && principalGate !== undefined) {
        reachingSecondPrincipal?.();
        reachingSecondPrincipal = undefined;
        await principalGate;
      }
      return principal;
    },
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
    holdSecondPrincipal() {
      const wait = deferred();
      const reached = deferred();
      principalGate = wait.promise;
      reachingSecondPrincipal = reached.resolve;
      return { reached: reached.promise, release: wait.resolve };
    },
    holdStartIdentity() {
      const reached = deferred();
      const original = app.session.generation.bind(app.session);
      let armed = true;
      app.session.generation = () => {
        if (armed) {
          armed = false;
          reached.resolve();
        }
        return original();
      };
      return {
        reached: reached.promise,
        restore() {
          app.session.generation = original;
        },
      };
    },
    resetAfterClaim() {
      afterClaimReset = () => app.session.reset();
    },
  };
}

describe('a real meeting joins and starts across a reset', () => {
  it('lets only one of two simultaneous joins take the same seat', async () => {
    const race = await setupRace();
    const claim = race.holdClaim();
    const principal = race.holdSecondPrincipal();

    const first = race.join();
    await claim.reached;
    // Both requests have resolved the same valid session before either seat claim settles.
    const second = race.join();
    await principal.reached;
    principal.release();
    claim.release();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(race.app.session.holders()).toHaveLength(1);
  });

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
    // Start captures the meeting identity before it queues behind the held join. Waiting for that
    // read guarantees the reset happens while Start is waiting, not before it was even handled.
    const identity = race.holdStartIdentity();
    const starting = race.start();
    await identity.reached;
    identity.restore();
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
