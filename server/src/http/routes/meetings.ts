import { isObject, parseMeetingPaceInput, type MeetingPace } from '@kaki/shared';
import { accountUserId, clientAddress } from '../access';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import type { AuthStore } from '../../auth/store';
import { parseAgendaInput } from '../../meeting/agenda';
import { MeetingBusyError } from '../../meeting/registry';
import { meetingStatusNow, type AgendaItem, type MeetingRow } from '../../meeting/types';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import { SAMPLE_WORKSPACE } from '../../workspace/sample';

const MAX_BODY_BYTES = 64_000;
const MAX_TITLE_LENGTH = 120;
const MAX_GUEST_NAME_LENGTH = 40;

function meetingTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) return undefined;
  return title;
}

function guestName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_GUEST_NAME_LENGTH) return undefined;
  return name;
}

function meetingIdFrom(path: string, suffix: string): string | undefined {
  const match = new RegExp(`^/api/meetings/([^/]+)/${suffix}$`).exec(path);
  return match === null ? undefined : decodeURIComponent(match[1] ?? '');
}

/** Validate a pace field sent with a meeting create or edit; undefined when it was left out. */
function meetingPaceField(
  value: unknown,
): { ok: true; pace: MeetingPace | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, pace: undefined };
  const parsed = parseMeetingPaceInput(value);
  return parsed.ok ? { ok: true, pace: parsed.pace } : { ok: false, error: parsed.error };
}

/**
 * Every agenda owner must be a current member of the meeting's workspace. Ownership is stored as
 * the stable account id, so it never depends on a display name or on anyone joining later.
 */
async function agendaOwnerProblem(
  store: AuthStore,
  workspaceId: string,
  agenda: readonly AgendaItem[],
): Promise<string | undefined> {
  const owners = [
    ...new Set(
      agenda.flatMap((item) => (item.ownerUserId === undefined ? [] : [item.ownerUserId])),
    ),
  ];
  if (owners.length === 0) return undefined;
  if (workspaceId === SAMPLE_WORKSPACE_ID) {
    return 'The sample workspace has no members to own agenda items.';
  }
  const memberIds = new Set(
    (await store.listWorkspaceMembers(workspaceId)).map((member) => member.userId),
  );
  return owners.some((owner) => !memberIds.has(owner))
    ? 'That agenda owner is not a member of this workspace.'
    : undefined;
}

/**
 * The row a caller may manage, after rechecking membership server-side; sends the refusal itself
 * and returns undefined when they may not.
 */
