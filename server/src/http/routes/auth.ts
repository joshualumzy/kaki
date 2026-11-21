import { sendJson } from '../http';
import type { RouteCall } from '../routeCall';

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

