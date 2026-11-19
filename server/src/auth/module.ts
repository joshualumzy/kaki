import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import type { ClientAudience } from '../hub';
import { MEETING_ENDED_MESSAGE, type MeetingCodeSource } from '../meetingCode';
import { clearSessionCookie, readSessionCookie, SESSION_TTL_MS, sessionCookie } from './cookie';
import { hashPassword, hashToken, verifyPassword } from './password';
import { createPostgresAuthStore } from './postgres';
import { ensureAuthSchema } from './schema';
import type { AuthStore, SessionKind, SessionRecord } from './store';

/** The result of checking a WebSocket upgrade against the session cookie. */
export type AuthDecision = { ok: true } | { ok: false; message: string };

/** The auth feature the HTTP server and WebSocket hub call into. */
export interface Auth {
  /** Handle an auth or join request; false means the path belongs to another route. */
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Allow or reject a `/ws?role=` upgrade for the requested audience. */
  authorize(request: IncomingMessage, audience: ClientAudience): Promise<AuthDecision>;
  close(): Promise<void>;
}

/** Everything the auth module needs, injected so tests can use an in-memory store. */
export interface AuthOptions {
  store: AuthStore;
  roles: readonly string[];
  meetingCode: MeetingCodeSource;
  secureCookies?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 64_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

const WRONG_CREDENTIALS = 'Email or password is incorrect.';

interface FailureWindow {
  count: number;
  resetAt: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

async function readJsonBody(request: IncomingMessage): Promise<ParsedBody> {
  let text: string;
  try {
    text = await readBody(request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not read body' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'Body must be valid JSON' };
  }
}

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

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

/** Create the auth feature: endpoints, session cookies and WebSocket gating. */
export function createAuth({
  store,
  roles,
  meetingCode,
  secureCookies = false,
  now = Date.now,
  log = () => undefined,
}: AuthOptions): Auth {
  const failures = new Map<string, FailureWindow>();

  function pruneFailures(at: number): void {
    if (failures.size < 5_000) return;
    for (const [key, window] of failures) {
      if (window.resetAt <= at) failures.delete(key);
    }
  }

  function isRateLimited(key: string, at: number): boolean {
    const window = failures.get(key);
    if (window === undefined) return false;
    if (window.resetAt <= at) {
      failures.delete(key);
      return false;
    }
    return window.count >= LOGIN_FAILURE_LIMIT;
  }

  function recordFailure(key: string, at: number): void {
    const window = failures.get(key);
    if (window === undefined || window.resetAt <= at) {
      failures.set(key, { count: 1, resetAt: at + LOGIN_WINDOW_MS });
      return;
    }
    window.count += 1;
  }

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

  async function startSession(
    response: ServerResponse,
    kind: SessionKind,
    role: string | null,
    code: string | null,
  ): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await store.createSession({
      tokenHash: hashToken(token),
      kind,
      role,
      meetingCode: code,
      expiresAt: new Date(now() + SESSION_TTL_MS),
    });
    response.setHeader('set-cookie', sessionCookie(token, secureCookies));
  }

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readJsonBody(request);
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

    const at = now();
    pruneFailures(at);
    const key = `${clientIp(request)}|${email}`;
    if (isRateLimited(key, at)) {
      sendJson(response, 429, {
        error: 'Too many sign-in attempts. Wait a minute and try again.',
      });
      return;
    }

    const user = await store.findUserByEmail(email);
    const passwordMatches = user === undefined ? false : await verifyPassword(password, user.passwordHash);

    if (!passwordMatches) {
      recordFailure(key, at);
      sendJson(response, 401, { error: WRONG_CREDENTIALS });
      return;
    }

    failures.delete(key);
    await startSession(response, 'host', null, null);
    sendJson(response, 200, { kind: 'host' });
  }

  async function handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = readSessionCookie(request);
    if (token !== undefined) {
      await store.deleteSession(hashToken(token));
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
    if (session.kind === 'participant' && session.meetingCode !== meetingCode.value) {
      // The phone's meeting is gone: it must join again with the code on the screen.
      sendJson(response, 403, { error: MEETING_ENDED_MESSAGE, authEnabled: true });
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
    const parsed = await readJsonBody(request);
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

    if (rawCode === undefined || rawCode.trim() === '') {
      sendJson(response, 400, { error: 'Enter the meeting code.' });
      return;
    }
    if (rawCode.trim().toUpperCase() !== meetingCode.value) {
      sendJson(response, 403, { error: 'That meeting code is not valid.' });
      return;
    }
    if (role === undefined || role.trim() === '') {
      sendJson(response, 400, { error: 'Choose your role.' });
      return;
    }
    if (!roles.includes(role)) {
      sendJson(response, 403, { error: 'That role is not a human seat in this meeting.' });
      return;
    }

    await startSession(response, 'participant', role, meetingCode.value);
    sendJson(response, 200, { kind: 'participant', role });
  }

  async function handleMeetingCode(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = await currentSession(request);
    if (session === undefined) {
      sendJson(response, 401, { error: 'Sign in as the host.' });
      return;
    }
    if (session.kind !== 'host') {
      sendJson(response, 403, { error: 'Only the host can see the meeting code.' });
      return;
    }
    sendJson(response, 200, { code: meetingCode.value });
  }

  log(`kaki auth: enabled with meeting code ${meetingCode.value}`);

  return {
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
      if (request.method === 'POST' && path === '/api/join') {
        await handleJoin(request, response);
        return true;
      }
      if (request.method === 'GET' && path === '/api/meeting-code') {
        await handleMeetingCode(request, response);
        return true;
      }
      return false;
    },

    async authorize(request, audience) {
      const session = await currentSession(request);
      if (session === undefined) {
        return { ok: false, message: 'Sign in required' };
      }
      // A phone signed into the previous meeting must not follow the new one, even read-only.
      if (session.kind === 'participant' && session.meetingCode !== meetingCode.value) {
        return { ok: false, message: MEETING_ENDED_MESSAGE };
      }
      // Any signed-in person may follow the read-only start/reset lifecycle; it drives no meeting state.
      if (audience === 'lifecycle') {
        return { ok: true };
      }
      if (audience === 'screen') {
        return session.kind === 'host'
          ? { ok: true }
          : { ok: false, message: 'Host sign-in required' };
      }
      if (session.kind !== 'participant' || session.role !== audience || !roles.includes(audience)) {
        return { ok: false, message: 'Join this meeting with that role first' };
      }
      return { ok: true };
    },

    async close() {
      failures.clear();
      await store.close();
    },
  };
}

/** Create the host account from env if it does not exist; never overwrite one. */
export async function bootstrapHostAccount(
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

/** Build the Postgres-backed auth feature from environment variables. */
export async function createAuthFromEnv({
  roles,
  meetingCode,
  env = process.env,
  now = Date.now,
}: {
  roles: readonly string[];
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
    return createAuth({
      store,
      roles,
      meetingCode,
      secureCookies: (env.KAKI_PUBLIC_URL ?? '').trim().startsWith('https'),
      now,
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