async function meetingForManagement(
  call: RouteCall,
  id: string,
): Promise<MeetingRow | undefined> {
  const { response, context, principal } = call;
  const store = context.authStore;
  const meetings = context.meetings;
  if (store === undefined || meetings === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return undefined;
  }
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in to manage a meeting.' });
    return undefined;
  }
  const row = await meetings.get(id);
  if (row === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return undefined;
  }
  if (row.workspaceId === SAMPLE_WORKSPACE_ID) {
    if (row.ownerUserId !== userId) {
      sendJson(response, 403, { error: 'Only the meeting owner or a workspace admin can manage this meeting.' });
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
  if (row.ownerUserId !== userId && membership !== 'admin') {
    sendJson(response, 403, { error: 'Only the meeting owner or a workspace admin can manage this meeting.' });
    return undefined;
  }
  return row;
}

/** Create a real meeting in one of the caller's workspaces. */
export async function handleCreateMeeting(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
  const store = context.authStore;
  const registry = context.registry;
  if (store === undefined || registry === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return;
  }
  const creatorId = accountUserId(principal);
  if (creatorId === undefined) {
    sendJson(response, 403, { error: 'Sign in with Google to create a meeting.' });
    return;
  }

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  if (!isObject(parsed.value)) {
    sendJson(response, 400, { error: "Something went wrong sending that. Reload and try again." });
    return;
  }
  const rawWorkspaceId = parsed.value.workspaceId;
  const workspaceId = typeof rawWorkspaceId === 'string' ? rawWorkspaceId.trim() : '';
  if (workspaceId === '') {
    sendJson(response, 400, { error: 'Choose a workspace for the meeting.' });
    return;
  }
  const title = meetingTitle(parsed.value.title);
  if (title === undefined) {
    sendJson(response, 400, { error: 'A meeting title must be 1-120 characters.' });
    return;
  }
  let agenda: AgendaItem[] = [];
  if (parsed.value.agenda !== undefined) {
    const parsedAgenda = parseAgendaInput(parsed.value.agenda);
    if (!parsedAgenda.ok) {
      sendJson(response, 400, { error: parsedAgenda.error });
      return;
    }
    agenda = parsedAgenda.agenda;
  }
  const paceField = meetingPaceField(parsed.value.pace);
  if (!paceField.ok) {
    sendJson(response, 400, { error: paceField.error });
    return;
  }
  const rawScheduledFor = parsed.value.scheduledFor;
  let scheduledFor: string | undefined;
  if (rawScheduledFor !== undefined && rawScheduledFor !== null) {
    if (typeof rawScheduledFor !== 'string' || Number.isNaN(Date.parse(rawScheduledFor))) {
      sendJson(response, 400, { error: 'The meeting date is not a valid date.' });
      return;
    }
    scheduledFor = new Date(rawScheduledFor).toISOString();
  }
  // The sample workspace is built in rather than a row, so it has no membership record; every
  // signed-in person may still hold a real meeting there, and practice stays one click away.
  if (workspaceId !== SAMPLE_WORKSPACE_ID) {
    const membership = await store.getMembership({ workspaceId, userId: creatorId });
    if (membership === undefined) {
      sendJson(response, 403, { error: 'You are not a member of that workspace.' });
      return;
    }
  }
  const ownerProblem = await agendaOwnerProblem(store, workspaceId, agenda);
  if (ownerProblem !== undefined) {
    sendJson(response, 400, { error: ownerProblem });
    return;
  }

  try {
    const meeting = await registry.create({
      workspaceId,
      ownerUserId: creatorId,
      title,
      agenda,
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
      ...(paceField.pace === undefined ? {} : { pace: paceField.pace }),
    });
    sendJson(response, 200, { id: meeting.id, link: `/m/${meeting.id}` });
  } catch (error) {
    if (error instanceof MeetingBusyError) {
      sendJson(response, 503, { error: 'busy', message: error.message });
      return;
    }
    throw error;
  }
}

/** The public facts a visitor may see from a meeting link; the id is the capability. */
export async function handleMeetingInfo(call: RouteCall): Promise<void> {
  const { response, context, path, principal } = call;
  const id = meetingIdFrom(path, 'info');
  const meetings = context.meetings;
  const store = context.authStore;
  if (id === undefined || meetings === undefined || store === undefined) {
    sendJson(response, 404, { error: 'meeting-not-found' });
    return;
  }
  const row = await meetings.get(id);
  if (row === undefined) {
    sendJson(response, 404, { error: 'meeting-not-found' });
    return;
  }
  const workspace = await store.getWorkspace(row.workspaceId);
  const workspaceName =
    workspace?.name ??
    (row.workspaceId === SAMPLE_WORKSPACE_ID ? SAMPLE_WORKSPACE.name : null);
  const owner = row.ownerUserId === null ? undefined : await store.findUserById(row.ownerUserId);
  // Only this meeting's owner or a workspace member may be pointed at its minutes.
  let historyWorkspaceId: string | null = null;
  const viewerId = accountUserId(principal);
  if (row.status === 'ended' && viewerId !== undefined) {
    const isOwner = row.ownerUserId === viewerId;
    const isMember =
      isOwner ||
      (await store.getMembership({ workspaceId: row.workspaceId, userId: viewerId })) !== undefined;
    if (isMember) historyWorkspaceId = row.workspaceId;
  }
  sendJson(response, 200, {
    title: row.title,
    workspaceName,
    scheduledFor: row.scheduledFor,
    status: meetingStatusNow(row),
    ownerName: owner === undefined ? null : (owner.name ?? owner.email),
    historyWorkspaceId,
  });
}

/** Join one meeting as a guest, or tell a signed-in user they already have their Google name. */
export async function handleMeetingJoin(call: RouteCall): Promise<void> {
  const { request, response, context, path, principal } = call;
  const id = meetingIdFrom(path, 'join');
  const meetings = context.meetings;
  const auth = context.auth;
  if (id === undefined || meetings === undefined || auth === undefined) {
    sendJson(response, 404, { error: 'meeting-not-found' });
    return;
  }
  const row = await meetings.get(id);
  if (row === undefined) {
    sendJson(response, 404, { error: 'meeting-not-found' });
    return;
  }
  if (row.status === 'ended') {
    sendJson(response, 409, { error: 'This meeting has ended' });
    return;
  }

  if (accountUserId(principal) !== undefined) {
    // Signed-in people join under their Google name; joining never adds them to the workspace.
    const name = 'name' in principal ? principal.name ?? '' : '';
    sendJson(response, 200, { ok: true, name });
    return;
  }

  const limiter = context.guestJoinAttempts;
  const key = clientAddress(request);
  if (limiter?.isLimited(key) === true) {
    sendJson(response, 429, { error: 'Too many joins from this address. Wait a minute and try again.' });
    return;
  }

  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  if (!isObject(parsed.value)) {
    sendJson(response, 400, { error: "Something went wrong sending that. Reload and try again." });
    return;
  }
  const name = guestName(parsed.value.name);
  if (name === undefined) {
    limiter?.recordFailure(key);
    sendJson(response, 400, { error: 'Your name must be 1-40 characters.' });
    return;
  }

  const cookie = await auth.createGuestSession(id, name);
  limiter?.recordFailure(key);
  response.setHeader('set-cookie', cookie);
  sendJson(response, 200, { ok: true, name });
}

/** Resolve a real meeting's code to its id, so an invitee can open its join page. */
export async function handleMeetingByCode(call: RouteCall): Promise<void> {
  const { request, response, context, path } = call;
  const registry = context.registry;
  if (registry === undefined) {
    sendJson(response, 404, { error: 'meeting-not-found' });
    return;
  }
  const limiter = context.guestJoinAttempts;
  const key = clientAddress(request);
  if (limiter?.isLimited(key) === true) {
    sendJson(response, 429, { error: 'Too many attempts from this address. Wait a minute and try again.' });
    return;
  }
  const match = /^\/api\/meetings\/by-code\/([^/]+)$/.exec(path);
  let code = '';
  try {
    code = match === null ? '' : decodeURIComponent(match[1] ?? '');
  } catch {
    code = '';
  }
  const id = await registry.findByCode(code);
  if (id === undefined) {
    limiter?.recordFailure(key);
    sendJson(response, 404, {
      error: "We couldn't find a meeting with that code. Check it, or open the invite link.",
    });
    return;
  }
  sendJson(response, 200, { id });
}

/** Edit a scheduled meeting's title, agenda (with member owners) and pace. */
export async function handleUpdateMeeting(call: RouteCall): Promise<void> {
  const { request, response, path, context } = call;
  const match = /^\/api\/meetings\/([^/]+)$/.exec(path);
  const id = match === null ? undefined : decodeURIComponent(match[1] ?? '');
  if (id === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return;
  }
  const row = await meetingForManagement(call, id);
  if (row === undefined) return;
  const store = context.authStore;
  if (store === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return;
  }
  const status = meetingStatusNow(row);
  if (status !== 'scheduled') {
    sendJson(response, 409, {
      error:
        status === 'ended'
          ? 'This meeting has already ended.'
          : 'This meeting is open now. End it from the list instead of editing it.',
    });
    return;
  }
  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  if (!isObject(parsed.value)) {
    sendJson(response, 400, { error: "Something went wrong sending that. Reload and try again." });
    return;
  }

  const patch: {
    title?: string;
    agenda?: AgendaItem[];
    scheduledFor?: string;
    pace?: MeetingPace;
  } = {};
  if (parsed.value.title !== undefined) {
    const title = meetingTitle(parsed.value.title);
    if (title === undefined) {
      sendJson(response, 400, { error: 'A meeting title must be 1-120 characters.' });
      return;
    }
    patch.title = title;
  }
  if (parsed.value.agenda !== undefined) {
    const parsedAgenda = parseAgendaInput(parsed.value.agenda);
    if (!parsedAgenda.ok) {
      sendJson(response, 400, { error: parsedAgenda.error });
      return;
    }
    const ownerProblem = await agendaOwnerProblem(store, row.workspaceId, parsedAgenda.agenda);
    if (ownerProblem !== undefined) {
      sendJson(response, 400, { error: ownerProblem });
      return;
    }
    patch.agenda = parsedAgenda.agenda;
  }
  if (parsed.value.pace !== undefined) {
    const paceField = meetingPaceField(parsed.value.pace);
    if (!paceField.ok) {
      sendJson(response, 400, { error: paceField.error });
      return;
    }
    if (paceField.pace !== undefined) patch.pace = paceField.pace;
  }
  if (parsed.value.scheduledFor !== undefined) {
    const raw = parsed.value.scheduledFor;
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
      sendJson(response, 400, { error: 'The meeting date is not a valid date.' });
      return;
    }
    const when = new Date(raw);
    if (when.getTime() <= Date.now()) {
      sendJson(response, 400, { error: 'Choose a future date and time.' });
      return;
    }
    patch.scheduledFor = when.toISOString();
  }
  if (Object.keys(patch).length === 0) {
    sendJson(response, 400, { error: 'Change something before saving.' });
    return;
  }

  const registry = context.registry;
  if (registry === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return;
  }
  const updated = await registry.updateScheduled(id, patch);
  if (updated === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return;
  }
  sendJson(response, 200, { ok: true });
}

