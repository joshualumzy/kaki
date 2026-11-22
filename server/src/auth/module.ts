import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import {
  isObject,
  MEETING_ENDED_MESSAGE,
  NO_TEAM_MEETING_MESSAGE,
  seatKeptForDepartedMessage,
} from '@kaki/shared';
import type { ClientAudience } from '../core/audience';
import { clientAddress, publicUrlIsHttps, type Principal } from '../http/access';
import { readJsonBody, sendJson } from '../http/http';
import { createAttemptLimiter, type AttemptLimiter } from '../http/attemptLimiter';
import {
  MEETING_CODE_FAILURE_LIMIT,
  MEETING_CODE_RATE_LIMIT_MESSAGE,
  MEETING_CODE_WINDOW_MS,
  type MeetingCodeSource,
} from '../meeting/meetingCode';
import { clearSessionCookie, readSessionCookie, SESSION_TTL_MS, sessionCookie } from './cookie';
import {
  createGoogleSignIn,
  GOOGLE_NOT_SET_UP_MESSAGE,
  sendAuthFailure,
  type GoogleSignIn,
} from './google';
import { hashPassword, hashToken, verifyPassword } from './password';
import { createPostgresAuthStore } from './postgres';
import { ensureAuthSchema } from './schema';
import type { AuthStore, SessionKind, SessionRecord } from './store';

/** The result of checking a WebSocket upgrade against the session cookie. */
type AuthDecision =
  | {
      ok: true;
      participant?: boolean;
      principal?: Principal;
      /** The exact session this socket belongs to, so swapping it can close the socket. */
      sessionTokenHash?: string;
      /** True when the AI runner's service token authorized the socket. */
      runner?: boolean;
      /** The seat a participant projection is bound to. */
      seat?: string;
    }
  | { ok: false; message: string };

/** The auth feature the HTTP server and WebSocket hub call into. */
export interface Auth {
  /** Handle an auth or join request; false means the path belongs to another route. */
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /**
   * Allow or reject a `/ws?role=` or `/ws?audience=` upgrade for the requested audience. When a
   * meeting id is given, a phone session must belong to exactly that meeting, never another one.
   */
  authorize(
    request: IncomingMessage,
    audience: ClientAudience,
    meetingId?: string,
    options?: { anyOfferedSeat?: boolean },
  ): Promise<AuthDecision>;
  /** The resolved host or seat principal behind a request; undefined otherwise. */
  resolvePrincipal(request: IncomingMessage, meetingId?: string): Promise<Principal | undefined>;
  /**
   * Atomically take a seat and start the session that holds it. `/api/join` and the LiveKit token
   * route share this one record: a visitor gets a participant session, while the signed-in host
   * keeps the host and replaces their session with one that also carries the seat's meeting.
   * Returns false when another live holder already owns the seat.
   */
  enterSeat(
    request: IncomingMessage,
    response: ServerResponse,
    role: string,
    expectedMeetingId?: string,
  ): Promise<boolean>;
  /** Bind seat grants to the server's current meeting generation. */
  bindMeetingIdentity(meetingId: () => string | undefined): void;
  /** Point phone joins and seat sockets at the live setup's offered seats. */
  bindOfferedSeats(offered: () => readonly string[]): void;
  /** Enforce the meeting kind and the practice visitor's exact seat at `/api/join`. */
  bindJoinGuard(guard: JoinGuard): void;
  /** Release every seat grant belonging to a meeting that has rotated away. */
  releaseMeeting(meetingId: string): Promise<void>;
  /** Be told when a session is replaced, so its already-open sockets can be closed. */
  onSessionEnded(handler: (sessionTokenHash: string) => void): void;
  /** The code-attempt limiter shared with the LiveKit token route, per client address. */
  readonly meetingCodeLimiter: AttemptLimiter;
  /** The auth persistence, also used by the workspace API. */
  readonly store: AuthStore;
  /** Whether this server issues Secure cookies, so other routes can match it. */
  readonly secureCookies: boolean;
  /** Bind how a real meeting decides its owner or workspace admin. */
  bindMeetingHost(handler: MeetingHostCheck): void;
  /** Create a guest session for exactly one meeting and return its Set-Cookie value. */
  createGuestSession(meetingId: string, name: string): Promise<string>;
  close(): Promise<void>;
}

