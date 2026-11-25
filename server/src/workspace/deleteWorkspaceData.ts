import type { Pool } from 'pg';
import type { AuthStore } from '../auth/store';
import type { MeetingStore } from '../meeting/registry';
import type { WorkspaceToolStore } from './tools';
import { deleteWorkspaceKnowledge } from '../wingman/knowledge/indexer';
import { lockWorkspaceForDeletion, recordWorkspaceDeletion } from './gate';

/** Delete one team workspace and everything stored for it. */
export interface WorkspaceDataDeletion {
  /**
   * Delete the workspace, its meetings, tools and knowledge; false when it may not be deleted.
   * `beforeDelete` runs only after the workspace lock and admin recheck, so cancellation and room
   * unloading can never happen for someone whose authority was already taken away.
   */
  deleteWorkspace(input: {
    workspaceId: string;
    actorUserId: string;
    beforeDelete?: (workspace: { id: string; name: string }) => Promise<void>;
  }): Promise<boolean>;
}

interface WorkspaceStores {
  auth: AuthStore;
  meetings: MeetingStore;
  tools: WorkspaceToolStore;
}

function requireMeetingsDelete(store: MeetingStore): NonNullable<MeetingStore['deleteWorkspace']> {
  if (store.deleteWorkspace === undefined) {
    throw new Error("the meetings store cannot delete a workspace's meetings");
  }
  return store.deleteWorkspace.bind(store);
}

function requireToolsDelete(
  store: WorkspaceToolStore,
): NonNullable<WorkspaceToolStore['deleteWorkspaces']> {
  if (store.deleteWorkspaces === undefined) {
    throw new Error("the workspace tool store cannot delete a workspace's tools");
  }
  return store.deleteWorkspaces.bind(store);
}

/**
 * Postgres deletes the workspace row and everything hanging off it in one transaction, so a
 * failure changes nothing and the admin can try again.
 */
export function createPostgresWorkspaceDataDeletion(
  input: WorkspaceStores & { pool: Pool },
): WorkspaceDataDeletion {
  return {
    async deleteWorkspace({ workspaceId, actorUserId, beforeDelete }) {
      const deleteMeetings = requireMeetingsDelete(input.meetings);
      const deleteTools = requireToolsDelete(input.tools);
      const client = await input.pool.connect();
      try {
        await client.query('begin');
        // Hold the workspace's exclusive gate across the whole deletion. A create, tool save or
        // indexer that is already inside finishes first; one that starts afterwards waits and then
        // sees the tombstone (or the missing workspace row) instead of recreating deleted data.
        await lockWorkspaceForDeletion(client, workspaceId);
        const deleted = await input.auth.deleteWorkspace(
          {
            id: workspaceId,
            actorUserId,
            ...(beforeDelete === undefined
              ? {}
              : {
                  beforeDelete: (workspace) =>
                    beforeDelete({ id: workspace.id, name: workspace.name }),
                }),
          },
          client,
        );
        if (!deleted) {
          await client.query('rollback');
          return false;
        }
        await deleteMeetings(workspaceId, client);
        await deleteTools([workspaceId], client);
        await deleteWorkspaceKnowledge({ db: client, workspaceIds: [workspaceId] });
        await recordWorkspaceDeletion(client, workspaceId);
        await client.query('commit');
        return true;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** The in-memory stores change only in-process maps, so the same steps land together. */
export function createMemoryWorkspaceDataDeletion(input: WorkspaceStores): WorkspaceDataDeletion {
  return {
    async deleteWorkspace({ workspaceId, actorUserId, beforeDelete }) {
      const deleteMeetings = requireMeetingsDelete(input.meetings);
      const deleteTools = requireToolsDelete(input.tools);
      const deleted = await input.auth.deleteWorkspace({
        id: workspaceId,
        actorUserId,
        ...(beforeDelete === undefined
          ? {}
          : {
              beforeDelete: (workspace) =>
                beforeDelete({ id: workspace.id, name: workspace.name }),
            }),
      });
      if (!deleted) return false;
      await deleteMeetings(workspaceId);
      await deleteTools([workspaceId]);
      return true;
    },
  };
}
