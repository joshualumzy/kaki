import { randomBytes } from 'node:crypto';
import { isObject } from '@kaki/shared';
import { accountUserId } from '../access';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import {
  WorkspaceMemberError,
  type WorkspaceMember,
  type WorkspaceRecord,
  type WorkspaceRole,
} from '../../auth/store';
import { SAMPLE_WORKSPACE } from '../../workspace/sample';
import { CalendarUnreachableError } from '../../meeting/calendarEvent';
import type { MeetingInstance } from '../../meeting/instance';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import { connectorFor, ConnectorError } from '../../workspace/connector';
import { decryptSecret, parseSecretKey, SecretKeyError } from '../../workspace/secrets';
import {
  encryptToolToken,
  isWorkspaceToolKind,
  WORKSPACE_TOOL_KINDS,
  type WorkspaceToolKind,
  type WorkspaceToolRecord,
  type WorkspaceToolStore,
} from '../../workspace/tools';

const MAX_BODY_BYTES = 64_000;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 60;

function workspaceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) return undefined;
  return name;
}

function memberName(member: WorkspaceMember): string {
  return member.name ?? member.email;
}

function summary(workspace: WorkspaceRecord, role: 'admin' | 'member') {
  return { id: workspace.id, name: workspace.name, kind: workspace.kind, role };
}

function toolStatuses(records: WorkspaceToolRecord[]) {
  const byKind = new Map(records.map((record) => [record.kind, record]));
  return WORKSPACE_TOOL_KINDS.map((kind) => {
    const record = byKind.get(kind);
    return {
      kind,
      connected: record !== undefined,
      hasSecret: false,
      settings: record?.settings ?? {},
      lastOkAt: record?.lastOkAt ?? null,
    };
  });
}

/** Send the one clear answer for a server key that is missing, invalid or has changed. */
function sendSecretProblem(response: Parameters<typeof sendJson>[0], error: SecretKeyError): void {
  sendJson(response, error.problem === 'wrong-key' ? 409 : 503, { error: error.message });
}

/** Turn a refused membership change into its plain answer; false means it is not one of those. */
function sendMemberRefusal(
  response: Parameters<typeof sendJson>[0],
  error: WorkspaceMemberError,
  action: 'remove' | 'leave' | 'patch',
): boolean {
  switch (error.problem) {
    case 'not-admin':
      sendJson(response, 403, { error: 'Only a workspace admin can change members.' });
      return true;
    case 'last-admin':
      sendJson(response, 409, {
        error:
          action === 'leave'
            ? "You are the workspace's last admin. Make someone else an admin first."
            : "This is the workspace's last admin. Make someone else an admin first.",
      });
      return true;
    case 'open-meeting':
      sendJson(response, 409, { error: error.message });
      return true;
  }
}

function tokenForKindRequired(kind: WorkspaceToolKind): boolean {
  return kind === 'mattermost' || kind === 'gitea' || kind === 'wiki';
}

function settingText(settings: Record<string, unknown>, name: string): string {
  const value = settings[name];
  return typeof value === 'string' ? value : '';
}

/** Whether the saved secret still belongs to the address and login in these settings. */
function savedSecretApplies(
  kind: WorkspaceToolKind,
  next: Record<string, unknown>,
  saved: Record<string, unknown>,
): boolean {
  switch (kind) {
    case 'email':
      // The one saved secret opens both the SMTP sending side and the mailbox read side, so reuse
      // is bound to every destination that receives it. Moving either address needs the secret again.
      return (
        settingText(next, 'smtpHost') === settingText(saved, 'smtpHost') &&
        Number(next.smtpPort) === Number(saved.smtpPort) &&
        settingText(next, 'mailpitUrl') === settingText(saved, 'mailpitUrl') &&
        settingText(next, 'user') === settingText(saved, 'user')
      );
    case 'calendar':
      return (
        settingText(next, 'caldavUrl') === settingText(saved, 'caldavUrl') &&
        settingText(next, 'user') === settingText(saved, 'user')
      );
    default:
      return settingText(next, 'url') === settingText(saved, 'url');
  }
}

/** A fresh, unguessable invite token: 32 random bytes, safe in a URL. */
function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function invitePath(token: string): string {
  return `/join-workspace/${encodeURIComponent(token)}`;
}

function workspaceRoleValue(value: unknown): WorkspaceRole | undefined {
  return value === 'admin' || value === 'member' ? value : undefined;
}

