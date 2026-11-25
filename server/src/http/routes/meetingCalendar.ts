import { accountUserId } from '../access';
import type { AttemptLimiter } from '../attemptLimiter';
import { sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import { CalendarFetchError, fetchCalendarEvents, type CalendarEvent } from '../../action/calendar';
import {
  buildMeetingIcs,
  meetingCalendarUid,
  meetingDescription,
  meetingDurationMinutes,
} from '../../meeting/calendarEvent';
import { meetingForManagement } from './meetings';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';

const MAX_CALENDAR_EVENTS = 50;

function plainReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

/** Count this calendar read against the account only; there is one budget per person. */
function calendarReadLimited(call: RouteCall, limiter: AttemptLimiter | undefined): boolean {
  if (limiter === undefined) return false;
  const { response, principal } = call;
  const userId = accountUserId(principal);
  if (userId === undefined) return false;
  const key = `user:${userId}`;
  if (limiter.isLimited(key)) {
    sendJson(response, 429, { error: 'Too many calendar reads. Wait a minute and try again.' });
    return true;
  }
  limiter.recordFailure(key);
  return false;
}

/** The real instant an event starts, so "upcoming" is compared to now, not to a UTC date string. */
function eventStartsAt(event: CalendarEvent): number {
  if (event.start !== undefined) {
    const at = Date.parse(event.start);
    if (!Number.isNaN(at)) return at;
  }
  const at = Date.parse(`${event.date}T${event.time}`);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** The workspace id on a `/api/workspaces/:id/...` path. */
function workspaceIdFrom(path: string, suffix: string): string | undefined {
  const match = new RegExp(`^/api/workspaces/([^/]+)/${suffix}$`).exec(path);
  return match === null ? undefined : decodeURIComponent(match[1] ?? '');
}

/** The id on a `/api/meetings/:id/...` path. */
function meetingIdFrom(path: string, suffix: string): string | undefined {
  const match = new RegExp(`^/api/meetings/([^/]+)/${suffix}$`).exec(path);
  return match === null ? undefined : decodeURIComponent(match[1] ?? '');
}

/**
 * The workspace calendar's upcoming events, for the meeting setup picker. A workspace with no
 * connected calendar answers plainly rather than showing an error.
 */
export async function handleWorkspaceCalendarEvents(call: RouteCall): Promise<void> {
  const { response, context, path, principal } = call;
  const workspaceId = workspaceIdFrom(path, 'calendar/events');
  if (workspaceId === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  const store = context.authStore;
  const toolSource = context.toolSource;
  if (store === undefined || toolSource === undefined) {
    sendJson(response, 500, { error: 'Workspace storage is unavailable.' });
    return;
  }
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in to read the workspace calendar.' });
    return;
  }
  if (workspaceId === SAMPLE_WORKSPACE_ID) {
    // The sample workspace's tools are built in; every signed-in person may read its calendar.
  } else {
    const membership = await store.getMembership({ workspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
  }
  if (calendarReadLimited(call, context.calendarReadAttempts)) return;

  let tools;
  try {
    tools = await toolSource.toolsFor(workspaceId);
  } catch (error) {
    sendJson(response, 502, {
      error: plainReason(error, 'The workspace calendar could not be read.'),
    });
    return;
  }
  if (tools.calendar === undefined) {
    sendJson(response, 200, { connected: false, events: [] });
    return;
  }

  let listed;
  try {
    listed = await fetchCalendarEvents(
      tools.calendar,
      context.actionTools.fetchImpl ?? fetch,
      context.actionTools.timeoutMs,
    );
  } catch (error) {
    if (error instanceof CalendarFetchError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    sendJson(response, 502, {
      error: plainReason(error, 'The workspace calendar could not be read.'),
    });
    return;
  }

  const now = Date.now();
  const events = listed
    .filter((event) => event.status !== 'CANCELLED')
    .filter((event) => eventStartsAt(event) >= now)
    .sort((a, b) => eventStartsAt(a) - eventStartsAt(b))
    .slice(0, MAX_CALENDAR_EVENTS)
    .map((event) => ({
      uid: event.uid,
      title: event.title,
      date: event.date,
      time: event.time,
      ...(event.endTime === undefined ? {} : { endTime: event.endTime }),
      ...(event.start === undefined ? {} : { start: event.start }),
      ...(event.timeZone === undefined ? {} : { timeZone: event.timeZone }),
      ...(event.fileId === undefined ? {} : { fileId: event.fileId }),
      description: event.description,
      people: event.people,
    }));
  sendJson(response, 200, { connected: true, events });
}

/** A signed-in person who may see this meeting: its owner, or any member of its workspace. */
async function meetingForMember(call: RouteCall, id: string) {
  const { response, context, principal } = call;
  const store = context.authStore;
  const meetings = context.meetings;
  if (store === undefined || meetings === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return undefined;
  }
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in to add this meeting to a calendar.' });
    return undefined;
  }
  const row = await meetings.get(id);
  if (row === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return undefined;
  }
  if (row.workspaceId === SAMPLE_WORKSPACE_ID) {
    if (row.ownerUserId !== userId) {
      sendJson(response, 404, { error: 'Meeting not found.' });
      return undefined;
    }
    return row;
  }
  const membership = await store.getMembership({ workspaceId: row.workspaceId, userId });
  if (membership === undefined) {
    // Not being a member is indistinguishable from the meeting not existing.
    sendJson(response, 404, { error: 'Meeting not found.' });
    return undefined;
  }
  return row;
}

/** Download one meeting as an .ics file that updates the workspace event by UID and SEQUENCE. */
export async function handleMeetingCalendarIcs(call: RouteCall): Promise<void> {
  const { response, context, path } = call;
  const id = meetingIdFrom(path, 'calendar\\.ics');
  if (id === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  const row = await meetingForMember(call, id);
  if (row === undefined) return;
  if (row.scheduledFor === null) {
    sendJson(response, 409, { error: 'This meeting has no date, so it cannot be added to a calendar.' });
    return;
  }
  if (row.status === 'ended') {
    sendJson(response, 409, { error: 'This meeting has ended.' });
    return;
  }
  const stored = await context.meetings?.calendarEventFor?.(row.id);
  let ics: string;
  try {
    ics = buildMeetingIcs({
      uid: stored?.uid ?? meetingCalendarUid(row.id),
      sequence: stored?.sequence ?? 0,
      title: row.title,
      description: meetingDescription(row.agenda),
      start: new Date(row.scheduledFor).toISOString(),
      durationMinutes: meetingDurationMinutes(row.agenda),
      now: new Date(),
    });
  } catch (error) {
    sendJson(response, 409, { error: plainReason(error, 'The meeting time could not be read.') });
    return;
  }
  const filename = `${row.title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'meeting'}.ics`;
  response.writeHead(200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  response.end(ics);
}

/** Retry the workspace calendar write for one scheduled meeting, after a failure. */
export async function handleMeetingCalendarSync(call: RouteCall): Promise<void> {
  const { response, context, path } = call;
  const id = meetingIdFrom(path, 'calendar-sync');
  if (id === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  const row = await meetingForManagement(call, id);
  if (row === undefined) return;
  if (row.status !== 'scheduled' || row.scheduledFor === null) {
    sendJson(response, 409, { error: 'Only a scheduled meeting can be on the workspace calendar.' });
    return;
  }
  const registry = context.registry;
  if (registry?.retryCalendar === undefined) {
    sendJson(response, 500, { error: 'Calendar sync is unavailable.' });
    return;
  }
  try {
    const outcome = await registry.retryCalendar(id);
    if (outcome === undefined) {
      sendJson(response, 409, { error: 'Only a scheduled meeting can be on the workspace calendar.' });
      return;
    }
    sendJson(response, 200, { calendar: outcome.state, warning: outcome.warning });
  } catch (error) {
    sendJson(response, 502, {
      error: plainReason(error, 'The workspace calendar could not be reached.'),
    });
  }
}
