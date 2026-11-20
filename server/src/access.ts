import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The one access vocabulary shared by HTTP routes and WebSocket audiences. Every route names one
 * of these before any handler runs; nothing else may decide who a request is.
 */
export type Access = 'public' | 'session' | 'host' | 'host-or-practice' | 'seat' | 'service' | 'dev';

export const ACCESS_LEVELS: readonly Access[] = [
  'public',
  'session',
  'host',
  'host-or-practice',
  'seat',
  'service',
  'dev',
];

/** Who a request belongs to, once the access layer has resolved it. */
export type Principal =
  | { kind: 'anonymous' }
  /** A host may also hold a seat they took; they keep every host power either way. */
  | { kind: 'host'; seat?: string }
  | { kind: 'seat'; role: string }
  /**
   * The one visitor in a practice meeting, holding nothing but the right to start that meeting.
   * It ends with the practice meeting and never opens setup, tools, owner routes or a real meeting.
   */
  | { kind: 'practice' }
  | { kind: 'service' };

/** One HTTP route declaration: the method, path pattern and mandatory access level. */
export interface Route {
  method: string;
  /** Exact path, or a path with `:name` segments such as `/api/calendar/:id`. */
  path: string;
  access: Access;
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

export interface AccessContext {
  authEnabled: boolean;
  devRoutes: boolean;
  /** True when a service token is configured, so service routes must present it in every mode. */
  serviceTokenConfigured: boolean;
  /** True when the request came from this machine (not a phone). */
  loopback: boolean;
  /** The raw request target, before URL normalisation, for the dev-route dot-segment guard. */
  rawPath: string;
}

export interface AccessProblem {
  status: number;
  error: string;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? '';
    const actual = pathParts[index] ?? '';
    if (expected.startsWith(':')) {
      if (actual === '') return undefined;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

/** Find the one route that owns this method and path; anything else is a 404. */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): RouteMatch | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

/**
 * The one access check. It runs before any handler and returns the refusal to send, if any.
 * With auth off every route behaves as the trusted demo always did, except a service-only route
 * (which always needs the runner's token when one is configured) and the dev routes.
 */
export function accessProblem(
  route: Route,
  principal: Principal,
  context: AccessContext,
): AccessProblem | undefined {
  switch (route.access) {
    case 'public':
      return undefined;

    case 'dev':
      if (!context.devRoutes || !context.loopback || !context.rawPath.startsWith('/dev/')) {
        return { status: 404, error: 'Not found' };
      }
      if (context.authEnabled) return { status: 404, error: 'Not found' };
      return undefined;

    case 'service':
      // A configured service token always gates its routes, whether user sign-in is on or off.
      if (context.serviceTokenConfigured || context.authEnabled) {
        return principal.kind === 'service'
          ? undefined
          : { status: 401, error: 'Service sign-in required.' };
      }
      // With no credentials configured, only the machine running Kaki may act as the runner.
      return context.loopback ? undefined : { status: 401, error: 'Service sign-in required.' };

    case 'session':
      if (!context.authEnabled) return undefined;
      if (principal.kind === 'host' || principal.kind === 'seat') return undefined;
      return { status: 401, error: 'Sign in required.' };

    case 'host':
      if (!context.authEnabled) return undefined;
      if (principal.kind === 'host') return undefined;
      return {
        status: principal.kind === 'anonymous' ? 401 : 403,
        error: 'Only the meeting owner can do that.',
      };

    case 'host-or-practice':
      // Start: the owner starts their meeting; a practice visitor starts only theirs. The handler
      // re-checks that this is still the practice meeting the capability was granted for.
      if (!context.authEnabled) return undefined;
      if (principal.kind === 'host' || principal.kind === 'practice') return undefined;
      return {
        status: principal.kind === 'anonymous' ? 401 : 403,
        error: 'Only the meeting owner can start this meeting.',
      };

    case 'seat':
      if (!context.authEnabled) return undefined;
      if (principal.kind === 'seat') return undefined;
      return {
        status: principal.kind === 'anonymous' ? 401 : 403,
        error: 'Join this meeting with a seat first.',
      };
  }
}

/** The service token a runner presented, from the Authorization header only. Never the URL. */
export function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const value = header.slice('Bearer '.length).trim();
  return value === '' ? undefined : value;
}

/** Compare two secrets without leaking their length or content through timing. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || expected === '') return false;
  const given = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

const MAX_ADDRESS_LENGTH = 200;

/**
 * The client's address for rate limiting. Behind the cloud proxy every request arrives from
 * 127.0.0.1, so when KAKI_TRUST_PROXY=1 and the direct peer is loopback, take the right-most
 * address in X-Forwarded-For that is not itself a trusted (loopback) proxy. A client can append
 * to the header, so the left-most value is never trusted.
 */
export function clientAddress(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const peer = request.socket.remoteAddress;
  if (env.KAKI_TRUST_PROXY === '1' && isLoopbackAddress(peer)) {
    const header = request.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const chain = (raw ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address !== '');
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const address = chain[index]!;
      if (!isLoopbackHost(address)) return address.slice(0, MAX_ADDRESS_LENGTH);
    }
  }
  return peer ?? 'unknown';
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

/** Whether a bind address is this machine only. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(value) || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

/** Whether a socket's remote address is this machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && isLoopbackHost(address);
}

/** Whether the configured public URL uses https and so needs Secure cookies. */
export function publicUrlIsHttps(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAKI_PUBLIC_URL ?? '').trim().toLowerCase().startsWith('https://');
}