/** Whether this member owns a meeting that is live in the workspace right now. */
async function memberHasOpenMeeting(
  context: RouteCall['context'],
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = (await context.meetings?.list(workspaceId)) ?? [];
  return rows.some((row) => row.status === 'open' && row.ownerUserId === userId);
}

interface ToolTestValues {
  settings: Record<string, unknown>;
  token: string;
}

/** Check a submitted connection and prove its chosen channel/repo/prefix exists. */
async function testTool(
  kind: WorkspaceToolKind,
  settings: Record<string, unknown>,
  token: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const connector = connectorFor(kind);
  const result = await connector.test(settings, token);
  if (!result.ok) return { ok: false, message: result.message };
  const wanted = connector.targetRef(settings);
  if (wanted !== undefined) {
    try {
      const targets = await connector.listTargets(settings, token);
      if (!targets.some((target) => target.id === wanted || target.label === wanted)) {
        return {
          ok: false,
          message: `${wanted} was not found in the ${kind} account. Pick one it offers and test again.`,
        };
      }
    } catch (error) {
      if (error instanceof ConnectorError) return { ok: false, message: error.message };
      throw error;
    }
  }
  return { ok: true, message: result.detail };
}

/** Resolve the settings and token a test should use, falling back to the saved token. */
async function readToolTest(
  store: WorkspaceToolStore,
  workspaceId: string,
  kind: WorkspaceToolKind,
  body: unknown,
  env: NodeJS.ProcessEnv,
): Promise<ToolTestValues | { error: string; status: number }> {
  if (!isObject(body)) return { error: "Something went wrong sending that. Reload and try again.", status: 400 };
  const connector = connectorFor(kind);
  const normalized = connector.normalizeSettings(body.settings);
  if (!normalized.ok) return { error: normalized.error, status: 400 };

  let token = typeof body.token === 'string' ? body.token : undefined;
  if (token === undefined) {
    const saved = await store.get(workspaceId, kind);
    if (saved !== undefined && savedSecretApplies(kind, normalized.settings, saved.settings)) {
      try {
        token = decryptSecret(saved, parseSecretKey(env.KAKI_SECRET_KEY));
      } catch (error) {
        if (error instanceof SecretKeyError) {
          return { error: error.message, status: error.problem === 'wrong-key' ? 409 : 503 };
        }
        throw error;
      }
    } else if (tokenForKindRequired(kind)) {
      if (saved === undefined) {
        return { error: 'Connect this tool first, or send its token with the test.', status: 400 };
      }
      return { error: 'A new address needs its token. Enter the token again.', status: 400 };
    } else {
      token = '';
    }
  }
  if (tokenForKindRequired(kind) && token.trim() === '') {
    return { error: 'This tool needs a token.', status: 400 };
  }
  return { settings: normalized.settings, token };
}

