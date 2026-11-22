import type { Task } from '@kaki/shared';

/** The short status text a task card shows; a SUGGESTED task with an error can say it is unresolved. */
export function taskStatusText(task: Task, options: { unresolvedSuggested?: boolean } = {}): string {
  switch (task.status) {
    case 'SUGGESTED':
      return options.unresolvedSuggested === true && task.error !== undefined ? 'Decision unresolved' : 'suggested';
    case 'CLAIMED':
      return task.mode === 'ACTION_AGENT' ? 'drafting…' : 'accepted';
    case 'DRAFT_READY':
      return 'reviewing draft…';
    case 'RUNNING':
      return 'publishing…';
    default:
      return task.status.replace('_', ' ').toLowerCase();
  }
}

/** The link text for a task's live artifact, named after the tool that holds it. */
export function artifactLinkText(task: Task): string {
  switch (task.actionKind) {
    case 'gitea_issue':
      return 'Open live in Gitea ↗';
    case 'mattermost_post':
      return 'Open live in Mattermost ↗';
    case 'wiki_page':
      return 'Open live in Wiki ↗';
    case 'email':
      return 'Open live in Mailpit ↗';
    case 'calendar_event':
      return 'Open live in Calendar ↗';
    default:
      return 'Open live artifact ↗';
  }
}
