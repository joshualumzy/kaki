import type { RouteCall } from '../routeCall';
import { sendJson } from '../http';

/**
 * Answer the VM's idle checker. The route declares loopback-only access, so a request arriving
 * through the public proxy is already a 404 before this handler runs.
 */
export async function handleIdle(call: RouteCall): Promise<void> {
  const { response, context } = call;
  sendJson(response, 200, context.idle.snapshot());
}
