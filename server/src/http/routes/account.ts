import { isObject } from '@kaki/shared';
import { clearSessionCookie } from '../../auth/cookie';
import { accountUserId } from '../access';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';

const MAX_BODY_BYTES = 1_000;

/** Delete the signed-in account and everything it owns, after its open meetings end. */
export async function handleDeleteAccount(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
  const store = context.authStore;
  if (store === undefined) {
    sendJson(response, 500, { error: 'Account storage is unavailable.' });
    return;
  }
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in to do that.' });
    return;
  }

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  const confirm = isObject(parsed.value) ? parsed.value.confirm : undefined;
  if (confirm !== 'DELETE') {
    sendJson(response, 400, { error: 'Type DELETE to confirm.' });
    return;
  }

  try {
    const ownedIds = (await store.listWorkspacesOwnedBy(userId)).map((workspace) => workspace.id);
    // End the account's meetings first, including members' meetings in the workspaces about to go,
    // before their rows and saved state are deleted, so nobody is left in a room whose meeting no
    // longer exists.
    await context.registry?.endOwnedBy(userId, ownedIds);
    await context.meetings?.deleteByOwner?.(userId, ownedIds);
    await context.workspaceTools?.deleteWorkspaces?.(ownedIds);
    await context.deleteWorkspaceKnowledge?.(ownedIds);
    const hashes = await store.deleteUser(userId);
    for (const hash of hashes) context.auth?.closeSockets(hash);
    response.setHeader('set-cookie', clearSessionCookie(context.auth?.secureCookies ?? false));
    sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error('kaki account: deleting the account failed', error);
    sendJson(response, 500, {
      error:
        'Could not delete the account. Some of your data may already be gone; trying again will finish the job.',
    });
  }
}
