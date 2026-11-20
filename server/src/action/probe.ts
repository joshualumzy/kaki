import { plainReason } from './runner';

type ToolProblem = 'not configured' | 'auth failed' | 'unreachable' | 'timeout' | 'unexpected response';

interface ToolProbeSuccess {
  ok: true;
  detail: string;
}

interface ToolProbeFailure {
  ok: false;
  problem: ToolProblem;
  message: string;
}

export type ToolProbeResult = ToolProbeSuccess | ToolProbeFailure;

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export function probeOk(detail: string): ToolProbeSuccess {
  return { ok: true, detail };
}

export function probeFailed(problem: ToolProblem, message: string): ToolProbeFailure {
  return { ok: false, problem, message };
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function wasTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

type ProbeFetchOutcome =
  | { ok: true; response: Response }
  | { ok: false; result: ToolProbeFailure };

export async function probeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  subject: string,
  timeoutMs: number,
): Promise<ProbeFetchOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return { ok: true, response: await fetchImpl(url, { ...init, signal: timeout }) };
  } catch (error) {
    return {
      ok: false,
      result: wasTimeout(error, timeout)
        ? probeFailed('timeout', `${subject} did not answer within ${timeoutMs} ms. Check that it is running and try again.`)
        : probeFailed('unreachable', plainReason(error, subject)),
    };
  }
}

export function responseProblem(response: Response, subject: string): ToolProbeFailure {
  if (isAuthFailure(response.status)) {
    return probeFailed('auth failed', `${subject} rejected the saved credentials (HTTP ${response.status}).`);
  }
  return probeFailed(
    'unexpected response',
    `${subject} returned HTTP ${response.status}. Check that the server is running and its saved settings are correct.`,
  );
}
