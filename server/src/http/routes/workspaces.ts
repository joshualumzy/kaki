import { isObject } from '@kaki/shared';
import { accountUserId } from '../access';
import { readJsonBody, sendJson } from '../http';
import type { RouteCall } from '../routeCall';
import type { WorkspaceMember, WorkspaceRecord } from '../../auth/store';
import { SAMPLE_WORKSPACE } from '../../workspace/sample';
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
      settings: record?.settings ?? {},
      lastOkAt: record?.lastOkAt ?? null,
    };
  });
}

/** Send the one clear answer for a server key that is missing, invalid or has changed. */
function sendSecretProblem(response: Parameters<typeof sendJson>[0], error: SecretKeyError): void {
  sendJson(response, error.problem === 'wrong-key' ? 409 : 503, { error: error.message });
}

function tokenForKindRequired(kind: WorkspaceToolKind): boolean {
  return kind === 'mattermost' || kind === 'gitea' || kind === 'wiki';
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
    if (!tokenForKindRequired(kind)) {
      token = '';
    } else {
      const saved = await store.get(workspaceId, kind);
      if (saved === undefined) {
        return { error: 'Connect this tool first, or send its token with the test.', status: 400 };
      }
      // The saved token only ever goes to the address it was saved for.
      if (normalized.settings.url !== saved.settings.url) {
        return { error: 'A new address needs its token. Enter the token again.', status: 400 };
      }
      try {
        token = decryptSecret(saved, parseSecretKey(env.KAKI_SECRET_KEY));
      } catch (error) {
        if (error instanceof SecretKeyError) {
          return { error: error.message, status: error.problem === 'wrong-key' ? 409 : 503 };
        }
        throw error;
      }
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

  const historyMatch = /^\/api\/workspaces\/([^/]+)\/meetings(?:\/([^/]+)(?:\/minutes|\/todos\/([^/]+))?)?$/.exec(path);
  if (historyMatch !== null) {
    const historyWorkspaceId = decodeURIComponent(historyMatch[1] ?? '');
    const meetingId = historyMatch[2] === undefined ? undefined : decodeURIComponent(historyMatch[2]);
    const todoId = historyMatch[3] === undefined ? undefined : decodeURIComponent(historyMatch[3]);
    const meetings = context.meetings;
    if (meetings === undefined) {
      sendJson(response, 500, { error: 'Meeting storage is unavailable.' });
      return;
    }
    if (historyWorkspaceId === SAMPLE_WORKSPACE_ID) {
      sendJson(response, 403, { error: "The sample workspace's meetings are built in" });
      return;
    }
    const membership = await store.getMembership({ workspaceId: historyWorkspaceId, userId: userId });
    if (membership === undefined) {
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
    if (meeting === undefined || meeting.workspaceId !== historyWorkspaceId) {
      sendJson(response, 404, { error: 'Meeting not found' });
      return;
    }
    if (meeting.status !== 'ended') {
      sendJson(response, 409, { error: 'This meeting has not ended yet.' });
      return;
    }
    const canEdit = meeting.ownerUserId === userId || membership === 'admin';

    if (method === 'GET' && todoId === undefined && path.endsWith('/minutes')) {
      sendJson(response, 200, {
        id: meeting.id,
        title: meeting.title,
        date: meeting.endedAt ?? meeting.createdAt,
        minutes: meeting.minutes?.minutes ?? null,
        todos: meeting.minutes?.todos ?? [],
        canEdit,
      });
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
              decryptSecret(record, key);
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
          void context.indexWorkspaceTool({ workspaceId: toolWorkspaceId, kind, tools }).catch(
            (error: unknown) =>
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
        settings: test.settings,
        lastOkAt: now,
      });
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
      agenda: row.agenda,
      ownerName: row.ownerUserId === null ? null : (ownerNames.get(row.ownerUserId) ?? null),
    }));
    const toolRecords = (await context.workspaceTools?.list(workspaceId)) ?? [];
    sendJson(response, 200, {
      id: workspace.id,
      name: workspace.name,
      readOnly: false,
      people,
      tools: toolStatuses(toolRecords),
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
