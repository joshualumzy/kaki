import type { MeetingSetup, SetupFieldError } from '@kaki/shared';
import { invalidateScenario } from '../kaki/scenarioRevision';
import { fetchWithTimeout } from '../net/withTimeout';

/** The setup and whether the meeting is already started, as the setup endpoints return it. */
export interface SetupResponse {
  setup: MeetingSetup;
  started: boolean;
  kind?: 'real' | 'practice';
}

/** One action tool's configuration state and the settings it is missing. */
export interface ToolStatus {
  kind: string;
  label: string;
  configured: boolean;
  missing: string[];
}

/** The outcome of testing a tool connection, with a human detail or problem message. */
export interface ToolProbeResult {
  ok: boolean;
  detail?: string;
  problem?: string;
  message?: string;
}

/** A setup request failure carrying the HTTP status and any field errors from the server. */
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
  return {
    setup: body.setup as MeetingSetup,
    started: body.started === true,
    ...(body.kind === 'real' || body.kind === 'practice' ? { kind: body.kind } : {}),
  };
}

/** Loads the saved setup and meeting state, throwing SetupApiError when the server refuses. */
export async function loadSetup(): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/setup');
  } catch {
    throw networkFailure('load the setup');
  }
  if (!response.ok) throw await failure(response, 'Could not load the setup');
  return parseSetupResponse(await readJson(response), 'Could not load the setup.');
}

/** Loads the Kopitiam demo into the setup and refreshes the cached scenario. */
export async function importKopitiamDemo(): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/setup/import-calendar', { method: 'POST' });
  } catch {
    throw networkFailure('load the Kopitiam demo');
  }
  if (!response.ok) throw await failure(response, 'Could not load the Kopitiam demo');
  const result = parseSetupResponse(await readJson(response), 'Could not load the Kopitiam demo.');
  invalidateScenario();
  return result;
}

/** Saves the edited setup, refreshes the cached scenario and returns the saved state. */
export async function saveSetup(setup: MeetingSetup): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/setup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(setup),
    });
  } catch {
    throw networkFailure('save the setup');
  }
  if (!response.ok) throw await failure(response, 'Could not save the setup');
  const result = parseSetupResponse(await readJson(response), 'Could not save the setup.');
  invalidateScenario();
  return result;
}

/** Starts a blank meeting from the server's empty setup. */
export async function startBlankSetup(): Promise<SetupResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/setup/blank', { method: 'POST' });
  } catch {
    throw networkFailure('start a blank meeting');
  }
  if (!response.ok) throw await failure(response, 'Could not start a blank meeting');
  const result = parseSetupResponse(await readJson(response), 'Could not start a blank meeting.');
  invalidateScenario();
  return result;
}

/** Lists each action tool and whether its settings are complete. */
export async function loadTools(): Promise<ToolStatus[]> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/setup/tools');
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

/** Tests one action tool's connection and returns the probe result. */
export async function testTool(kind: string): Promise<ToolProbeResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`/api/setup/tools/${encodeURIComponent(kind)}/test`, { method: 'POST' });
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

/** What the owner's "Open the meeting room" got back when it failed. */
export class OpenMeetingError extends SetupApiError {
  readonly practiceInProgress: boolean;

  constructor(message: string, status: number, practiceInProgress = false) {
    super(message, status);
    this.name = 'OpenMeetingError';
    this.practiceInProgress = practiceInProgress;
  }
}

/** Ask the server to open the team meeting from the saved draft. */
export async function openMeeting(): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/meeting/open', { method: 'POST' }, 12_000);
  } catch (error) {
    throw new SetupApiError(
      error instanceof Error ? error.message : 'Could not reach the server to open the meeting.',
      0,
    );
  }
  if (response.ok) {
    invalidateScenario();
    return;
  }
  const body = await readJson(response);
  throw new OpenMeetingError(
    typeof body?.error === 'string' ? body.error : `Could not open the meeting (HTTP ${response.status}).`,
    response.status,
    body?.practiceInProgress === true,
  );
}

/** Close a team-meeting room that never started, releasing the server for practice. */
export async function closeMeetingRoom(): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/meeting/close', { method: 'POST' }, 12_000);
  } catch (error) {
    throw new SetupApiError(
      error instanceof Error ? error.message : 'Could not reach the server to close the meeting room.',
      0,
    );
  }
  if (!response.ok) throw await failure(response, 'Could not close the meeting room');
  invalidateScenario();
}

/** End a practice meeting so the team meeting can be opened. */
export async function endPracticeMeeting(): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout('/api/meeting/end-practice', { method: 'POST' }, 12_000);
  } catch (error) {
    throw new SetupApiError(
      error instanceof Error ? error.message : 'Could not reach the server to end the practice meeting.',
      0,
    );
  }
  if (!response.ok) throw await failure(response, 'Could not end the practice meeting');
  invalidateScenario();
}
