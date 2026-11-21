import type { KakiEvent, Task } from '@kaki/shared';
import { audienceRole, type ClientAudience } from './audience';

/** True when an event belongs in this audience's feed. */
export function wantsEvent(event: KakiEvent, audience: ClientAudience): boolean {
  // A lifecycle feed is read-only and only carries the meeting's start/reset/restore state.
  if (audience.kind === 'lifecycle') {
    return event.type === 'MEETING_STARTED' || event.type === 'MEETING_RESET' || event.type === 'MEETING_RESTORED';
  }
  return (
    event.audience.kind === 'all' ||
    (event.audience.kind === 'service' && audience.kind === 'service') ||
    (event.audience.kind === 'screen' && (audience.kind === 'screen' || audience.kind === 'service')) ||
    (event.audience.kind === 'role' &&
      (audienceRole(audience) === event.audience.role ||
        (audience.kind === 'screen' && event.type === 'FACT_FOUND')))
  );
}

/** A participant's view of an event that may carry another seat's private work. */
export function wantsProjectedEvent(event: KakiEvent, seat: string | undefined): boolean {
  if (seat === undefined) {
    // Sign-in off is the trusted demo: a participant projection behaves like the old shared screen.
    if (event.audience.kind === 'role') return event.type === 'FACT_FOUND';
    return wantsEvent(event, { kind: 'screen' });
  }
  // A participant may read the shared record, transcript and lifecycle, and only their own seat's
  // facts, coaching and tasks. Another seat's private events never reach them.
  if (event.audience.kind === 'role') return event.audience.role === seat;
  return wantsEvent(event, { kind: 'screen' });
}

/** True when the minutes task is out of review: it may be shown to the whole room. */
function minutesPublished(task: Task): boolean {
  return task.status === 'COMPLETED' || task.status === 'SYNCED';
}

/**
 * The task record another seat may see: the shared board needs its title, who owns it and where it
 * is, never its context, draft, evidence or private links. A minutes card is hidden until it is
 * published, unless this seat is the one who must approve it.
 */
function taskForSeat(task: Task, seat: string): Task | undefined {
  const mine = task.assignee === seat || (task.assignee === undefined && task.suggestedAssignee === seat);
  const minutes = task.purpose === 'meeting_minutes';
  if (minutes && !minutesPublished(task) && !mine) return undefined;
  if (mine) return task;
  return {
    id: task.id,
    title: task.title,
    context: '',
    suggestedAssignee: task.suggestedAssignee,
    ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
    ...(task.agendaItemTitle === undefined ? {} : { agendaItemTitle: task.agendaItemTitle }),
    ...(minutes ? { purpose: 'meeting_minutes' as const } : {}),
    ...(minutes && task.artifactUrl !== undefined ? { artifactUrl: task.artifactUrl } : {}),
    status: task.status,
    updatedAt: task.updatedAt,
  };
}

/** The event a participant projection or practice screen may actually receive, if any. */
export function projectedEvent(
  event: KakiEvent,
  seat: string | undefined,
  practiceScreen: boolean,
): KakiEvent | undefined {
  // A practice screen already filters facts; this also keeps other seats' task drafts out of it.
  if (practiceScreen) {
    // The practice visitor's screen may show its own seat's facts (the Kaki panel reads this feed),
    // but no other seat's private work.
    if (event.audience.kind === 'role') {
      return event.type === 'FACT_FOUND' && seat !== undefined && event.audience.role === seat
        ? event
        : undefined;
    }
    if (event.type !== 'TASK_UPDATED' || seat === undefined) return event;
    const task = taskForSeat(event.payload.task, seat);
    return task === undefined ? undefined : { ...event, payload: { task } };
  }
  if (event.audience.kind === 'role') return event;
  if (event.type !== 'TASK_UPDATED' || seat === undefined) return event;
  const task = taskForSeat(event.payload.task, seat);
  return task === undefined ? undefined : { ...event, payload: { task } };
}
