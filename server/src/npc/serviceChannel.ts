import { WebSocket } from 'ws';

/** Exponential reconnect delay, capped so an outage never hammers the server. */
export function reconnectDelayMs(attempt: number, baseMs = 1_000, maxMs = 10_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt - 1, 16)));
}

function describeEvent(event: unknown): string {
  if (typeof event !== 'object' || event === null) return 'unknown';
  const candidate = event as { kind?: unknown; type?: unknown };
  if (typeof candidate.kind === 'string') return candidate.kind;
  if (typeof candidate.type === 'string') return candidate.type;
  return 'unknown';
}

function statusFromMessage(message: string): number | undefined {
  const match = /\b(401|403)\b/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/** A retained event carries `replayed: true`; an old host cue must never be spoken again. */
export function isReplayedCue(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as { type?: unknown; replayed?: unknown };
  return candidate.replayed === true && candidate.type === 'HOST_SPEECH_TRIGGERED';
}

interface ServiceDispatchOptions {
  dispatch(event: unknown): void;
  logError(message: string): void;
  describe?(event: unknown): string;
  /** Drop an event before dispatch (for example a retained cue that is history, not news). */
  ignore?(event: unknown): boolean;
}

/**
 * Parse one service-channel message and run its handler.
 * Unparseable messages are logged once with a short preview, and a throwing handler is logged with
 * the event type so a lost cue is never silent; the next message still dispatches normally.
 */
export function createServiceDispatch({
  dispatch,
  logError,
  describe = describeEvent,
  ignore,
}: ServiceDispatchOptions): (raw: unknown) => void {
  return (raw) => {
    const text = typeof raw === 'string' ? raw : String(raw);
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      logError(`ignored a service message that was not JSON: ${preview === '' ? '(empty)' : preview}`);
      return;
    }
    if (ignore?.(event) === true) return;
    try {
      dispatch(event);
    } catch (error) {
      logError(`the ${describe(event)} service event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

interface ServiceChannelOptions {
  token?: string | undefined;
  /** Injected by tests; production opens a real WebSocket. */
  createSocket(): WebSocket;
  /** Wire message handling for each newly opened socket. */
  onOpen(socket: WebSocket): void;
  log(message: string): void;
  logError(message: string): void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface ServiceChannel {
  start(): void;
  stop(): void;
}

/**
 * The runner's authenticated service channel, kept open with exponential backoff.
 * A rejected token is reported once per token value with a clear error rather than every 3 seconds.
 */
export function createServiceChannel(options: ServiceChannelOptions): ServiceChannel {
  const { token, createSocket, onOpen, log, logError } = options;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const tokenKey = token ?? '';
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;
  let rejectedForToken: string | undefined;

  function reportRejected(status: number): void {
    if (rejectedForToken !== tokenKey) {
      rejectedForToken = tokenKey;
      logError(`the AI service channel failed: service token rejected (HTTP ${status}); fix KAKI_SERVICE_TOKEN and it will retry with backoff`);
      return;
    }
    log(`the AI service channel is still rejected (HTTP ${status}); retrying with backoff`);
  }

  function schedule(): void {
    if (stopped || timer !== undefined) return;
    const delay = reconnectDelayMs(attempts, baseDelayMs, maxDelayMs);
    log(`the AI service channel is reconnecting in ${delay} ms`);
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, delay);
    timer.unref?.();
  }

  function connect(): void {
    if (stopped) return;
    attempts += 1;
    const current = createSocket();
    socket = current;
    current.on('open', () => {
      if (socket !== current || stopped) return;
      attempts = 0;
      log('the AI service channel is connected');
      onOpen(current);
    });
    current.on('unexpected-response', (request, response) => {
      // ws only aborts the handshake itself when no listener handles this event, so a listener
      // that just drains the body leaves the rejected connection open and outside stop()'s reach.
      // Destroy the request/response and terminate the still-connecting socket here instead.
      const status = response.statusCode ?? 0;
      const active = socket === current && !stopped;
      if (active) socket = undefined;
      request.destroy();
      response.destroy();
      current.terminate();
      if (!active) return;
      if (status === 401 || status === 403) reportRejected(status);
      else logError(`the AI service channel was refused (HTTP ${status})`);
      schedule();
    });
    current.on('error', (error) => {
      if (socket !== current) return;
      const status = statusFromMessage(error.message);
      if (status !== undefined) reportRejected(status);
      else logError(`the AI service channel failed: ${error.message}`);
      socket = undefined;
      schedule();
    });
    current.on('close', (code, reason) => {
      if (socket !== current) return;
      socket = undefined;
      if (stopped) return;
      logError(`the AI service channel closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''})`);
      schedule();
    });
  }

  return {
    start() {
      if (stopped || socket !== undefined || timer !== undefined) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const current = socket;
      socket = undefined;
      current?.close();
    },
  };
}