/** Serves the signed-in workspace API: list, create, read and rename. */
export async function handleWorkspaces(call: RouteCall): Promise<void> {
  const { request, response, context, method, path, principal } = call;
  const store = context.authStore;
  if (store === undefined) {
    sendJson(response, 500, { error: 'Workspace storage is unavailable.' });
    return;
  }
  // A person who took a meeting seat keeps their account; only the seat grant changed.
  const userId = accountUserId(principal);
  if (userId === undefined) {
    sendJson(response, 403, { error: 'Sign in with Google to use workspaces.' });
    return;
  }

  const joinInviteMatch = /^\/api\/workspace-invites\/([^/]+)$/.exec(path);
  if (joinInviteMatch !== null) {
    if (method !== 'POST') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const token = decodeURIComponent(joinInviteMatch[1] ?? '');
    const joined = await store.joinWorkspaceByInvite({ token, userId });
    if (joined === undefined) {
      sendJson(response, 404, { error: 'This invite link is not valid.' });
      return;
    }
    sendJson(response, 200, summary(joined.workspace, joined.role));
    return;
  }

  const inviteMatch = /^\/api\/workspaces\/([^/]+)\/invite(?:\/(reset))?$/.exec(path);
  if (inviteMatch !== null) {
    const inviteWorkspaceId = decodeURIComponent(inviteMatch[1] ?? '');
    const isReset = inviteMatch[2] === 'reset';
    if (inviteWorkspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace has no invite link." });
      return;
    }
    const membership = await store.getMembership({ workspaceId: inviteWorkspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can manage the invite link.' });
      return;
    }
    const workspace = await store.getWorkspace(inviteWorkspaceId);
    if (workspace === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (workspace.kind !== 'team') {
      sendJson(response, 403, { error: 'Personal workspaces do not use invite links.' });
      return;
    }
    if (method === 'GET' && !isReset) {
      const invite = await store.ensureWorkspaceInvite({
        workspaceId: inviteWorkspaceId,
        token: newInviteToken(),
        createdBy: userId,
      });
      sendJson(response, 200, {
        token: invite.token,
        path: invitePath(invite.token),
        workspace: { id: workspace.id, name: workspace.name },
      });
      return;
    }
    if (method === 'POST' && isReset) {
      const invite = await store.saveWorkspaceInvite({
        workspaceId: inviteWorkspaceId,
        token: newInviteToken(),
        createdBy: userId,
      });
      sendJson(response, 200, {
        token: invite.token,
        path: invitePath(invite.token),
        workspace: { id: workspace.id, name: workspace.name },
      });
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const memberMatch = /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(path);
  if (memberMatch !== null) {
    const memberWorkspaceId = decodeURIComponent(memberMatch[1] ?? '');
    const memberId = decodeURIComponent(memberMatch[2] ?? '');
    if (memberWorkspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace's people are built in." });
      return;
    }
    const membership = await store.getMembership({ workspaceId: memberWorkspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can change members.' });
      return;
    }
    const targetRole = await store.getMembership({ workspaceId: memberWorkspaceId, userId: memberId });
    if (targetRole === undefined) {
      sendJson(response, 404, { error: 'That person is not in this workspace.' });
      return;
    }
    if (method === 'DELETE') {
      try {
        await store.removeWorkspaceMember({
          workspaceId: memberWorkspaceId,
          userId: memberId,
          actorUserId: userId,
          // Re-run inside the store's workspace lock, so a meeting created concurrently cannot slip
          // between an earlier check and the membership delete.
          assertRemovable: async () => {
            if (await memberHasOpenMeeting(context, memberWorkspaceId, memberId)) {
              throw new WorkspaceMemberError(
                'open-meeting',
                'This person owns an open meeting in this workspace. End it before removing them.',
              );
            }
          },
        });
      } catch (error) {
        if (error instanceof WorkspaceMemberError && sendMemberRefusal(response, error, 'remove')) {
          return;
        }
        throw error;
      }
      // A scheduled meeting never blocks removal, so hand it to the admin doing the removal before
      // their membership (and with it every host power) disappears.
      try {
        await context.meetings?.transferScheduledOwnership?.({
          workspaceId: memberWorkspaceId,
          fromUserId: memberId,
          toUserId: userId,
        });
      } catch (error) {
        console.error(
          `kaki workspaces: could not transfer the scheduled meetings of ${memberId} in ${memberWorkspaceId}`,
          error,
        );
      }
      // Their live sockets and LiveKit audio in this workspace's meetings go now; a reconnect
      // re-checks membership before any new room token is issued.
      await context.registry?.endWorkspaceMember?.(memberWorkspaceId, memberId);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const role = isObject(body.value) ? workspaceRoleValue(body.value.role) : undefined;
      if (role === undefined) {
        sendJson(response, 400, { error: 'Choose admin or member.' });
        return;
      }
      try {
        const change = async (): Promise<void> => {
          // The store rechecks the actor's admin role inside its locked transaction, so a request
          // held across the actor's demotion cannot change anyone (including themselves).
          const updated = await store.setWorkspaceMemberRole({
            workspaceId: memberWorkspaceId,
            userId: memberId,
            role,
            actorUserId: userId,
          });
          if (updated === undefined) {
            sendJson(response, 404, { error: 'That person is not in this workspace.' });
            return;
          }
          if (targetRole === 'admin' && role === 'member') {
            // A demoted admin keeps host authority only for meetings they still own; every other
            // screen, lifecycle and seat socket they opened in this workspace closes now.
            await context.registry?.endWorkspaceMember?.(memberWorkspaceId, memberId, {
              keepOwner: true,
            });
          }
          sendJson(response, 200, { role: updated });
        };
        await change();
      } catch (error) {
        if (error instanceof WorkspaceMemberError && sendMemberRefusal(response, error, 'patch')) {
          return;
        }
        throw error;
      }
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const leaveMatch = /^\/api\/workspaces\/([^/]+)\/leave$/.exec(path);
  if (leaveMatch !== null) {
    if (method !== 'POST') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const leaveWorkspaceId = decodeURIComponent(leaveMatch[1] ?? '');
    if (leaveWorkspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "You cannot leave the sample workspace." });
      return;
    }
    const membership = await store.getMembership({ workspaceId: leaveWorkspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    // A member leaving still owns scheduled meetings; hand them to an admin who stays behind.
    const successor = (await store.listWorkspaceMembers(leaveWorkspaceId)).find(
      (member) => member.role === 'admin' && member.userId !== userId,
    );
    try {
      await store.removeWorkspaceMember({
        workspaceId: leaveWorkspaceId,
        userId,
        actorUserId: userId,
        assertRemovable: async () => {
          if (await memberHasOpenMeeting(context, leaveWorkspaceId, userId)) {
            throw new WorkspaceMemberError(
              'open-meeting',
              'You own an open meeting in this workspace. End it before leaving.',
            );
          }
        },
      });
    } catch (error) {
      if (error instanceof WorkspaceMemberError && sendMemberRefusal(response, error, 'leave')) {
        return;
      }
      throw error;
    }
    if (successor !== undefined) {
      try {
        await context.meetings?.transferScheduledOwnership?.({
          workspaceId: leaveWorkspaceId,
          fromUserId: userId,
          toUserId: successor.userId,
        });
      } catch (error) {
        console.error(
          `kaki workspaces: could not transfer the scheduled meetings of ${userId} in ${leaveWorkspaceId}`,
          error,
        );
      }
    }
    await context.registry?.endWorkspaceMember?.(leaveWorkspaceId, userId);
    sendJson(response, 200, { ok: true });
    return;
  }

  const historyMatch = /^\/api\/workspaces\/([^/]+)\/meetings(?:\/([^/]+)(?:\/minutes(?:\/publish)?|\/todos\/([^/]+))?)?$/.exec(path);
  if (historyMatch !== null) {
    const historyWorkspaceId = decodeURIComponent(historyMatch[1] ?? '');
    const meetingId = historyMatch[2] === undefined ? undefined : decodeURIComponent(historyMatch[2]);
    const todoId = historyMatch[3] === undefined ? undefined : decodeURIComponent(historyMatch[3]);
    const isPublishing = path.endsWith('/minutes/publish');
    const meetings = context.meetings;
    if (meetings === undefined) {
      sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
      return;
    }
    // The sample workspace is built in and read-only: it has no members, but a person may list
    // their own real meetings there and read their minutes. They may not edit its to-dos or publish.
    const isSample = historyWorkspaceId === SAMPLE_WORKSPACE_ID;
    if (isSample && (method !== 'GET' || todoId !== undefined || isPublishing)) {
      sendJson(response, 403, { error: "The sample workspace's meetings are read-only" });
      return;
    }
    const membership = isSample
      ? undefined
      : await store.getMembership({ workspaceId: historyWorkspaceId, userId: userId });
    if (!isSample && membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }

    if (method === 'GET' && meetingId === undefined) {
      const rows = await meetings.list(historyWorkspaceId);
      sendJson(
        response,
        200,
        rows
          .filter((row) => row.status === 'ended')
          .filter((row) => !isSample || row.ownerUserId === userId)
          .map((row) => ({
            id: row.id,
            title: row.title,
            date: row.endedAt ?? row.createdAt,
            status: row.status,
          })),
      );
      return;
    }

    if (meetingId === undefined) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const meeting = await meetings.get(meetingId);
    if (
      meeting === undefined ||
      meeting.workspaceId !== historyWorkspaceId ||
      (isSample && meeting.ownerUserId !== userId)
    ) {
      sendJson(response, 404, { error: 'Meeting not found' });
      return;
    }
    if (meeting.status !== 'ended') {
      sendJson(response, 409, { error: 'This meeting has not ended yet.' });
      return;
    }
    const canEdit = !isSample && (meeting.ownerUserId === userId || membership === 'admin');

    if (method === 'GET' && todoId === undefined && path.endsWith('/minutes')) {
      const wikiConnected =
        context.workspaceTools !== undefined &&
        (await context.workspaceTools.get(historyWorkspaceId, 'wiki')) !== undefined;
      sendJson(response, 200, {
        id: meeting.id,
        title: meeting.title,
        date: meeting.endedAt ?? meeting.createdAt,
        minutes: meeting.minutes?.minutes ?? null,
        todos: meeting.minutes?.todos ?? [],
        canEdit,
        wikiConnected,
        publish: meeting.minutesPublish ?? null,
      });
      return;
    }

    if (isPublishing) {
      if (method !== 'POST') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      if (!canEdit) {
        sendJson(response, 403, {
          error: 'Only the meeting owner or a workspace admin can publish the minutes.',
        });
        return;
      }
      const minutesText = meeting.minutes?.minutes;
      if (minutesText === undefined || minutesText.trim() === '') {
        sendJson(response, 409, { error: 'The minutes are still being prepared. Reload in a moment.' });
        return;
      }
      const wiki =
        context.workspaceTools === undefined
          ? undefined
          : await context.workspaceTools.get(historyWorkspaceId, 'wiki');
      if (wiki === undefined) {
        sendJson(response, 409, {
          error: 'No wiki is connected in this workspace, so the minutes cannot be published.',
        });
        return;
      }
      if (context.registry === undefined) {
        sendJson(response, 503, { error: 'Kaki could not open this meeting’s minutes. Try again in a moment.' });
        return;
      }
      let instance: MeetingInstance | undefined;
      try {
        instance = await context.registry.get(meetingId);
      } catch (error) {
        console.error(`kaki workspaces: could not open ${meetingId} to publish its minutes`, error);
        sendJson(response, 503, { error: 'Kaki could not open this meeting’s minutes. Try again in a moment.' });
        return;
      }
      if (instance === undefined) {
        sendJson(response, 409, {
          error: 'There are no publishable minutes for this meeting. Copy or download them instead.',
        });
        return;
      }
      // A meeting that ended before its card was kept (an older save, or a silent room) can still
      // publish the copy Kaki archived: make the same minutes card here and send it down the same path.
      let task = instance.tasks.list().find((candidate) => candidate.purpose === 'meeting_minutes');
      if (task === undefined) {
        const roles = instance.session.active().roles;
        const assignee =
          roles.find((role) => role.facilitator === true && role.id !== 'everyone')?.id ??
          roles.find((role) => role.id !== 'everyone')?.id ??
          roles[0]?.id;
        if (assignee === undefined) {
          sendJson(response, 409, {
            error: 'There are no publishable minutes for this meeting. Copy or download them instead.',
          });
          return;
        }
        try {
          const created = instance.tasks.suggestWithPurpose(
            {
              title: 'Publish meeting minutes to the team wiki',
              context: `Full summary of ${meeting.title} (agenda, action items, open questions, and discussion transcript).`,
              suggestedAssignee: assignee,
              actionKind: 'wiki_page',
            },
            'meeting_minutes',
          );
          instance.tasks.transition(created.id, 'DISPATCHED', { assignee });
          instance.tasks.transition(created.id, 'CLAIMED', {
            mode: 'ACTION_AGENT',
            draft: {
              target: 'Wiki: meeting notes',
              subject: `${meeting.title} — Meeting Minutes`,
              body: minutesText,
            },
          });
          instance.tasks.transition(created.id, 'DRAFT_READY');
          task = instance.tasks.get(created.id);
        } catch (error) {
          console.error(`kaki workspaces: could not draft the minutes of ${meetingId} to publish`, error);
          sendJson(response, 409, { error: 'Kaki could not prepare these minutes to publish. Try again.' });
          return;
        }
      }
      if (task === undefined) {
        sendJson(response, 409, {
          error: 'There are no publishable minutes for this meeting. Copy or download them instead.',
        });
        return;
      }
      if (task.status === 'COMPLETED' || task.status === 'SYNCED') {
        sendJson(response, 200, {
          publish: {
            status: 'published',
            ...(task.artifactUrl === undefined ? {} : { artifactUrl: task.artifactUrl }),
          },
        });
        return;
      }
      if (task.status === 'RUNNING') {
        sendJson(response, 202, { publish: { status: 'publishing' } });
        return;
      }
      if (task.status !== 'DRAFT_READY' && task.status !== 'FAILED') {
        sendJson(response, 409, { error: 'The minutes cannot be published right now.' });
        return;
      }
      try {
        instance.tasks.transition(task.id, 'RUNNING', {
          draft: {
            target: task.draft?.target ?? 'Wiki: meeting notes',
            subject: task.draft?.subject ?? `${meeting.title} — Meeting Minutes`,
            // Publish exactly the copy the owner reviewed on this page.
            body: minutesText,
          },
        });
      } catch (error) {
        console.error(`kaki workspaces: could not start publishing the minutes of ${meetingId}`, error);
        sendJson(response, 409, { error: 'Kaki could not start publishing these minutes. Try again.' });
        return;
      }
      sendJson(response, 202, { publish: { status: 'publishing' } });
      return;
    }

    if (method === 'POST' && todoId !== undefined) {
      if (!canEdit) {
        sendJson(response, 403, { error: 'Only the meeting owner or a workspace admin can tick a to-do.' });
        return;
      }
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isObject(body.value) || typeof body.value.done !== 'boolean') {
        sendJson(response, 400, { error: "Something went wrong sending that. Reload and try again." });
        return;
      }
      const todos = await meetings.setTodoDone?.(meetingId, todoId, body.value.done);
      if (todos === undefined) {
        sendJson(response, 404, { error: 'That to-do is not in this meeting’s minutes.' });
        return;
      }
      sendJson(response, 200, { todos });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const toolsMatch = /^\/api\/workspaces\/([^/]+)\/tools(?:\/([^/]+))?(?:\/(test))?$/.exec(path);
  if (toolsMatch !== null) {
    const toolStore = context.workspaceTools;
    if (toolStore === undefined) {
      sendJson(response, 500, { error: 'Workspace tool storage is unavailable.' });
      return;
    }
    const toolWorkspaceId = decodeURIComponent(toolsMatch[1] ?? '');
    const kindValue = toolsMatch[2] === undefined ? undefined : decodeURIComponent(toolsMatch[2]);
    const isTest = toolsMatch[3] === 'test';

    if (toolWorkspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace's tools are built in" });
      return;
    }
    const membership = await store.getMembership({ workspaceId: toolWorkspaceId, userId: userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can change its tools.' });
      return;
    }

    if (method === 'GET' && kindValue === undefined && !isTest) {
      const records = await toolStore.list(toolWorkspaceId);
      const statuses: Array<{
        kind: WorkspaceToolKind;
        connected: boolean;
        hasSecret: boolean;
        settings: Record<string, unknown>;
        lastOkAt: Date | null;
        error?: string;
      }> = toolStatuses(records);
      if (records.length > 0) {
        try {
          const key = parseSecretKey(process.env.KAKI_SECRET_KEY);
          for (const status of statuses) {
            const record = records.find((entry) => entry.kind === status.kind);
            if (record === undefined) continue;
            try {
              status.hasSecret = decryptSecret(record, key).trim() !== '';
            } catch (error) {
              if (!(error instanceof SecretKeyError)) throw error;
              status.error = error.message;
            }
          }
        } catch (error) {
          if (error instanceof SecretKeyError) {
            sendSecretProblem(response, error);
            return;
          }
          throw error;
        }
      }
      sendJson(response, 200, statuses);
      return;
    }

    if (kindValue === undefined || !isWorkspaceToolKind(kindValue)) {
      sendJson(response, 404, { error: 'Unknown tool kind' });
      return;
    }
    const kind = kindValue;

    if (method === 'POST' && isTest) {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      let test: ToolTestValues;
      try {
        const values = await readToolTest(toolStore, toolWorkspaceId, kind, body.value, process.env);
        if ('error' in values) {
          sendJson(response, values.status, { error: values.error });
          return;
        }
        test = values;
      } catch (error) {
        if (error instanceof SecretKeyError) {
          sendSecretProblem(response, error);
          return;
        }
        throw error;
      }
      const result = await testTool(kind, test.settings, test.token);
      sendJson(response, 200, result);
      return;
    }

    if (method === 'PUT' && !isTest) {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      let test: ToolTestValues;
      try {
        const values = await readToolTest(toolStore, toolWorkspaceId, kind, body.value, process.env);
        if ('error' in values) {
          sendJson(response, values.status, { error: values.error });
          return;
        }
        test = values;
      } catch (error) {
        if (error instanceof SecretKeyError) {
          sendSecretProblem(response, error);
          return;
        }
        throw error;
      }
      const commit = async (): Promise<void> => {
        const result = await testTool(kind, test.settings, test.token);
        if (!result.ok) {
          sendJson(response, 400, { error: result.message });
          return;
        }
        let encrypted: ReturnType<typeof encryptToolToken>;
        try {
          encrypted = encryptToolToken(test.token, process.env);
        } catch (error) {
          if (error instanceof SecretKeyError) {
            sendSecretProblem(response, error);
            return;
          }
          throw error;
        }
        const now = new Date();
        await toolStore.save({
          workspaceId: toolWorkspaceId,
          kind,
          settings: test.settings,
          ...encrypted,
          connectedBy: userId,
          connectedAt: now,
          lastOkAt: now,
        });
        // Index the new connection in the background; the saved answer never waits for embeddings.
        try {
          const tools = await context.toolSource?.toolsFor(toolWorkspaceId);
          if (tools !== undefined && context.indexWorkspaceTool !== undefined) {
            const pending = context.indexWorkspaceTool({
              workspaceId: toolWorkspaceId,
              kind,
              tools,
            });
            void pending.catch((error: unknown) =>
              console.error(
                `kaki indexer: indexing ${kind} for workspace ${toolWorkspaceId} after connect failed`,
                error,
              ),
            );
          }
        } catch (error) {
          console.error(
            `kaki indexer: could not read ${kind} for workspace ${toolWorkspaceId} after connect`,
            error,
          );
        }
        sendJson(response, 200, {
          kind,
          connected: true,
          hasSecret: test.token.trim() !== '',
          settings: test.settings,
          lastOkAt: now,
        });
      };
      await commit();
      return;
    }

    if (method === 'DELETE' && !isTest) {
      await toolStore.delete(toolWorkspaceId, kind);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const detail = /^\/api\/workspaces\/([^/]+)$/.exec(path);
  const workspaceId = detail === null ? undefined : decodeURIComponent(detail[1] ?? '');

  if (method === 'GET' && workspaceId === undefined) {
    const memberships = await store.listWorkspacesForUser(userId);
    sendJson(response, 200, [
      ...memberships.map((membership) => summary(membership.workspace, membership.role)),
      { id: SAMPLE_WORKSPACE.id, name: SAMPLE_WORKSPACE.name, kind: SAMPLE_WORKSPACE.kind, role: 'member' },
    ]);
    return;
  }

  if (method === 'POST' && workspaceId === undefined) {
    const parsed = await readJsonBody(request, MAX_BODY_BYTES);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    if (!isObject(parsed.value)) {
      sendJson(response, 400, { error: "Something went wrong sending that. Reload and try again." });
      return;
    }
    const name = workspaceName(parsed.value.name);
    if (name === undefined) {
      sendJson(response, 400, { error: 'A workspace name must be 1-60 characters.' });
      return;
    }
    const created = await store.createWorkspace({ name, createdBy: userId });
    sendJson(response, 200, summary(created.workspace, created.role));
    return;
  }

  if (workspaceId === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (method === 'DELETE') {
    if (workspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace can't be deleted." });
      return;
    }
    const membership = await store.getMembership({ workspaceId, userId });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can delete it.' });
      return;
    }
    const workspace = await store.getWorkspace(workspaceId);
    if (workspace === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (workspace.kind !== 'team') {
      sendJson(response, 403, {
        error: 'A personal workspace is deleted together with your account.',
      });
      return;
    }
    const parsed = await readJsonBody(request, MAX_BODY_BYTES);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }
    if (!isObject(parsed.value) || typeof parsed.value.confirm !== 'string') {
      sendJson(response, 400, { error: 'Type the workspace name to confirm deleting it.' });
      return;
    }
    if (parsed.value.confirm !== workspace.name) {
      sendJson(response, 400, { error: 'The name does not match. Type the workspace name exactly.' });
      return;
    }

    const deletion = context.workspaceDeletion;
    if (deletion === undefined) {
      sendJson(response, 500, { error: 'Workspace deletion is unavailable.' });
      return;
    }
    const deleteAnyway = parsed.value.deleteAnyway === true;
    try {
      const deleted = await deletion(workspaceId, userId, async () => {
        // This runs after the workspace lock and the transactional admin recheck, so a demoted
        // admin's request can no longer cancel events or disconnect anyone.
        for (const row of (await context.meetings?.list(workspaceId)) ?? []) {
          if (row.status === 'ended') continue;
          try {
            await context.meetingCalendar?.cancelMeeting(row);
          } catch (error) {
            if (!deleteAnyway) throw error;
            // Delete anyway: this event may stay on the calendar.
            console.warn(
              `kaki workspaces: leaving the calendar event of ${row.id} behind while deleting ${workspaceId}`,
              error,
            );
          }
        }
        try {
          await context.taskCalendar?.cancelForWorkspace(workspaceId, { deleteAnyway });
        } catch (error) {
          if (!deleteAnyway) throw error;
          console.warn(
            `kaki workspaces: leaving approved follow-up events behind while deleting ${workspaceId}`,
            error,
          );
        }
        try {
          await context.registry?.unloadWorkspace(workspaceId);
        } catch (error) {
          console.error(`kaki workspaces: could not close the rooms of ${workspaceId}`, error);
        }
      });
      if (!deleted) {
        sendJson(response, 404, { error: 'Workspace not found' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        ...(deleteAnyway ? { calendarEventsMayRemain: true } : {}),
      });
    } catch (error) {
      if (error instanceof CalendarUnreachableError) {
        console.warn(
          `kaki workspaces: refusing to delete ${workspaceId} because the calendar could not be reached: ${error.detail}`,
        );
        sendJson(response, 502, {
          error: "The team calendar can't be reached, so the workspace wasn't deleted. Try again.",
          canDeleteAnyway: true,
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (method === 'GET') {
    if (workspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 200, {
        id: SAMPLE_WORKSPACE.id,
        name: SAMPLE_WORKSPACE.name,
        kind: SAMPLE_WORKSPACE.kind,
        readOnly: true,
        people: [],
        tools: [],
        meetings: [],
        counts: { meetings: 0, todos: 0, records: 0 },
      });
      return;
    }
    const membership = await store.getMembership({
      workspaceId,
      userId: userId,
    });
    if (membership === undefined) {
      // Not being a member is indistinguishable from the workspace not existing.
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    const workspace = await store.getWorkspace(workspaceId);
    if (workspace === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    const people = (await store.listWorkspaceMembers(workspaceId)).map((member) => ({
      id: member.userId,
      name: memberName(member),
      role: member.role,
    }));
    const rows = (await context.meetings?.list(workspaceId)) ?? [];
    const ownerNames = new Map<string, string>();
    for (const row of rows) {
      if (row.ownerUserId === null || ownerNames.has(row.ownerUserId)) continue;
      const owner = await store.findUserById(row.ownerUserId);
      if (owner !== undefined) ownerNames.set(owner.id, owner.name ?? owner.email);
    }
    const calendarByMeeting = new Map<string, unknown>();
    for (const row of rows) {
      const calendar = await context.meetings?.calendarEventFor?.(row.id);
      if (calendar !== undefined) calendarByMeeting.set(row.id, calendar);
    }
    const meetings = rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledFor: row.scheduledFor,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
      agenda: row.agenda,
      pace: row.pace ?? null,
      todoCount: row.minutes?.todos.length ?? 0,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId === null ? null : (ownerNames.get(row.ownerUserId) ?? null),
      calendar: calendarByMeeting.get(row.id) ?? null,
    }));
    const toolRecords = (await context.workspaceTools?.list(workspaceId)) ?? [];
    sendJson(response, 200, {
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      readOnly: false,
      people,
      tools: toolStatuses(toolRecords),
      meetings,
      counts: {
        meetings: meetings.length,
        todos: meetings.reduce((sum, meeting) => sum + meeting.todoCount, 0),
        records: 0,
      },
    });
    return;
  }

  if (method === 'PATCH') {
    if (workspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace can't be changed." });
      return;
    }
    const membership = await store.getMembership({
      workspaceId,
      userId: userId,
    });
    if (membership === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    if (membership !== 'admin') {
      sendJson(response, 403, { error: 'Only a workspace admin can rename it.' });
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
    const name = workspaceName(parsed.value.name);
    if (name === undefined) {
      sendJson(response, 400, { error: 'A workspace name must be 1-60 characters.' });
      return;
    }
    const renamed = await store.renameWorkspace({ id: workspaceId, name });
    if (renamed === undefined) {
      sendJson(response, 404, { error: 'Workspace not found' });
      return;
    }
    sendJson(response, 200, summary(renamed, 'admin'));
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}
