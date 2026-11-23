import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  accessProblem,
  bearerToken,
  crossSiteProblem,
  isLoopbackAddress,
  matchRoute,
  tokenMatches,
  type Principal,
  type Route,
} from './access';
import { sendJson, sendMattermostRefusal } from './http';
import type { RequestContext } from './routeCall';
import { CommandError } from '../core/hub';

/**
 * Resolve who a request belongs to: a service token first, then this meeting's session. When the
 * context names a meeting, a phone session from another meeting resolves to nobody, even if its
 * cookie is valid for that other meeting.
 */
export async function resolvePrincipal(
  request: IncomingMessage,
  context: Pick<RequestContext, 'auth' | 'serviceToken' | 'practicePrincipal' | 'authMeetingId'>,
): Promise<Principal> {
  if (
    context.serviceToken !== undefined &&
    tokenMatches(bearerToken(request), context.serviceToken)
  ) {
    return { kind: 'service' };
  }
  if (context.auth !== undefined) {
    const principal = await context.auth.resolvePrincipal(request, context.authMeetingId);
    // A signed-in owner or seat wins over any stale practice cookie.
    if (principal !== undefined) return principal;
  }
  const practice = context.practicePrincipal?.(request);
  if (practice !== undefined) return practice;
  return { kind: 'anonymous' };
}

/**
 * Whether one handled request is evidence that a person is using Kaki. Health probes, the idle
 * checker itself and the AI runner's own traffic must never keep the VM awake.
 */
function countsAsActivity(route: Route, principal: Principal): boolean {
  if (route.path === '/health' || route.access === 'loopback') return false;
  if (route.access === 'service') return false;
  return principal.kind !== 'service';
}

/**
 * Whether one request is a real person action rather than a page polling by itself. A state-changing
 * method counts; a GET read does not, because open lobbies poll with GETs on a timer.
 */
function countsAsAction(method: string, route: Route, principal: Principal): boolean {
  if (!countsAsActivity(route, principal)) return false;
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/**
 * A refused Mattermost link is a page a person clicked, so it gets the friendly page instead of
 * JSON. Every other refusal stays JSON for the app to read.
 */
function refuse(
  request: IncomingMessage,
  response: ServerResponse,
  route: Route,
  status: number,
  error: string,
): void {
  if (route.method === 'GET' && route.path === '/api/mattermost/open') {
    sendMattermostRefusal(request, response, status, error);
    return;
  }
  sendJson(response, status, { error });
}

/** Run one request through this context's route table, access check and handler. */
export async function handleRoutedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  pathOverride?: string,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // A prefixed meeting's paths are matched and handled as the canonical /api paths they share.
    const path = pathOverride ?? url.pathname;
    const method = request.method ?? 'GET';
    const match = matchRoute(context.routes, method, path);
    if (match === undefined) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const crossSite = crossSiteProblem(request, match.route, context.auth !== undefined);
    if (crossSite !== undefined) {
      refuse(request, response, match.route, crossSite.status, crossSite.error);
      return;
    }
    const principal = await resolvePrincipal(request, context);
    if (countsAsActivity(match.route, principal)) {
      context.idle.recordActivity();
      context.onActivity?.();
    }
    if (countsAsAction(method, match.route, principal)) context.idle.recordAction();
    const denied = accessProblem(match.route, principal, {
      authEnabled: context.auth !== undefined,
      devRoutes: context.devRoutes,
      serviceTokenConfigured: context.serviceToken !== undefined && context.serviceToken !== '',
      loopback: isLoopbackAddress(request.socket.remoteAddress),
      proxied: request.headers['x-forwarded-for'] !== undefined,
      rawPath: request.url ?? '',
    });
    if (denied !== undefined) {
      refuse(request, response, match.route, denied.status, denied.error);
      return;
    }

    await match.route.handle({ request, response, context, url, path, method, principal });
  } catch (error) {
    if (error instanceof CommandError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error('kaki server: request failed', error);
    sendJson(response, 500, { error: 'Internal server error' });
  }
}