/** Whether this product user is the meeting's owner or an admin of its workspace. */
export type MeetingHostCheck = (meetingId: string, userId: string) => Promise<boolean>;

/** The meeting facts `/api/join` needs so it cannot escalate a practice visitor into another seat. */
interface JoinGuard {
  meetingKind(): 'real' | 'practice' | undefined;
  practiceSeat(): string | undefined;
  hasPracticeCapability(request: IncomingMessage): boolean;
  /**
   * Run the whole join inside the one admission queue that serializes every meeting change. A
   * lifecycle change can then never land between this request's checks and its seat claim.
   */
  admit<T>(task: () => Promise<T>): Promise<T>;
  /**
   * How long this seat is still kept for a holder who left and the grace is open, or undefined
   * when the seat is not being held for a departed person.
   */
  departedSeatGraceMs(seat: string): number | undefined;
}

/** Everything the auth module needs, injected so tests can use an in-memory store. */
export interface AuthOptions {
  store: AuthStore;
  /** The seats offered right now; createApp binds this to the live setup. */
  offeredRoles?: () => readonly string[];
  meetingCode: MeetingCodeSource;
  secureCookies?: boolean;
  now?: () => number;
  log?: (message: string) => void;
  /** Injectable password check, so tests can prove an unknown email still takes that path. */
  verifyPassword?: typeof verifyPassword;
  /** The Google code flow; absent means `/api/auth/google/start` answers the setup message. */
  google?: GoogleSignIn;
}

const MAX_BODY_BYTES = 64_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

const WRONG_CREDENTIALS = 'Email or password is incorrect.';

type JsonObject = Record<string, unknown>;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return value === 'demo' || (value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value));
}

