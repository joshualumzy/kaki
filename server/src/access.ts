import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The one access vocabulary shared by HTTP routes and WebSocket audiences. Every route names one
 * of these before any handler runs; nothing else may decide who a request is.
 */
export type Access = 'public' | 'session' | 'host' | 'seat' | 'service' | 'dev';

export const ACCESS_LEVELS: readonly Access[] = ['public', 'session', 'host', 'seat', 'service', 'dev'];

/** Who a request belongs to, once the access layer has resolved it. */
export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'host' }
  | { kind: 'seat'; role: string }
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
 * (which needs the runner's token when one is configured) and the dev routes.
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
      if (!context.authEnabled) return undefined;
      return principal.kind === 'service'
        ? undefined
        : { status: 401, error: 'Service sign-in required.' };

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
 * 127.0.0.1, so when KAKI_TRUST_PROXY=1 take the first hop of X-Forwarded-For instead.
 */
export function clientAddress(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.KAKI_TRUST_PROXY === '1') {
    const header = request.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first.slice(0, MAX_ADDRESS_LENGTH);
  }
  return request.socket.remoteAddress ?? 'unknown';
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

/**
 * Refuse to run an open (sign-in off) server on an address other machines can reach, unless the
 * owner explicitly opts into the trusted demo with KAKI_ALLOW_OPEN=1.
 */
export function assertSafeBind(
  host: string,
  authEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (authEnabled || isLoopbackHost(host) || env.KAKI_ALLOW_OPEN === '1') return;
  throw new Error(
    `kaki server: refusing to start with sign-in off on the non-loopback bind "${host}". ` +
      'Set KAKI_AUTH=1 for a public server, or KAKI_ALLOW_OPEN=1 to allow this trusted, open demo.',
  );
}
