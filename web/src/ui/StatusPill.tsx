import type { TaskStatus } from '@kaki/shared';

const STATUS_LABELS: Record<TaskStatus, string> = {
  SUGGESTED: 'Suggested',
  DISMISSED: 'Dismissed',
  DISPATCHED: 'Dispatched',
  CLAIMED: 'Claimed',
  DRAFT_READY: 'Draft ready',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  SYNCED: 'Synced',
};

/** Small coloured pill for a task status. */
export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className="pill" data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}