/**
 * Whether this server is reachable by other machines: a non-loopback bind, or a loopback bind
 * published through a proxy at a public KAKI_PUBLIC_URL.
 */
function servesPublicly(host: string, env: NodeJS.ProcessEnv): boolean {
  if (!isLoopbackHost(host)) return true;
  const raw = env.KAKI_PUBLIC_URL?.trim();
  if (raw === undefined || raw === '') return false;
  try {
    return !isLoopbackHost(new URL(raw).hostname);
  } catch {
    return true;
  }
}

/**
 * Refuse a deployment whose https sign-in would redirect to an http Mattermost: Secure cookies
 * cannot authenticate that hop. A public base is accepted only when it is https, or can be derived
 * from an https MATTERMOST_URL; KAKI_ALLOW_OPEN=1 is the explicit trusted-demo escape hatch.
 */
export function assertSafeMattermost(
  authEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!authEnabled || !publicUrlIsHttps(env) || env.KAKI_ALLOW_OPEN === '1') return;
  const internal = env.MATTERMOST_URL?.trim();
  if (internal === undefined || internal === '') return;

  const explicit = env.MATTERMOST_PUBLIC_URL?.trim();
  if (explicit !== undefined && explicit !== '') {
    let publicUrl: URL;
    try {
      publicUrl = new URL(explicit);
    } catch {
      throw new Error(
        `kaki server: MATTERMOST_PUBLIC_URL "${explicit}" is not a valid URL. ` +
          'Set it to the https:// address browsers use for Mattermost, or KAKI_ALLOW_OPEN=1 to allow this trusted demo.',
      );
    }
    if (publicUrl.protocol === 'https:') return;
    throw new Error(
      'kaki server: refusing to start because KAKI_PUBLIC_URL is https but MATTERMOST_PUBLIC_URL is not. ' +
        'Secure session cookies cannot authenticate an http Mattermost redirect. ' +
        'Set MATTERMOST_PUBLIC_URL=https://…, or KAKI_ALLOW_OPEN=1 to allow this trusted demo.',
    );
  }

  let internalUrl: URL;
  try {
    internalUrl = new URL(internal);
  } catch {
    throw new Error(
      `kaki server: MATTERMOST_URL "${internal}" is not a valid URL, so its public https base cannot be derived. ` +
        'Fix MATTERMOST_URL, set MATTERMOST_PUBLIC_URL=https://…, or KAKI_ALLOW_OPEN=1 to allow this trusted demo.',
    );
  }
  if (internalUrl.protocol === 'https:') return;
  throw new Error(
    'kaki server: refusing to start because KAKI_PUBLIC_URL is https but MATTERMOST_URL is not, ' +
      'so the Mattermost public base would downgrade to http. ' +
      'Set MATTERMOST_PUBLIC_URL=https://…, or KAKI_ALLOW_OPEN=1 to allow this trusted demo.',
  );
}

/**
 * Refuse a deployment that would leak credentials:
 * - sign-in off on a public address needs the explicit KAKI_ALLOW_OPEN=1 trusted-demo opt-in;
 * - sign-in on over a public address needs KAKI_PUBLIC_URL=https so session cookies are Secure.
 */
export function assertSafeBind(
  host: string,
  authEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowOpen = env.KAKI_ALLOW_OPEN === '1';
  const publicDeployment = servesPublicly(host, env);

  if (!authEnabled) {
    if (!publicDeployment || allowOpen) return;
    throw new Error(
      `kaki server: refusing to start with sign-in off on the public bind "${host}" or KAKI_PUBLIC_URL. ` +
        'Set KAKI_AUTH=1 for a public server, or KAKI_ALLOW_OPEN=1 to allow this trusted, open demo.',
    );
  }

  if (publicDeployment && !publicUrlIsHttps(env) && !allowOpen) {
    throw new Error(
      `kaki server: refusing to start with sign-in on over a public bind without an https KAKI_PUBLIC_URL. ` +
        'Set KAKI_PUBLIC_URL=https://… so session cookies are Secure, or KAKI_ALLOW_OPEN=1 to allow this trusted demo.',
    );
  }
}
