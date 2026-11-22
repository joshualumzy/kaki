/** The server did not answer before the caller's deadline. */
export class TimeoutError extends Error {
  constructor(message = 'The server did not answer in time. Check your connection, then try again.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * fetch with a deadline. A page must never wait on a request that may never answer; the caller gets a
 * plain TimeoutError it can show and offer a retry for. An abort from the caller is passed through.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const callerSignal = init.signal;
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new TimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
