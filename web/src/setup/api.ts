import type { MeetingSetup, SetupFieldError } from '@kaki/shared';

export interface SetupResponse {
  setup: MeetingSetup;
  started: boolean;
}

export interface ToolStatus {
  kind: string;
  label: string;
  configured: boolean;
  missing: string[];
}

export interface ToolProbeResult {
  ok: boolean;
  detail?: string;
  problem?: string;
  message?: string;
}

export class SetupApiError extends Error {
  readonly status: number;
  readonly fieldErrors: SetupFieldError[];

  constructor(message: string, status: number, fieldErrors: SetupFieldError[] = []) {
    super(message);
    this.name = 'SetupApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
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

function fieldErrors(value: unknown): SetupFieldError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.field === 'string' && typeof record.message === 'string'
      ? [{ field: record.field, message: record.message }]
      : [];
  });
}

async function failure(response: Response, fallback: string): Promise<SetupApiError> {
  const body = await readJson(response);
  const message = typeof body?.error === 'string' ? body.error : `${fallback} (HTTP ${response.status})`;
  return new SetupApiError(message, response.status, fieldErrors(body?.errors));
}

function networkFailure(subject: string): SetupApiError {
  return new SetupApiError(`Could not reach the server to ${subject}.`, 0);
}

function parseSetupResponse(body: Record<string, unknown> | null, fallback: string): SetupResponse {
  if (typeof body?.setup !== 'object' || body.setup === null) {
    throw new SetupApiError(`${fallback} The server sent no setup.`, 502);
  }
  return { setup: body.setup as MeetingSetup, started: body.started === true };
}

export async function loadSetup(): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetch('/api/setup');
  } catch {
    throw networkFailure('load the setup');
  }
  if (!response.ok) throw await failure(response, 'Could not load the setup');
  return parseSetupResponse(await readJson(response), 'Could not load the setup.');
}

export async function importKopitiamDemo(): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetch('/api/setup/import-calendar', { method: 'POST' });
  } catch {
    throw networkFailure('load the Kopitiam demo');
  }
  if (!response.ok) throw await failure(response, 'Could not load the Kopitiam demo');
  return parseSetupResponse(await readJson(response), 'Could not load the Kopitiam demo.');
}

export async function saveSetup(setup: MeetingSetup): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetch('/api/setup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setup),
    });
  } catch {
    throw networkFailure('save the setup');
  }
  if (!response.ok) throw await failure(response, 'Could not save the setup');
  return parseSetupResponse(await readJson(response), 'Could not save the setup.');
}

export async function loadTools(): Promise<ToolStatus[]> {
  let response: Response;
  try {
    response = await fetch('/api/setup/tools');
  } catch {
    throw networkFailure('check the tools');
  }
  if (!response.ok) throw await failure(response, 'Could not check the tools');
  const body = await readJson(response);
  if (!Array.isArray(body?.tools)) {
    throw new SetupApiError('Could not check the tools. The server sent no tool list.', 502);
  }
  return body.tools as ToolStatus[];
}

export async function testTool(kind: string): Promise<ToolProbeResult> {
  let response: Response;
  try {
    response = await fetch(`/api/setup/tools/${encodeURIComponent(kind)}/test`, { method: 'POST' });
  } catch {
    throw networkFailure('test the connection');
  }
  if (!response.ok) throw await failure(response, 'Could not test the connection');
  const body = await readJson(response);
  if (body === null || typeof body.ok !== 'boolean') {
    throw new SetupApiError('Could not test the connection. The server sent no result.', 502);
  }
  return {
    ok: body.ok,
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
    ...(typeof body.problem === 'string' ? { problem: body.problem } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}
