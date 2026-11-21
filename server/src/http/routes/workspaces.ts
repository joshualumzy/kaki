import { isObject } from '@kaki/shared';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import type { WorkspaceMember, WorkspaceRecord } from '../../auth/store';
import { SAMPLE_WORKSPACE } from '../../workspace/sample';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';

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

/** Serves the signed-in workspace API: list, create, read and rename. */
export async function handleWorkspaces(call: RouteCall): Promise<void> {
  const { request, response, context, method, path, principal } = call;
  const store = context.authStore;
  if (store === undefined) {
    sendJson(response, 500, { error: 'Workspace storage is unavailable.' });
    return;
  }
  if (principal.kind !== 'user') {
    sendJson(response, 403, { error: 'Sign in with Google to use workspaces.' });
    return;
  }

  const detail = /^\/api\/workspaces\/([^/]+)$/.exec(path);
  const workspaceId = detail === null ? undefined : decodeURIComponent(detail[1] ?? '');

  if (method === 'GET' && workspaceId === undefined) {
    const memberships = await store.listWorkspacesForUser(principal.userId);
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
      sendJson(response, 400, { error: 'Body must be a JSON object' });
      return;
    }
    const name = workspaceName(parsed.value.name);
    if (name === undefined) {
      sendJson(response, 400, { error: 'A workspace name must be 1-60 characters.' });
      return;
    }
    const created = await store.createWorkspace({ name, createdBy: principal.userId });
    sendJson(response, 200, summary(created.workspace, created.role));
    return;
  }

  if (workspaceId === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (method === 'GET') {
    if (workspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 200, {
        id: SAMPLE_WORKSPACE.id,
        name: SAMPLE_WORKSPACE.name,
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
      userId: principal.userId,
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
    const meetings = rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledFor: row.scheduledFor,
      ownerName: row.ownerUserId === null ? null : (ownerNames.get(row.ownerUserId) ?? null),
    }));
    sendJson(response, 200, {
      id: workspace.id,
      name: workspace.name,
      readOnly: false,
      people,
      tools: [],
      meetings,
      counts: { meetings: meetings.length, todos: 0, records: 0 },
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
      userId: principal.userId,
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
      sendJson(response, 400, { error: 'Body must be a JSON object' });
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
