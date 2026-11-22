import { fetchWithTimeout } from '../net/withTimeout';

export type WorkspaceKind = 'personal' | 'team' | 'sample';

/** One workspace in the account menu and the meeting picker. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: string;
}

/** One tool's connection state as the workspace API reports it. */
export interface ToolStatus {
  kind: string;
  connected: boolean;
  settings: Record<string, unknown>;
  lastOkAt: string | null;
  error?: string;
}

/** One meeting row on a workspace page. */
export interface MeetingSummary {
  id: string;
  title: string;
  status: string;
  scheduledFor: string | null;
  ownerName: string | null;
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  readOnly: boolean;
  people: Array<{ name: string; role: string }>;
  tools: ToolStatus[];
  meetings: MeetingSummary[];
  counts: { meetings: number; todos: number; records: number };
}

export interface MeetingInfo {
  title: string;
  workspaceName: string | null;
  scheduledFor: string | null;
  status: string;
  ownerName: string | null;
}

export interface AgendaPayload {
  title: string;
  minutes?: number;
}

export interface MeetingCreated {
  id: string;
  link: string;
}

export interface CreateMeetingInput {
  workspaceId: string;
  title: string;
  agenda?: AgendaPayload[];
  scheduledFor?: string;
}

/** One ended meeting in a workspace's history. */
export interface MeetingHistoryItem {
  id: string;
  title: string;
  date: string;
  status: string;
}

/** One to-do in Kaki's copy of an ended meeting's minutes. */
export interface ArchivedTodo {
  id: string;
  title: string;
  owner: string;
  status: string;
  done: boolean;
}

/** Kaki's own copy of an ended meeting's minutes and to-dos. */
export interface MeetingMinutes {
  id: string;
  title: string;
  date: string;
  minutes: string | null;
  todos: ArchivedTodo[];
  canEdit: boolean;
}

/** A failed API call, carrying the server's sentence and HTTP status when there was one. */
export class ProductApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProductApiError';
    this.status = status;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await response.json()) as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readJsonArray(response: Response): Promise<unknown[] | null> {
  try {
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function failure(response: Response, fallback: string): Promise<ProductApiError> {
  const body = await readJson(response);
  const message =
    typeof body?.error === 'string' ? body.error : `${fallback} (HTTP ${response.status})`;
  return new ProductApiError(message, response.status);
}

function networkFailure(subject: string): ProductApiError {
  return new ProductApiError(`Could not reach the server to ${subject}.`, 0);
}

async function request(
  input: RequestInfo | URL,
  init: RequestInit,
  subject: string,
  fallback: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchWithTimeout(input, init);
  } catch {
    throw networkFailure(subject);
  }
  if (!response.ok) throw await failure(response, fallback);
  return response;
}

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return value === 'personal' || value === 'team' || value === 'sample';
}

function summaryFrom(value: unknown): WorkspaceSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    !isWorkspaceKind(record.kind) ||
    typeof record.role !== 'string'
  ) {
    return undefined;
  }
  return { id: record.id, name: record.name, kind: record.kind, role: record.role };
}

function toolStatusFrom(value: unknown): ToolStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || typeof record.connected !== 'boolean') return undefined;
  return {
    kind: record.kind,
    connected: record.connected,
    settings:
      typeof record.settings === 'object' && record.settings !== null && !Array.isArray(record.settings)
        ? (record.settings as Record<string, unknown>)
        : {},
    lastOkAt: typeof record.lastOkAt === 'string' ? record.lastOkAt : null,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

function meetingSummaryFrom(value: unknown): MeetingSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') return undefined;
  return {
    id: record.id,
    title: record.title,
    status: typeof record.status === 'string' ? record.status : 'open',
    scheduledFor: typeof record.scheduledFor === 'string' ? record.scheduledFor : null,
    ownerName: typeof record.ownerName === 'string' ? record.ownerName : null,
  };
}

