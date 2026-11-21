const REQUEST_TIMEOUT_MS = 20_000;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Fetch with the seed timeout, turning a transport failure into an error naming the target. */
export async function request(url: string, init: RequestInit = {}, label = url): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: request to ${url} failed: ${reason}`, { cause: error });
  }
}

/** Reads a JSON body, throwing with the status and response text when the call failed or the body is not JSON. */
export async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw new HttpError(`${label}: HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`, response.status, body);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(`${label}: response was not JSON: ${body.slice(0, 200)}`, { cause: error });
  }
}

/** Sends a request and decodes its JSON body, with the same failure rules as jsonResponse. */
export async function jsonRequest<T>(url: string, init: RequestInit, label: string): Promise<T> {
  return jsonResponse<T>(await request(url, init, label), label);
}

/** Builds a JSON request body for the given HTTP method. */
export function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Waits the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries an async check until it stops throwing or the timeout passes, then throws with the last error. */
export async function waitFor(
  label: string,
  check: () => Promise<void>,
  timeoutMs = 300_000,
  intervalMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'no detail');
  throw new Error(`${label}: not ready after ${Math.round(timeoutMs / 1000)}s (${reason})`);
}

/** The Authorization header value for HTTP basic auth. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** The Authorization header value for a bearer token. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}