/** Cancel a scheduled meeting, deleting its row, state, seat claims and knowledge chunk. */
export async function handleCancelMeeting(call: RouteCall): Promise<void> {
  const { response, path, context } = call;
  const match = /^\/api\/meetings\/([^/]+)$/.exec(path);
  const id = match === null ? undefined : decodeURIComponent(match[1] ?? '');
  if (id === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return;
  }
  const row = await meetingForManagement(call, id);
  if (row === undefined) return;
  const status = meetingStatusNow(row);
  if (status !== 'scheduled') {
    sendJson(response, 409, {
      error:
        status === 'ended'
          ? 'This meeting has already ended.'
          : 'This meeting is open now. End it instead of cancelling it.',
    });
    return;
  }
  const registry = context.registry;
  if (registry === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return;
  }
  await registry.cancel(id);
  sendJson(response, 200, { ok: true });
}

/** End an open meeting from the list, writing its minutes as the room would. */
export async function handleEndMeeting(call: RouteCall): Promise<void> {
  const { response, path, context } = call;
  const match = /^\/api\/meetings\/([^/]+)\/end$/.exec(path);
  const id = match === null ? undefined : decodeURIComponent(match[1] ?? '');
  if (id === undefined) {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return;
  }
  const row = await meetingForManagement(call, id);
  if (row === undefined) return;
  const status = meetingStatusNow(row);
  if (status === 'ended') {
    sendJson(response, 409, { error: 'This meeting has already ended.' });
    return;
  }
  if (status === 'scheduled') {
    sendJson(response, 409, { error: 'This meeting is scheduled. Cancel it instead.' });
    return;
  }
  const registry = context.registry;
  if (registry === undefined) {
    sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
    return;
  }
  const outcome = await registry.endMeeting(id);
  if (outcome === 'not-found') {
    sendJson(response, 404, { error: 'Meeting not found.' });
    return;
  }
  if (outcome === 'starting') {
    sendJson(response, 409, {
      error: 'The meeting is starting; try again in a moment.',
      retryable: true,
    });
    return;
  }
  sendJson(response, 200, { ok: true, status: 'ended' });
}
