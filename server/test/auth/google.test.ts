import { generateKeyPairSync, sign, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type KakiApp } from '../../src/app';
import { createGoogleSignIn, GOOGLE_NOT_SET_UP_MESSAGE } from '../../src/auth/google';
import { createAuth, type Auth } from '../../src/auth/module';
import { createMemoryAuthStore, type AuthStore } from '../../src/auth/store';
import { createMemoryMeetingStore } from '../../src/meeting/registry';
import { createMeetingCodeSource } from '../../src/meeting/meetingCode';
import { testScenario } from '../fixtures/scenario';
import { portOf } from '../helpers';

const CLIENT_ID = 'kaki-test-client';
const CLIENT_SECRET = 'kaki-test-secret';
const PUBLIC_URL = 'https://kaki.test';

let privateKey: KeyObject;
let otherPrivateKey: KeyObject;
let publicJwk: Record<string, unknown>;
let oidc: Server;
let oidcBase: string;
let issuedToken = '';

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  otherPrivateKey = other.privateKey;

  oidc = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id_token: issuedToken }));
      return;
    }
    if (request.method === 'GET' && request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => oidc.listen(0, '127.0.0.1', resolve));
  oidcBase = `http://127.0.0.1:${(oidc.address() as AddressInfo).port}`;
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: `google-${randomUUID()}`,
    email: `ada-${randomUUID()}@example.com`,
    name: 'Ada Lovelace',
    email_verified: true,
    ...overrides,
  };
}

function token(value: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw == null ? [] : [raw];
}

function cookiePair(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(';')[0];
}

const apps: KakiApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface BuiltApp {
  app: KakiApp;
  auth: Auth;
  store: AuthStore;
  base: string;
}

async function buildApp(withGoogle = true): Promise<BuiltApp> {
  const store = createMemoryAuthStore();
  const meetingCode = createMeetingCodeSource('K7M2Q9');
  const auth = createAuth({
    store,
    meetingCode,
    ...(withGoogle
      ? {
          google: createGoogleSignIn({
            store,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            publicUrl: PUBLIC_URL,
            endpoints: {
              authUrl: `${oidcBase}/auth`,
              tokenUrl: `${oidcBase}/token`,
              jwksUrl: `${oidcBase}/jwks`,
            },
            secureCookies: false,
          }),
        }
      : {}),
  });
  const app = await createApp({
    scenario: testScenario,
    speechRecognition: 'browser',
    auth,
    meetingCode,
    meetings: createMemoryMeetingStore(),
  });
  apps.push(app);
  return { app, auth, store, base: `http://127.0.0.1:${portOf(app)}` };
}

