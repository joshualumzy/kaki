import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/http';
import type { AuthStore } from './store';
import { hashToken } from './password';
import { SESSION_TTL_MS, sessionCookie } from './cookie';

/** The URLs Google's OAuth and OpenID endpoints live at, injectable so tests never call Google. */
export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
};

/** The exact message the sign-in page shows when this server has no Google credentials. */
export const GOOGLE_NOT_SET_UP_MESSAGE = "Google sign-in isn't set up on this server yet";

const OAUTH_COOKIE = 'kaki_google_oauth';
const OAUTH_TTL_SECONDS = 10 * 60;
const ALLOWED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export interface GoogleSignIn {
  /** Handle `/api/auth/google/start` or `/callback`; false means another route owns the path. */
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface GoogleOptions {
  store: AuthStore;
  clientId: string;
  clientSecret: string;
  /** The public https base browsers use; the callback URL is built from it. */
  publicUrl: string;
  secureCookies?: boolean;
  endpoints?: GoogleEndpoints;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface OAuthState {
  state: string;
  verifier: string;
  next: string;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  email_verified?: unknown;
}

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJsonPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
}

function oauthCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (value === '') return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Only same-origin paths become the post-sign-in destination. A leading `//` or `/\` would let the
 * browser leave this site, so anything other than a single-slash path falls back to `/`.
 */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

function parseStateCookie(value: string): OAuthState | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') return undefined;
    return { state: parsed.state, verifier: parsed.verifier, next: safeNext(parsed.next) };
  } catch {
    return undefined;
  }
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === 'string') return aud === clientId;
  return Array.isArray(aud) && aud.includes(clientId);
}

function isEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

function selectJwk(keys: readonly Jwk[], kid: unknown): Jwk | undefined {
  const signing = keys.filter((key) => key.kty === 'RSA' && key.n !== undefined && key.e !== undefined);
  if (typeof kid === 'string') {
    const exact = signing.find((key) => key.kid === kid);
    if (exact !== undefined) return exact;
  }
  return signing.length === 1 ? signing[0] : undefined;
}

function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  clientId: string,
  nowMs: number,
): { sub: string; email: string; name: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('the ID token is not a JWT');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeJsonPart(encodedHeader) as { alg?: unknown; kid?: unknown };
  if (header.alg !== 'RS256') throw new Error(`unsupported ID token algorithm ${String(header.alg)}`);
  const jwk = selectJwk(keys, header.kid);
  if (jwk === undefined) throw new Error('no matching JWKS key for the ID token');
  const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!valid) throw new Error('the ID token signature is invalid');

  const claims = decodeJsonPart(encodedPayload) as IdTokenClaims;
  if (typeof claims.iss !== 'string' || !ALLOWED_ISSUERS.has(claims.iss)) {
    throw new Error('the ID token issuer is not Google');
  }
  if (!audienceMatches(claims.aud, clientId)) throw new Error('the ID token is for another client');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new Error('the ID token has expired');
  }
  if (!isEmailVerified(claims.email_verified)) throw new Error('the Google email is not verified');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('the ID token has no subject');
  if (typeof claims.email !== 'string' || claims.email === '') throw new Error('the ID token has no email');
  const name =
    typeof claims.name === 'string' && claims.name.trim() !== ''
      ? claims.name.trim()
      : claims.email.split('@')[0] ?? claims.email;
  return { sub: claims.sub, email: claims.email, name };
}

/** Build the server-side Google code flow (PKCE + JWKS signature verification). */
export function createGoogleSignIn({
  store,
  clientId,
  clientSecret,
  publicUrl,
  secureCookies = false,
  endpoints = GOOGLE_ENDPOINTS,
  fetch: fetchImpl = fetch,
  now = Date.now,
  log = () => undefined,
}: GoogleOptions): GoogleSignIn {
  const callbackUrl = `${publicUrl.replace(/\/+$/, '')}/api/auth/google/callback`;

  async function exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await fetchImpl(endpoints.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`the token endpoint answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string' || body.id_token === '') {
      throw new Error('the token endpoint returned no ID token');
    }
    return body.id_token;
  }

  async function fetchJwks(): Promise<Jwk[]> {
    const response = await fetchImpl(endpoints.jwksUrl);
    if (!response.ok) throw new Error(`the JWKS endpoint answered HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error('the JWKS response has no keys');
    return body.keys as Jwk[];
  }

  async function handleStart(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const next = safeNext(url.searchParams.get('next'));

    response.setHeader(
      'set-cookie',
      oauthCookie(base64Json({ state, verifier, next } satisfies OAuthState), OAUTH_TTL_SECONDS, secureCookies),
    );

    const target = new URL(endpoints.authUrl);
    target.searchParams.set('client_id', clientId);
    target.searchParams.set('redirect_uri', callbackUrl);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'openid email profile');
    target.searchParams.set('state', state);
    target.searchParams.set('code_challenge', challenge);
    target.searchParams.set('code_challenge_method', 'S256');
    redirect(response, target.toString());
  }

  async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const rawStateCookie = readCookie(request, OAUTH_COOKIE);
    if (rawStateCookie === undefined) {
      sendJson(response, 400, { error: 'Google sign-in expired. Try again.' });
      return;
    }
    const stored = parseStateCookie(rawStateCookie);
    if (stored === undefined) {
      sendJson(response, 400, { error: 'Google sign-in expired. Try again.' });
      return;
    }
    const state = url.searchParams.get('state');
    if (state === null || state !== stored.state) {
      sendJson(response, 400, { error: 'Google sign-in could not be verified. Try again.' });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      sendJson(response, 400, { error: 'Google sign-in did not return a code. Try again.' });
      return;
    }

    let profile: { sub: string; email: string; name: string };
    try {
      const idToken = await exchangeCode(code, stored.verifier);
      profile = verifyIdToken(idToken, await fetchJwks(), clientId, now());
    } catch (error) {
      // Never log the token or the code: only the reason verification failed.
      log(`kaki auth: Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(response, 401, { error: 'Google sign-in could not be verified. Try again.' });
      return;
    }

    let user;
    try {
      const existing = await store.findUserByGoogleSub(profile.sub);
      user =
        existing ??
        (await store.createGoogleUser({
          googleSub: profile.sub,
          name: profile.name,
          email: profile.email,
        }));
      if (existing !== undefined) {
        await store.updateUserProfile({ id: user.id, name: profile.name, email: profile.email });
      }
    } catch (error) {
      log(`kaki auth: could not save the Google user: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(response, 500, { error: 'Google sign-in could not be saved. Try again.' });
      return;
    }

    const token = randomBytes(32).toString('base64url');
    await store.createSession({
      tokenHash: hashToken(token),
      kind: 'user',
      role: null,
      meetingCode: null,
      meetingId: null,
      displayName: user.name ?? profile.name,
      userId: user.id,
      expiresAt: new Date(now() + SESSION_TTL_MS),
    });

    response.setHeader('set-cookie', [
      sessionCookie(token, secureCookies),
      oauthCookie('', 0, secureCookies),
    ]);
    redirect(response, stored.next);
  }

  return {
    async handleHttp(request, response) {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method !== 'GET') return false;
      if (path === '/api/auth/google/start') {
        await handleStart(request, response);
        return true;
      }
      if (path === '/api/auth/google/callback') {
        await handleCallback(request, response);
        return true;
      }
      return false;
    },
  };
}
