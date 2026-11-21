import { sendJson } from '../http';
import type { RouteCall } from '../routeCall';

/** Serves the auth module's HTTP routes, or the disabled sign-in check; anything else is a 404. */
export async function handleAuthRoutes(call: RouteCall): Promise<void> {
  const { request, response, context, path, method } = call;
  if (context.auth !== undefined) {
    if (await context.auth.handleHttp(request, response)) return;
  } else if (method === 'GET' && path === '/api/auth/me') {
    sendJson(response, 200, { authEnabled: false });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

