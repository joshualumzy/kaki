import type { Pool } from 'pg';
import type { AuthStore } from '../auth/store';
import type { MeetingStore } from '../meeting/registry';
import type { WorkspaceToolStore } from '../workspace/tools';
import { deleteWorkspaceKnowledge } from '../wingman/knowledge/indexer';

/** Delete one account's stored data and return the session hashes it revoked. */
export interface AccountDataDeletion {
  deleteAccountData(userId: string): Promise<string[]>;
}

interface AccountStores {
  auth: AuthStore;
  meetings: MeetingStore;
  tools: WorkspaceToolStore;
}

function requireMeetingsDelete(store: MeetingStore): NonNullable<MeetingStore['deleteByOwner']> {
  if (store.deleteByOwner === undefined) {
    throw new Error('the meetings store cannot delete an account\'s meetings');
  }
  return store.deleteByOwner.bind(store);
}

function requireToolsDelete(
  store: WorkspaceToolStore,
): NonNullable<WorkspaceToolStore['deleteWorkspaces']> {
  if (store.deleteWorkspaces === undefined) {
    throw new Error('the workspace tool store cannot delete an account\'s tools');
  }
  return store.deleteWorkspaces.bind(store);
}

/**
 * Postgres deletes meetings, saved state, seat claims, tool logins, knowledge chunks, memberships,
 * workspaces, sessions and the user on one connection in one transaction, so a failure changes
 * nothing and the account can simply try again.
 */
export function createPostgresAccountDataDeletion(
  input: AccountStores & { pool: Pool },
): AccountDataDeletion {
  return {
    async deleteAccountData(userId) {
      const deleteMeetings = requireMeetingsDelete(input.meetings);
      const deleteTools = requireToolsDelete(input.tools);
      const client = await input.pool.connect();
      try {
        await client.query('begin');
        // Lock the account row before looking for open meetings. A meeting created for this account
        // takes a shared lock on the same row before its insert, so it either committed before this
        // statement (and the check below sees it) or waits for this transaction and then fails
        // because the account is gone. That closes the window between the check and commit.
        await client.query('select id from users where id = $1 for update', [userId]);
        // endOwnedBy ran before this transaction. A meeting created since then is still open and
        // would otherwise be deleted without ending for the people in it, so roll back and retry.
        const stillOpen = await client.query<{ id: string }>(
          "select id from meetings where owner_user_id = $1 and status <> 'ended' limit 1",
          [userId],
        );
        if ((stillOpen.rowCount ?? 0) > 0) {
          throw new Error(
            `meeting ${stillOpen.rows[0]?.id ?? 'unknown'} was created while the account was being deleted; try again`,
          );
        }
        // Only workspaces this account is the last member of go with it. Lock those rows so a member
        // being added or removed at the same moment cannot change that decision mid-deletion.
        const doomed = await client.query<{ id: string }>(
          `select w.id
             from workspaces w
             join workspace_members m on m.workspace_id = w.id and m.user_id = $1
            where not exists (
                    select 1 from workspace_members other
                     where other.workspace_id = w.id and other.user_id <> $1
                  )
            for update of w`,
          [userId],
        );
        const workspaceIds = doomed.rows.map((row) => row.id);
        await deleteMeetings(userId, workspaceIds, client);
        await deleteTools(workspaceIds, client);
        await deleteWorkspaceKnowledge({ db: client, workspaceIds });
        const hashes = await input.auth.deleteUser(userId, client);
        await client.query('commit');
        return hashes;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * The memory stores change only in-process maps with no I/O, so the same steps land together in
 * the same order and cannot leave a half-deleted account behind.
 */
export function createMemoryAccountDataDeletion(input: AccountStores): AccountDataDeletion {
  return {
    async deleteAccountData(userId) {
      const deleteMeetings = requireMeetingsDelete(input.meetings);
      const deleteTools = requireToolsDelete(input.tools);
      const workspaceIds = (await input.auth.listWorkspacesToDelete(userId)).map(
        (workspace) => workspace.id,
      );
      await deleteMeetings(userId, workspaceIds);
      await deleteTools(workspaceIds);
      return input.auth.deleteUser(userId);
    },
  };
}