function detailFrom(body: Record<string, unknown> | null): WorkspaceDetail {
  if (body === null || typeof body.id !== 'string' || typeof body.name !== 'string') {
    throw new ProductApiError('Could not load this workspace. The server sent no workspace.', 502);
  }
  const people = Array.isArray(body.people)
    ? body.people.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const record = entry as Record<string, unknown>;
        return typeof record.name === 'string' && typeof record.role === 'string'
          ? [{ name: record.name, role: record.role }]
          : [];
      })
    : [];
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((entry) => {
        const tool = toolStatusFrom(entry);
        return tool === undefined ? [] : [tool];
      })
    : [];
  const meetings = Array.isArray(body.meetings)
    ? body.meetings.flatMap((entry) => {
        const meeting = meetingSummaryFrom(entry);
        return meeting === undefined ? [] : [meeting];
      })
    : [];
  const counts =
    typeof body.counts === 'object' && body.counts !== null && !Array.isArray(body.counts)
      ? (body.counts as Record<string, unknown>)
      : {};
  return {
    id: body.id,
    name: body.name,
    readOnly: body.readOnly === true,
    people,
    tools,
    meetings,
    counts: {
      meetings: typeof counts.meetings === 'number' ? counts.meetings : 0,
      todos: typeof counts.todos === 'number' ? counts.todos : 0,
      records: typeof counts.records === 'number' ? counts.records : 0,
    },
  };
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const response = await request('/api/workspaces', {}, 'load your workspaces', 'Could not load your workspaces');
  const body = await readJsonArray(response);
  if (body === null) {
    throw new ProductApiError('Could not load your workspaces. The server sent no list.', 502);
  }
  const workspaces = body.map(summaryFrom);
  if (workspaces.some((workspace) => workspace === undefined)) {
    throw new ProductApiError('Could not read your workspaces.', 502);
  }
  return workspaces as WorkspaceSummary[];
}

export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const response = await request(
    '/api/workspaces',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    'create the workspace',
    'Could not create the workspace',
  );
  const workspace = summaryFrom(await readJson(response));
  if (workspace === undefined) {
    throw new ProductApiError('Could not create the workspace. The server sent no workspace.', 502);
  }
  return workspace;
}

export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(id)}`,
    {},
    'load this workspace',
    'Could not load this workspace',
  );
  return detailFrom(await readJson(response));
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    'rename this workspace',
    'Could not rename this workspace',
  );
  const workspace = summaryFrom(await readJson(response));
  if (workspace === undefined) {
    throw new ProductApiError('Could not rename this workspace. The server sent no workspace.', 502);
  }
  return workspace;
}

function testResult(body: Record<string, unknown> | null, fallback: string): { ok: boolean; message: string } {
  if (body === null || typeof body.ok !== 'boolean') {
    throw new ProductApiError(`${fallback} The server sent no result.`, 502);
  }
  return {
    ok: body.ok,
    message: typeof body.message === 'string' ? body.message : body.ok ? 'The connection works.' : 'The connection failed.',
  };
}

export async function testTool(
  workspaceId: string,
  kind: string,
  settings: Record<string, unknown>,
  token: string | undefined,
): Promise<{ ok: boolean; message: string }> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tools/${encodeURIComponent(kind)}/test`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings, ...(token === undefined ? {} : { token }) }),
    },
    'test the connection',
    'Could not test the connection',
  );
  return testResult(await readJson(response), 'Could not test the connection.');
}

export async function saveTool(
  workspaceId: string,
  kind: string,
  settings: Record<string, unknown>,
  token: string | undefined,
): Promise<ToolStatus> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tools/${encodeURIComponent(kind)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings, ...(token === undefined ? {} : { token }) }),
    },
    'save the connection',
    'Could not save the connection',
  );
  const tool = toolStatusFrom(await readJson(response));
  if (tool === undefined) {
    throw new ProductApiError('Could not save the connection. The server sent no tool state.', 502);
  }
  return tool;
}

