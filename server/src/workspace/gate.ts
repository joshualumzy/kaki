import type { Pool, PoolClient } from 'pg';

/** A database connection or pool that a workspace gate query may run on. */
export type WorkspaceDb = Pick<Pool | PoolClient, 'query'>;

/** The durable record that a workspace was deleted, so a late writer cannot recreate its data. */
export const WORKSPACE_DELETIONS_TABLE = 'workspace_deletions';

/** A write was refused because its workspace has been deleted. */
export class WorkspaceDeletedError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} has been deleted.`);
    this.name = 'WorkspaceDeletedError';
  }
}

/**
 * The one advisory-lock key for a workspace. A deletion holds it exclusively; every writer that
 * can recreate data holds it in shared mode. That serialises a late writer against the deletion
 * across processes, not only inside this server.
 */
const ADVISORY_KEY_SQL = 'hashtextextended($1, 0)';

/** Take the workspace's shared gate for the rest of this transaction. */
export async function lockWorkspaceForWrite(db: WorkspaceDb, workspaceId: string): Promise<void> {
  await db.query(`select pg_advisory_xact_lock_shared(${ADVISORY_KEY_SQL})`, [workspaceId]);
}

/** Take the workspace's exclusive gate for the rest of this transaction. */
export async function lockWorkspaceForDeletion(
  db: WorkspaceDb,
  workspaceId: string,
): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(${ADVISORY_KEY_SQL})`, [workspaceId]);
}

/** Record that a workspace was deleted; the row outlives the workspace on purpose. */
export async function recordWorkspaceDeletion(
  db: WorkspaceDb,
  workspaceId: string,
): Promise<void> {
  await db.query(
    `insert into ${WORKSPACE_DELETIONS_TABLE} (workspace_id) values ($1)
     on conflict (workspace_id) do nothing`,
    [workspaceId],
  );
}

/** Whether this workspace has been deleted, even when its own row is already gone. */
export async function workspaceIsDeleted(
  db: WorkspaceDb,
  workspaceId: string,
): Promise<boolean> {
  const table = await db.query<{ name: string | null }>('select to_regclass($1) as name', [
    WORKSPACE_DELETIONS_TABLE,
  ]);
  const found = table.rows[0]?.name;
  if (found === null || found === undefined) return false;
  const row = await db.query(
    `select 1 from ${WORKSPACE_DELETIONS_TABLE} where workspace_id = $1 limit 1`,
    [workspaceId],
  );
  return (row.rowCount ?? 0) > 0;
}

/** Refuse a write whose workspace is gone; a sample or an old databaseless fixture has no row. */
export async function assertWorkspaceWritable(
  db: WorkspaceDb,
  workspaceId: string,
  sampleWorkspaceId: string,
): Promise<void> {
  if (workspaceId === sampleWorkspaceId) return;
  if (await workspaceIsDeleted(db, workspaceId)) throw new WorkspaceDeletedError(workspaceId);
}