function stringField(body: JsonObject, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Who a stored session belongs to. A host keeps every host power even when it also holds a seat;
 * the seat view itself only belongs to the meeting generation the host took it in.
 */
function principalFor(session: SessionRecord, meetingId: string): Principal {
  if (session.kind === 'host') {
    const seat = session.role !== null && session.meetingId === meetingId ? session.role : undefined;
    return seat === undefined ? { kind: 'host' } : { kind: 'host', seat };
  }
  // A guest session becomes a participant when it takes a seat, but it carries no user id:
  // that is the one mark that separates a visitor from a signed-in member behind the same seat.
  return {
    kind: 'seat',
    role: session.role ?? '',
    ...(session.userId === null || session.userId === undefined
      ? { guest: true }
      : { userId: session.userId }),
  };
}

/** Create the auth feature: endpoints, session cookies and WebSocket gating. */
export function createAuth({
  store,
  offeredRoles: readOfferedRoles,
  meetingCode,
  secureCookies = false,
  now = Date.now,
  log = () => undefined,
  verifyPassword: verify = verifyPassword,
  google,
}: AuthOptions): Auth {
  const sessionEndedHandlers = new Set<(sessionTokenHash: string) => void>();
  let meetingIdentity: (() => string | undefined) | undefined;
  let offeredRoles: () => readonly string[] = readOfferedRoles ?? (() => []);
  let joinGuard: JoinGuard | undefined;
  let meetingHost: MeetingHostCheck | undefined;
  const currentMeetingId = (): string => meetingIdentity?.() ?? meetingCode.value;
  /** A real hash to check against when the email is unknown, so both paths cost the same. */
  let dummyHash: Promise<string> | undefined;
  const loginAttempts = createAttemptLimiter({
    limit: LOGIN_FAILURE_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    now,
  });
  const meetingCodeAttempts = createAttemptLimiter({
    limit: MEETING_CODE_FAILURE_LIMIT,
    windowMs: MEETING_CODE_WINDOW_MS,
    now,
  });

  async function currentSession(request: IncomingMessage): Promise<SessionRecord | undefined> {
    const token = readSessionCookie(request);
    if (token === undefined) return undefined;
    const tokenHash = hashToken(token);
    const session = await store.findSession(tokenHash);
    if (session === undefined) return undefined;
    if (session.expiresAt.getTime() <= now()) {
      await store.deleteSession(tokenHash);
      return undefined;
    }
    return session;
  }

  /** Whether this meeting currently offers the role as a human seat. */
  function seatIsOffered(role: string): boolean {
    return offeredRoles().includes(role);
  }

  /** Whether this exact session still holds the role's seat in its meeting generation. */
  function sessionOwnsSeat(session: SessionRecord, role: string): Promise<boolean> {
    return session.meetingId === null
      ? Promise.resolve(false)
      : store.seatHeldBy({ meetingId: session.meetingId, role, holder: session.tokenHash });
  }

  function notifySessionEnded(tokenHash: string): void {
    for (const handler of sessionEndedHandlers) {
      try {
        handler(tokenHash);
      } catch (error) {
        log(`kaki auth: a session-ended handler failed: ${String(error)}`);
      }
    }
  }

  function sessionRecord(
    token: string,
    kind: SessionKind,
    role: string | null,
    code: string | null,
    meetingId: string | null,
    displayName: string | null = null,
    userId: string | null = null,
  ): SessionRecord {
    return {
      tokenHash: hashToken(token),
      kind,
      role,
      meetingCode: code,
      meetingId,
      displayName,
      userId,
      expiresAt: new Date(now() + SESSION_TTL_MS),
    };
  }

  async function startSession(
    response: ServerResponse,
    kind: SessionKind,
    role: string | null,
    code: string | null,
    meetingId: string | null = null,
  ): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await store.createSession(sessionRecord(token, kind, role, code, meetingId));
    response.setHeader('set-cookie', sessionCookie(token, secureCookies));
  }

  async function enterSeat(
    request: IncomingMessage,
    response: ServerResponse,
    role: string,
    expectedMeetingId: string = currentMeetingId(),
  ): Promise<boolean> {
    const existing = await currentSession(request);
    // The meeting this claim was validated against is the one it enters. Every caller re-checks the
    // meeting's generation and phase after this await, so a lifecycle change during the claim is
    // still refused; a real meeting's id is not the auth module's single legacy identity.
    const token = randomBytes(32).toString('base64url');
    const meetingId = expectedMeetingId;
    // A host taking a seat is still the host; the new session also carries the seat's meeting.
    // A signed-in product user is the host only when they own this meeting or administer its
    // workspace, exactly as every other host check decides it.
    const ownerByAccount =
      existing?.kind === 'user' &&
      existing.userId !== null &&
      existing.userId !== undefined &&
      meetingHost !== undefined &&
      (await meetingHost(meetingId, existing.userId));
    const kind: SessionKind = existing?.kind === 'host' || ownerByAccount ? 'host' : 'participant';
    // The claim transfer, the new session and the old session's retirement are one store step:
    // two simultaneous joins cannot both win, and a failure leaves the old session in charge.
    const claimed = await store.enterSeat({
      meetingId,
      role,
      session: sessionRecord(
        token,
        kind,
        role,
        // Only the practice meeting's seats carry the practice code; a real meeting's seat is
        // validated by its own meeting id and claim, so the practice code changing cannot end it.
        kind === 'host' || meetingId !== currentMeetingId() ? null : meetingCode.value,
        meetingId,
        existing?.displayName ?? null,
        existing?.userId ?? null,
      ),
      ...(existing === undefined ? {} : { replaces: existing.tokenHash }),
    });
    if (!claimed) return false;

    response.setHeader('set-cookie', sessionCookie(token, secureCookies));
    if (existing !== undefined) notifySessionEnded(existing.tokenHash);
    return true;
  }

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readJsonBody(request, MAX_BODY_BYTES);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    if (!isObject(parsed.value)) {
      sendJson(response, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const rawEmail = stringField(parsed.value, 'email');
    const password = stringField(parsed.value, 'password');

    if (rawEmail === undefined || rawEmail.trim() === '') {
      sendJson(response, 400, { error: 'Enter your email address.' });
      return;
    }
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) {
      sendJson(response, 400, { error: 'Enter a valid email address.' });
      return;
    }
    if (password === undefined || password.trim() === '') {
      sendJson(response, 400, { error: 'Enter your password.' });
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      sendJson(response, 400, { error: 'That password is too long.' });
      return;
    }

    const key = `${clientAddress(request)}|${email}`;
    if (loginAttempts.isLimited(key)) {
      sendJson(response, 429, {
        error: 'Too many sign-in attempts. Wait a minute and try again.',
      });
      return;
    }

    const user = await store.findUserByEmail(email);
    // An unknown email still pays for a real scrypt check, so its timing does not reveal that it is unknown.
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const passwordMatches = await verify(password, user?.passwordHash ?? (await dummyHash));

    if (user === undefined || !passwordMatches) {
      loginAttempts.recordFailure(key);
      sendJson(response, 401, { error: WRONG_CREDENTIALS });
      return;
    }

    loginAttempts.clear(key);
    const existing = await currentSession(request);
    if (existing === undefined) {
      await startSession(response, 'host', null, null);
    } else {
      // Signing in again retires the previous session and keeps the seat it was holding.
      const token = randomBytes(32).toString('base64url');
      await store.replaceSession({
        session: sessionRecord(token, 'host', existing.role, null, existing.meetingId),
        replaces: existing.tokenHash,
      });
      response.setHeader('set-cookie', sessionCookie(token, secureCookies));
      notifySessionEnded(existing.tokenHash);
    }
    sendJson(response, 200, { kind: 'host' });
  }

  async function handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = readSessionCookie(request);
    if (token !== undefined) {
      const tokenHash = hashToken(token);
      await store.releaseSeats({ holder: tokenHash });
      await store.deleteSession(tokenHash);
      notifySessionEnded(tokenHash);
    }
    response.setHeader('set-cookie', clearSessionCookie(secureCookies));
    sendJson(response, 200, { ok: true });
  }

  async function handleMe(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = await currentSession(request);
    if (session === undefined) {
      sendJson(response, 401, { error: 'Not signed in', authEnabled: true });
      return;
    }
    // Host and participant sessions taken in a meeting still belong to the signed-in account:
    // the seat is a meeting role, never a downgrade of the account. The legacy password host has
    // no user id and stays a plain host.
    const accountId =
      session.kind === 'user' || session.kind === 'host' || session.kind === 'participant'
        ? session.userId
        : null;
    if (accountId !== null && accountId !== undefined) {
      const user = await store.findUserById(accountId);
      if (user === undefined) {
        sendJson(response, 401, { error: 'Not signed in', authEnabled: true });
        return;
      }
      sendJson(response, 200, {
        kind: 'user',
        user: { id: user.id, name: user.name ?? user.email, email: user.email },
        authEnabled: true,
      });
      return;
    }
    if (session.kind === 'user') {
      sendJson(response, 401, { error: 'Not signed in', authEnabled: true });
      return;
    }
    if (session.kind === 'guest') {
      sendJson(response, 200, {
        kind: 'guest',
        name: session.displayName ?? '',
        authEnabled: true,
      });
      return;
    }
    // A real meeting's seat carries no practice code; it is held by its own meeting id and claim.
    if (
      session.kind === 'participant' &&
      session.meetingCode !== null &&
      (session.meetingCode !== meetingCode.value || session.meetingId !== currentMeetingId())
    ) {
      // The phone's meeting is gone: it must join again with the code on the screen.
      sendJson(response, 403, { error: MEETING_ENDED_MESSAGE, authEnabled: true, ended: true });
      return;
    }
    if (
      session.kind === 'participant' &&
      (session.role === null || !(await sessionOwnsSeat(session, session.role)))
    ) {
      // The session no longer holds a seat, so it cannot act as one.
      sendJson(response, 401, { error: 'Not signed in', authEnabled: true });
      return;
    }
    sendJson(
      response,
      200,
      session.kind === 'host'
        ? { kind: 'host', authEnabled: true }
        : { kind: 'participant', role: session.role, authEnabled: true },
    );
  }

  async function handleJoin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readJsonBody(request, MAX_BODY_BYTES);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    if (!isObject(parsed.value)) {
      sendJson(response, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const rawCode = stringField(parsed.value, 'code');
    const role = stringField(parsed.value, 'role');
    const ip = clientAddress(request);

    // The checks and the seat claim are one admission step: a close, reset or practice handoff that
    // arrives while this join waits must be seen as a changed meeting, never entered silently.
    const run = async (): Promise<void> => {
      // The identity this join was validated against. The claim must enter exactly this meeting.
      const meetingIdAtStart = currentMeetingId();
      const meetingChanged = (): boolean => currentMeetingId() !== meetingIdAtStart;

      // A practice meeting has one visitor and one seat. `/api/join` may admit that exact seat only
      // when the request carries the meeting's capability; it never creates a sign-in session, so
      // the practice principal can never reach setup or another role's authority.
      const kind = joinGuard?.meetingKind();
      if (kind === 'practice') {
        if (joinGuard?.hasPracticeCapability(request) !== true) {
          sendJson(response, 403, { error: 'Practice access belongs to its practice meeting only.' });
          return;
        }
        if (role === undefined || role.trim() === '') {
          sendJson(response, 400, { error: 'Choose your role.' });
          return;
        }
        const seat = joinGuard.practiceSeat();
        if (seat === undefined || role.trim().toLowerCase() !== seat.trim().toLowerCase()) {
          sendJson(response, 403, { error: 'A practice meeting only opens the seat its visitor took.' });
          return;
        }
        if (meetingChanged()) {
          sendJson(response, 409, {
            error: 'The meeting changed while you were joining; try again in a moment.',
            retryable: true,
          });
          return;
        }
        sendJson(response, 200, { kind: 'practice', role: seat });
        return;
      }
      // No legacy join: a team-meeting sign-in exists only after the owner opened a real meeting.
      if (kind !== 'real') {
        sendJson(response, 409, { error: NO_TEAM_MEETING_MESSAGE });
        return;
      }

      if (meetingCodeAttempts.isLimited(ip)) {
        sendJson(response, 429, { error: MEETING_CODE_RATE_LIMIT_MESSAGE });
        return;
      }
      if (rawCode === undefined || rawCode.trim() === '') {
        sendJson(response, 400, { error: 'Enter the meeting code.' });
        return;
      }
      if (rawCode.trim().toUpperCase() !== meetingCode.value) {
        meetingCodeAttempts.recordFailure(ip);
        sendJson(response, 403, { error: 'That meeting code is not valid.' });
        return;
      }
      meetingCodeAttempts.clear(ip);
      if (role === undefined || role.trim() === '') {
        sendJson(response, 400, { error: 'Choose your role.' });
        return;
      }
      if (!seatIsOffered(role)) {
        sendJson(response, 403, { error: 'That role is not a human seat in this meeting.' });
        return;
      }
      if (!(await enterSeat(request, response, role, meetingIdAtStart))) {
        if (meetingChanged()) {
          sendJson(response, 409, {
            error: 'The meeting changed while you were joining; try again in a moment.',
            retryable: true,
          });
          return;
        }
        const departedGraceMs = joinGuard?.departedSeatGraceMs(role);
        if (departedGraceMs !== undefined) {
          sendJson(response, 409, { error: seatKeptForDepartedMessage(departedGraceMs) });
          return;
        }
        sendJson(response, 409, { error: 'That seat is taken. Pick another role.' });
        return;
      }
      sendJson(response, 200, { kind: 'participant', role });
    };

    if (joinGuard === undefined) await run();
    else await joinGuard.admit(run);
  }

  /**
   * The one principal resolution shared by HTTP and WebSocket upgrades. A phone belongs to one
   * meeting, not merely to a code, so a fixed code cannot carry it into the next meeting.
   */
  async function resolveRequest(
    request: IncomingMessage,
    expectedMeetingId?: string,
  ): Promise<
    | { ok: true; session: SessionRecord; principal: Principal }
    | { ok: false; ended: boolean }
  > {
    const session = await currentSession(request);
    if (session === undefined) return { ok: false, ended: false };

    if (session.kind === 'user') {
      const userId = session.userId ?? null;
      const user = userId === null ? undefined : await store.findUserById(userId);
      if (user === undefined || userId === null) return { ok: false, ended: false };
      const name = user.name ?? user.email;
      // A real meeting's host is its owner or a workspace admin, never merely a signed-in visitor.
      if (
        expectedMeetingId !== undefined &&
        meetingHost !== undefined &&
        (await meetingHost(expectedMeetingId, userId))
      ) {
        return { ok: true, session, principal: { kind: 'host', userId, name } };
      }
      return { ok: true, session, principal: { kind: 'user', userId, name } };
    }

    if (session.kind === 'guest') {
      // A guest belongs to exactly one meeting; its cookie is useless on any other.
      if (expectedMeetingId !== undefined && session.meetingId !== expectedMeetingId) {
        return { ok: false, ended: false };
      }
      return {
        ok: true,
        session,
        principal: {
          kind: 'guest',
          meetingId: session.meetingId ?? '',
          name: session.displayName ?? '',
          guestId: session.tokenHash,
        },
      };
    }

    if (session.kind === 'host' && expectedMeetingId !== undefined) {
      // A password host owns the legacy meeting only. A real meeting's host session carries the
      // product user's id, and its ownership is re-checked on every request so a host session
      // taken in one meeting can never act as the host of another.
      if (
        session.userId === null ||
        session.userId === undefined ||
        meetingHost === undefined ||
        !(await meetingHost(expectedMeetingId, session.userId))
      ) {
        return { ok: false, ended: false };
      }
    }

    // A real meeting's seat carries no practice code: outside that meeting's own routes (account
    // pages, say) it still stands for its own meeting, and the claim check below keeps it honest.
    const realSeat = session.kind === 'participant' && session.meetingCode === null;
    const meetingId =
      expectedMeetingId ?? (realSeat ? (session.meetingId ?? currentMeetingId()) : currentMeetingId());
    if (session.kind === 'participant') {
      const ended =
        session.meetingId !== meetingId ||
        (!realSeat && session.meetingCode !== meetingCode.value);
      if (ended) return { ok: false, ended: true };
    }
    let principal = principalFor(session, meetingId);
    if (principal.kind === 'host' && session.userId !== null && session.userId !== undefined) {
      principal = {
        ...principal,
        userId: session.userId,
        ...(session.displayName === null || session.displayName === undefined
          ? {}
          : { name: session.displayName }),
      };
    } else if (principal.kind === 'seat') {
      principal = {
        ...principal,
        ...(session.userId === null || session.userId === undefined ? {} : { userId: session.userId }),
        ...(session.displayName === null || session.displayName === undefined
          ? {}
          : { name: session.displayName }),
      };
    }
    if (principal.kind === 'seat') {
      // A session that no longer owns its claim is not a seat, whatever role it recorded.
      if (!(await sessionOwnsSeat(session, principal.role))) return { ok: false, ended: false };
    } else if (principal.kind === 'host' && principal.seat !== undefined) {
      // A host keeps every host power, but the seat view belongs only to its current claim owner.
      if (!(await sessionOwnsSeat(session, principal.seat))) principal = { kind: 'host' };
    }
    return { ok: true, session, principal };
  }

  log('kaki auth: enabled');

  return {
    meetingCodeLimiter: meetingCodeAttempts,
    store,
    secureCookies,
    enterSeat,

    bindMeetingIdentity(meetingId) {
      meetingIdentity = meetingId;
    },

    bindMeetingHost(handler) {
      meetingHost = handler;
    },

    async createGuestSession(meetingId, name) {
      const token = randomBytes(32).toString('base64url');
      await store.createSession(
        sessionRecord(token, 'guest', null, null, meetingId, name, null),
      );
      return sessionCookie(token, secureCookies);
    },

    bindOfferedSeats(offered) {
      offeredRoles = offered;
    },

    bindJoinGuard(guard) {
      joinGuard = guard;
    },

    async releaseMeeting(meetingId) {
      await store.releaseSeats({ meetingId });
    },

    onSessionEnded(handler) {
      sessionEndedHandlers.add(handler);
    },

    async resolvePrincipal(request, meetingId) {
      const resolved = await resolveRequest(request, meetingId);
      return resolved.ok ? resolved.principal : undefined;
    },

    async handleHttp(request, response) {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (request.method === 'POST' && path === '/api/auth/login') {
        await handleLogin(request, response);
        return true;
      }
      if (request.method === 'POST' && path === '/api/auth/logout') {
        await handleLogout(request, response);
        return true;
      }
      if (request.method === 'GET' && path === '/api/auth/me') {
        await handleMe(request, response);
        return true;
      }
      if (
        request.method === 'GET' &&
        (path === '/api/auth/google/start' || path === '/api/auth/google/callback')
      ) {
        if (google === undefined) {
          sendAuthFailure(request, response, 503, GOOGLE_NOT_SET_UP_MESSAGE);
        } else {
          await google.handleHttp(request, response);
        }
        return true;
      }
      if (request.method === 'POST' && path === '/api/join') {
        await handleJoin(request, response);
        return true;
      }
      return false;
    },

    async authorize(request, audience, meetingId, options = {}) {
      const resolved = await resolveRequest(request, meetingId);
      if (!resolved.ok) {
        return { ok: false, message: resolved.ended ? MEETING_ENDED_MESSAGE : 'Sign in required' };
      }
      const { session, principal } = resolved;
      const participant = session.kind === 'participant';
      const sessionTokenHash = session.tokenHash;
      // Any signed-in person may follow the read-only lifecycle of their own meeting; on the legacy
      // meeting a product user or guest is refused exactly like an anonymous visitor.
      if (audience.kind === 'lifecycle') {
        if (
          meetingId === undefined &&
          (session.kind === 'user' || session.kind === 'guest')
        ) {
          return { ok: false, message: 'Sign in required' };
        }
        return { ok: true, participant, principal, sessionTokenHash };
      }
      if (audience.kind === 'screen') {
        // The shared screen is the owner's: it carries every seat's private facts and unfinished
        // drafts. A participant follows the meeting through their own projection instead. A real
        // meeting's host is its owner or a workspace admin (a `user` session resolved to `host`),
        // while the legacy password owner is already a `host` session.
        if (principal.kind !== 'host') {
          return { ok: false, message: 'Only the meeting owner can follow the shared screen' };
        }
        // An owner who also holds a seat reads that seat's private Wingman notes on this screen.
        return {
          ok: true,
          participant,
          principal,
          sessionTokenHash,
          ...(principal.seat === undefined ? {} : { seat: principal.seat }),
        };
      }
      if (audience.kind === 'participant') {
        // A participant projection is bound to one seat; the hub redacts every other seat's work.
        if (principal.kind === 'seat') {
          return { ok: true, participant, principal, sessionTokenHash, seat: principal.role };
        }
        if (principal.kind === 'host' && principal.seat !== undefined) {
          return { ok: true, participant, principal, sessionTokenHash, seat: principal.seat };
        }
        return { ok: false, message: 'Join this meeting with a role first' };
      }
      // A participant holds their seat; a host may also hold the seat they took, without losing host powers.
      const role = audience.kind === 'role' ? audience.role : undefined;
      const holdsSeat =
        role !== undefined &&
        (options.anyOfferedSeat === true || seatIsOffered(role)) &&
        ((principal.kind === 'seat' && principal.role === role) ||
          (principal.kind === 'host' && principal.seat === role));
      if (!holdsSeat) {
        return { ok: false, message: 'Join this meeting with that role first' };
      }
      return { ok: true, participant, principal, sessionTokenHash };
    },

    async close() {
      loginAttempts.clearAll();
      meetingCodeAttempts.clearAll();
      sessionEndedHandlers.clear();
      await store.close();
    },
  };
}