export async function disconnectTool(workspaceId: string, kind: string): Promise<void> {
  await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/tools/${encodeURIComponent(kind)}`,
    { method: 'DELETE' },
    'disconnect the tool',
    'Could not disconnect the tool',
  );
}

export async function createMeeting(input: CreateMeetingInput): Promise<MeetingCreated> {
  const response = await request(
    '/api/meetings',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    'create the meeting',
    'Could not create the meeting',
  );
  const body = await readJson(response);
  if (body === null || typeof body.id !== 'string' || typeof body.link !== 'string') {
    throw new ProductApiError('Could not create the meeting. The server sent no meeting.', 502);
  }
  return { id: body.id, link: body.link };
}

export async function tellKaki(text: string): Promise<{ title: string | null; agenda: AgendaPayload[] }> {
  const response = await request(
    '/api/tell-kaki',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    },
    'ask Kaki to draft the agenda',
    'Could not ask Kaki to draft the agenda',
  );
  const body = await readJson(response);
  if (body === null || !Array.isArray(body.agenda)) {
    throw new ProductApiError('Could not ask Kaki to draft the agenda. The server sent no draft.', 502);
  }
  return {
    title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : null,
    agenda: body.agenda.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.title !== 'string' || record.title.trim() === '') return [];
      return [
        {
          title: record.title,
          ...(typeof record.minutes === 'number' ? { minutes: record.minutes } : {}),
        },
      ];
    }),
  };
}

export async function agendaFromCalendar(): Promise<{ title: string; agenda: AgendaPayload[] }> {
  const response = await request(
    '/api/agenda/from-calendar',
    { method: 'POST' },
    'read your calendar',
    'Could not read your calendar',
  );
  const body = await readJson(response);
  if (body === null || typeof body.title !== 'string' || !Array.isArray(body.agenda)) {
    throw new ProductApiError('Could not read your calendar. The server sent no invite.', 502);
  }
  return {
    title: body.title,
    agenda: body.agenda.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.title !== 'string' || record.title.trim() === '') return [];
      return [
        {
          title: record.title,
          ...(typeof record.minutes === 'number' ? { minutes: record.minutes } : {}),
        },
      ];
    }),
  };
}

export async function getMeetingInfo(id: string): Promise<MeetingInfo> {
  const response = await request(
    `/api/meetings/${encodeURIComponent(id)}/info`,
    {},
    'load this meeting',
    'Could not load this meeting',
  );
  const body = await readJson(response);
  if (body === null || typeof body.title !== 'string') {
    throw new ProductApiError('Could not load this meeting. The server sent no meeting.', 502);
  }
  return {
    title: body.title,
    workspaceName: typeof body.workspaceName === 'string' ? body.workspaceName : null,
    scheduledFor: typeof body.scheduledFor === 'string' ? body.scheduledFor : null,
    status: typeof body.status === 'string' ? body.status : 'open',
    ownerName: typeof body.ownerName === 'string' ? body.ownerName : null,
  };
}

export async function joinMeeting(id: string, name?: string): Promise<{ name: string }> {
  const response = await request(
    `/api/meetings/${encodeURIComponent(id)}/join`,
    {
      method: 'POST',
      ...(name === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
    },
    'join this meeting',
    'Could not join this meeting',
  );
  const body = await readJson(response);
  return { name: typeof body?.name === 'string' ? body.name : (name ?? '') };
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' }, 'sign out', 'Could not sign out');
}


function historyItemFrom(value: unknown): MeetingHistoryItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') return undefined;
  return {
    id: record.id,
    title: record.title,
    date: typeof record.date === 'string' ? record.date : '',
    status: typeof record.status === 'string' ? record.status : 'ended',
  };
}

function archivedTodoFrom(value: unknown): ArchivedTodo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') return undefined;
  return {
    id: record.id,
    title: record.title,
    owner: typeof record.owner === 'string' ? record.owner : '',
    status: typeof record.status === 'string' ? record.status : '',
    done: record.done === true,
  };
}

export async function listMeetingHistory(workspaceId: string): Promise<MeetingHistoryItem[]> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/meetings`,
    {},
    'load the past meetings',
    'Could not load the past meetings',
  );
  const body = await readJsonArray(response);
  if (body === null) {
    throw new ProductApiError('Could not load the past meetings. The server sent no list.', 502);
  }
  return body.map(historyItemFrom).filter((item): item is MeetingHistoryItem => item !== undefined);
}

export async function getMeetingMinutes(
  workspaceId: string,
  meetingId: string,
): Promise<MeetingMinutes> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(meetingId)}/minutes`,
    {},
    'load these minutes',
    'Could not load these minutes',
  );
  const body = await readJson(response);
  if (body === null || typeof body.id !== 'string' || typeof body.title !== 'string') {
    throw new ProductApiError('Could not load these minutes. The server sent no meeting.', 502);
  }
  return {
    id: body.id,
    title: body.title,
    date: typeof body.date === 'string' ? body.date : '',
    minutes: typeof body.minutes === 'string' ? body.minutes : null,
    todos: Array.isArray(body.todos)
      ? body.todos.flatMap((entry) => {
          const todo = archivedTodoFrom(entry);
          return todo === undefined ? [] : [todo];
        })
      : [],
    canEdit: body.canEdit === true,
  };
}

export async function setMeetingTodoDone(
  workspaceId: string,
  meetingId: string,
  taskId: string,
  done: boolean,
): Promise<ArchivedTodo[]> {
  const response = await request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(meetingId)}/todos/${encodeURIComponent(taskId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done }),
    },
    'save the to-do',
    'Could not save the to-do',
  );
  const body = await readJson(response);
  if (body === null || !Array.isArray(body.todos)) {
    throw new ProductApiError('Could not save the to-do. The server sent no to-do list.', 502);
  }
  return body.todos.flatMap((entry) => {
    const todo = archivedTodoFrom(entry);
    return todo === undefined ? [] : [todo];
  });
}