async function startSignIn(base: string, next?: string): Promise<{ state: string; cookie: string }> {
  const query = next === undefined ? '' : `?next=${encodeURIComponent(next)}`;
  const response = await fetch(`${base}/api/auth/google/start${query}`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  if (location === null) throw new Error('the start route did not redirect');
  const state = new URL(location).searchParams.get('state');
  const cookie = cookiePair(setCookies(response), 'kaki_google_oauth');
  if (state === null || cookie === undefined) throw new Error('the start route did not set state');
  return { state, cookie };
}

function callback(base: string, state: string, cookie?: string): Promise<Response> {
  return fetch(
    `${base}/api/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    {
      redirect: 'manual',
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    },
  );
}

describe('Google sign-in', () => {
  it('creates a user, their personal workspace and a session, then redirects to next', async () => {
    const { base, store } = await buildApp();
    const signIn = await startSignIn(base, '/m/abc');
    const tokenClaims = claims({
      sub: 'google-happy',
      email: 'happy@example.com',
      picture: 'https://photos.example/ada.jpg',
    });
    issuedToken = token(tokenClaims);

    const response = await callback(base, signIn.state, signIn.cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/m/abc');
    const session = cookiePair(setCookies(response), 'kaki_session');
    expect(session).toBeDefined();

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: session! } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      kind: 'user',
      user: { id: expect.any(String), name: 'Ada Lovelace', email: 'happy@example.com' },
      authEnabled: true,
    });

    const user = await store.findUserByGoogleSub('google-happy');
    expect(user).toBeDefined();
    expect(user?.picture).toBe('https://photos.example/ada.jpg');
    const workspaces = await store.listWorkspacesForUser(user!.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      workspace: { name: 'My workspace', kind: 'personal' },
      role: 'admin',
    });
  });

  it('reuses the user and creates no second workspace on second sign-in', async () => {
    const { base, store } = await buildApp();
    const tokenClaims = claims({ sub: 'google-returning', email: 'returning@example.com' });

    const first = await startSignIn(base);
    issuedToken = token(tokenClaims);
    expect((await callback(base, first.state, first.cookie)).status).toBe(302);
    const user = await store.findUserByGoogleSub('google-returning');

    const second = await startSignIn(base);
    expect((await callback(base, second.state, second.cookie)).status).toBe(302);
    const again = await store.findUserByGoogleSub('google-returning');
    expect(again?.id).toBe(user?.id);
    expect(await store.listWorkspacesForUser(user!.id)).toHaveLength(1);
  });

  it('rejects a wrong state', async () => {
    const { base, store } = await buildApp();
    const signIn = await startSignIn(base);
    issuedToken = token(claims({ sub: 'google-wrong-state' }));

    const response = await callback(base, 'not-the-state', signIn.cookie);
    expect(response.status).toBe(400);
    expect(cookiePair(setCookies(response), 'kaki_session')).toBeUndefined();
    expect(await store.findUserByGoogleSub('google-wrong-state')).toBeUndefined();
  });

  it('rejects a callback with no state cookie', async () => {
    const { base } = await buildApp();
    const signIn = await startSignIn(base);
    issuedToken = token(claims());

    const response = await callback(base, signIn.state);
    expect(response.status).toBe(400);
  });

  it('rejects a bad signature, wrong audience, expired token and unverified email', async () => {
    const { base, store } = await buildApp();

    const rejected: Array<{ key?: KeyObject; value: Record<string, unknown> }> = [
      { key: otherPrivateKey, value: claims({ sub: 'google-bad-signature' }) },
      { value: claims({ sub: 'google-wrong-aud', aud: 'another-client' }) },
      { value: claims({ sub: 'google-expired', exp: Math.floor(Date.now() / 1000) - 10 }) },
      { value: claims({ sub: 'google-unverified', email_verified: false }) },
    ];

    for (const entry of rejected) {
      const signIn = await startSignIn(base);
      issuedToken = token(entry.value, entry.key ?? privateKey);
      const response = await callback(base, signIn.state, signIn.cookie);
      expect(response.status).toBe(401);
      expect(cookiePair(setCookies(response), 'kaki_session')).toBeUndefined();
      expect(await store.findUserByGoogleSub(String(entry.value.sub))).toBeUndefined();
    }
  });

  it('falls back to / when next would leave this site', async () => {
    const { base } = await buildApp();
    for (const unsafe of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const signIn = await startSignIn(base, unsafe);
      issuedToken = token(claims());
      const response = await callback(base, signIn.state, signIn.cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
    }
  });

  it('answers 503 with the setup message when Google env is missing', async () => {
    const { base } = await buildApp(false);
    const response = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: GOOGLE_NOT_SET_UP_MESSAGE });
  });

  it('sends a browser navigating the start route back to sign in, never raw JSON', async () => {
    const { base } = await buildApp(false);
    const response = await fetch(`${base}/api/auth/google/start?next=%2Fnew`, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(303);
    const query = new URLSearchParams({ error: GOOGLE_NOT_SET_UP_MESSAGE, next: '/new' });
    expect(response.headers.get('location')).toBe(`/signin?${query.toString()}`);
  });
});
