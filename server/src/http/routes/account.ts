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

  const deleteAccountData = context.accountDeletion;
  if (deleteAccountData === undefined || context.registry === undefined) {
    console.error('kaki account: deletion is not wired up');
    sendJson(response, 500, { error: 'Account deletion is unavailable.' });
    return;
  }

  try {
    const ownedIds = (await store.listWorkspacesToDelete(userId)).map((workspace) => workspace.id);
    // End the account's meetings first, including members' meetings in the workspaces about to go,
    // before their rows and saved state are deleted, so nobody is left in a room whose meeting no
    // longer exists. A meeting that could not end stops the deletion before anything is removed.
    await context.registry.endOwnedBy(userId, ownedIds);
    // One step for every remaining row: the Postgres stores commit it as one transaction.
    const hashes = await deleteAccountData(userId);
    for (const hash of hashes) context.auth?.closeSockets(hash);
    // Sessions replaced earlier left sockets keyed by the account, not a current session row.
    context.auth?.closeUserSockets(userId);
    response.setHeader('set-cookie', clearSessionCookie(context.auth?.secureCookies ?? false));
    sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error('kaki account: deleting the account failed', error);
    sendJson(response, 500, {
      error: 'Could not delete the account. Nothing was removed; try again.',
    });
  }
}
