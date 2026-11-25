import { accountUserId, clientAddress } from '../access';
import type { AttemptLimiter } from '../attemptLimiter';
import { sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import { CalendarFetchError, fetchCalendarEvents } from '../../action/calendar';
import {
  buildMeetingIcs,
  meetingCalendarUid,
  meetingDescription,
  meetingDurationMinutes,
} from '../../meeting/calendarEvent';
import { meetingStatusNow } from '../../meeting/types';
import { meetingForManagement } from './meetings';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import { pendingCancellationView } from '../../meeting/calendarCancellations';

const MAX_CALENDAR_EVENTS = 50;

function plainReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

/** Count a paid calendar read against both its account and its address. */
function calendarReadLimited(call: RouteCall, limiter: AttemptLimiter | undefined): boolean {
  if (limiter === undefined) return false;
  const { request, response, principal } = call;
  const userId = accountUserId(principal);
  const keys = [...(userId === undefined ? [] : [`user:${userId}`]), `address:${clientAddress(request)}`];
  if (keys.some((key) => limiter.isLimited(key))) {
    sendJson(response, 429, { error: 'Too many calendar reads. Wait a minute and try again.' });
    return true;
  }
  for (const key of keys) limiter.recordFailure(key);
  return false;
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
  if (calendarReadLimited(call, context.agendaFromCalendarAttempts)) return;

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

  const today = new Date().toISOString().slice(0, 10);
  const events = listed
    .filter((event) => event.status !== 'CANCELLED')
    .filter((event) => event.date >= today)
    .sort((a, b) => (a.start ?? `${a.date} ${a.time}`).localeCompare(b.start ?? `${b.date} ${b.time}`))
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
  if (meetingStatusNow(row) === 'ended') {
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
  if (meetingStatusNow(row) !== 'scheduled' || row.scheduledFor === null) {
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



/** List and retry calendar cancellations that could not be written, for the admins who own them. */
export async function handleCalendarCancellations(call: RouteCall): Promise<void> {
  const { response, context, path, method, principal } = call;
  const service = context.calendarCancellations;
  const store = context.authStore;
  if (service === undefined || store === undefined) {
    sendJson(response, 500, { error: 'Calendar cancellation storage is unavailable.' });
    return;
  }
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in to see calendar cancellations.' });
    return;
  }
  const workspaceList = /^\/api\/workspaces\/([^/]+)\/calendar-cancellations$/.exec(path);
  const workspaceRetry = /^\/api\/workspaces\/([^/]+)\/calendar-cancellations\/([^/]+)\/retry$/.exec(
    path,
  );
  const globalList = /^\/api\/calendar-cancellations$/.exec(path);
  const globalRetry = /^\/api\/calendar-cancellations\/([^/]+)\/retry$/.exec(path);

  if (workspaceList !== null || workspaceRetry !== null) {
    const workspaceId = decodeURIComponent((workspaceList ?? workspaceRetry)![1] ?? '');
    if (workspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace has no calendar cancellations." });
      return;
    }
    const membership = await store.getMembership({ workspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can retry calendar cancellations.' });
      return;
    }
    if (workspaceList !== null) {
      if (method !== 'GET') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const pending = await service.listForWorkspace(workspaceId);
      sendJson(response, 200, pending.map(pendingCancellationView));
      return;
    }
    if (method !== 'POST') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const id = decodeURIComponent(workspaceRetry![2] ?? '');
    const pending = await service.listForWorkspace(workspaceId);
    if (!pending.some((record) => record.id === id)) {
      sendJson(response, 404, { error: 'That cancellation is no longer waiting.' });
      return;
    }
    const outcome = await service.retry(id);
    if (outcome.ok) {
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 502, { error: outcome.error });
    }
    return;
  }

  if (globalList !== null) {
    if (method !== 'GET') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const pending = await service.listForUser(userId);
    sendJson(response, 200, pending.map(pendingCancellationView));
    return;
  }
  if (globalRetry !== null) {
    if (method !== 'POST') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const id = decodeURIComponent(globalRetry[1] ?? '');
    const pending = await service.listForUser(userId);
    if (!pending.some((record) => record.id === id)) {
      sendJson(response, 404, { error: 'That cancellation is no longer waiting.' });
      return;
    }
    const outcome = await service.retry(id);
    if (outcome.ok) {
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 502, { error: outcome.error });
    }
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}