/** Create the host account from env if it does not exist; never overwrite one. */
async function bootstrapHostAccount(
  store: AuthStore,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = (message) => console.log(message),
): Promise<void> {
  const rawEmail = env.KAKI_HOST_EMAIL?.trim();
  const password = env.KAKI_HOST_PASSWORD;

  if ((rawEmail === undefined || rawEmail === '') && (password === undefined || password === '')) {
    return;
  }
  if (rawEmail === undefined || rawEmail === '' || password === undefined || password === '') {
    throw new Error(
      'kaki auth: set both KAKI_HOST_EMAIL and KAKI_HOST_PASSWORD, or neither of them.',
    );
  }

  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) {
    throw new Error(`kaki auth: KAKI_HOST_EMAIL "${rawEmail}" is not a valid email address.`);
  }

  const existing = await store.findUserByEmail(email);
  if (existing !== undefined) return;

  await store.createUser({ email, passwordHash: await hashPassword(password) });
  log(`kaki auth: created the host account ${email}`);
}

/** Session cookies need `Secure` whenever the public site is served over https. */
export function secureCookiesFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return publicUrlIsHttps(env);
}

/** Build the Postgres-backed auth feature from environment variables. */
export async function createAuthFromEnv({
  meetingCode,
  env = process.env,
  now = Date.now,
}: {
  meetingCode: MeetingCodeSource;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<Auth> {
  const connectionString = env.POSTGRES_URL?.trim();
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'kaki auth: KAKI_AUTH=1 needs POSTGRES_URL set to the Postgres connection string.',
    );
  }
  const serviceToken = env.KAKI_SERVICE_TOKEN?.trim();
  if (serviceToken === undefined || serviceToken === '') {
    throw new Error(
      'kaki auth: KAKI_AUTH=1 needs KAKI_SERVICE_TOKEN (the same value for the server and npm run npc), or the AI colleagues cannot open the meeting.',
    );
  }

  const pool = new Pool({ connectionString });
  // An idle connection dying (database restart) must not crash the server.
  pool.on('error', (error) => console.error('kaki auth: database error', error));
  try {
    await ensureAuthSchema(pool);
    const store = createPostgresAuthStore(pool);
    await bootstrapHostAccount(store, env);
    const secureCookies = secureCookiesFromEnv(env);
    const google = createGoogleFromEnv(env, { store, secureCookies, now });
    if (google === undefined) {
      console.log(
        'kaki auth: Google sign-in is off: set KAKI_GOOGLE_CLIENT_ID, KAKI_GOOGLE_CLIENT_SECRET and KAKI_PUBLIC_URL to turn it on.',
      );
    }
    return createAuth({
      store,
      meetingCode,
      secureCookies,
      now,
      ...(google === undefined ? {} : { google }),
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** Build the Google flow only when every credential is present; never fall back silently. */
function createGoogleFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { store: AuthStore; secureCookies: boolean; now: () => number },
): GoogleSignIn | undefined {
  const clientId = env.KAKI_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.KAKI_GOOGLE_CLIENT_SECRET?.trim();
  const publicUrl = env.KAKI_PUBLIC_URL?.trim();
  if (
    clientId === undefined ||
    clientId === '' ||
    clientSecret === undefined ||
    clientSecret === '' ||
    publicUrl === undefined ||
    publicUrl === ''
  ) {
    return undefined;
  }
  return createGoogleSignIn({
    store: deps.store,
    clientId,
    clientSecret,
    publicUrl,
    secureCookies: deps.secureCookies,
    now: deps.now,
  });
}
