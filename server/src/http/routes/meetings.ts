import { isObject } from '@kaki/shared';
import { accountUserId, clientAddress } from '../access';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import { parseAgendaInput } from '../../meeting/agenda';
import type { AgendaItem, MeetingStatus } from '../../meeting/types';
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

/** Create a real meeting in one of the caller's workspaces. */
export async function handleCreateMeeting(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
  const store = context.authStore;
  const meetings = context.meetings;
  if (store === undefined || meetings === undefined) {
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

  const status: MeetingStatus =
    scheduledFor !== undefined && Date.parse(scheduledFor) > Date.now() ? 'scheduled' : 'open';
  const meeting = await meetings.create({
    workspaceId,
    ownerUserId: creatorId,
    title,
    status,
    agenda,
    ...(scheduledFor === undefined ? {} : { scheduledFor }),
  });
  sendJson(response, 200, { id: meeting.id, link: `/m/${meeting.id}` });
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
    status: row.status,
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
