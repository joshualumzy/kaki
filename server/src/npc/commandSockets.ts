import type { KakiCommand, Role } from '@kaki/shared';
import { WebSocket } from 'ws';

/** The screen and each AI role each get their own command socket, exactly as a phone would. */
type CommandAudience = Role | 'screen';

interface Entry {
  socket: WebSocket | undefined;
  queue: string[];
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  opened: boolean;
  closing: boolean;
  lastHostMode: boolean | undefined;
  lastPaused: boolean | undefined;
}

export interface CommandSocketsOptions {
  baseUrl: string;
  token?: string | undefined;
  log(message: string): void;
  logError(message: string): void;
  /** Injected by tests; production opens a real WebSocket. */
  createSocket?: (url: string, options: { headers: Record<string, string> } | undefined) => WebSocket;
  /** How many queued commands one socket may hold before the oldest is dropped. */
  maxQueue?: number;
  /** How many connection attempts a socket gets before the queued commands are given up on. */
  maxReconnectAttempts?: number;
  reconnectDelayMs?(attempt: number): number;
}

export interface CommandSockets {
  sendAs(role: CommandAudience, command: KakiCommand): void;
  /** Forget commands still waiting for a reconnect: they belong to a meeting that was reset. */
  dropQueued(): void;
  close(): void;
}

/** Short backoff between reconnects; a live demo should recover quickly. */
function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(2_000, 100 * 2 ** Math.max(0, attempt - 1));
}

function commandType(message: string): string {
  try {
    const parsed = JSON.parse(message) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Command sockets for the runner's own writes (task Accept/Approve, agenda, pause, host mode).
 * A socket that goes down is reopened with bounded, backed-off attempts and its queue is flushed in
 * order; the queue is capped so a long outage cannot grow without limit. The screen also gets the
 * latest host-mode and paused state after every reconnect, because those are state, not one-off cues.
 */
export function createCommandSockets(options: CommandSocketsOptions): CommandSockets {
  const { baseUrl, token, log, logError } = options;
  const maxQueue = options.maxQueue ?? 100;
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectDelay = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const createSocket =
    options.createSocket ?? ((url, init) => new WebSocket(url, init));
  const socketOptions =
    token === undefined || token === ''
      ? undefined
      : { headers: { authorization: `Bearer ${token}` } };
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const entries = new Map<CommandAudience, Entry>();

  function entryFor(role: CommandAudience): Entry {
    let entry = entries.get(role);
    if (entry === undefined) {
      entry = {
        socket: undefined,
        queue: [],
        attempts: 0,
        timer: undefined,
        opened: false,
        closing: false,
        lastHostMode: undefined,
        lastPaused: undefined,
      };
      entries.set(role, entry);
    }
    return entry;
  }

  function sendMessage(entry: Entry, role: CommandAudience, message: string): void {
    if (entry.socket === undefined || entry.socket.readyState !== WebSocket.OPEN) {
      enqueue(entry, role, message);
      return;
    }
    try {
      entry.socket.send(message);
    } catch (error) {
      logError(`could not send as ${role}: ${String(error)}; queueing the command for the reconnect`);
      enqueue(entry, role, message);
      down(entry, role);
    }
  }

  function enqueue(entry: Entry, role: CommandAudience, message: string): void {
    if (entry.queue.length >= maxQueue) {
      const dropped = entry.queue.shift();
      if (dropped !== undefined) {
        logError(`the ${role} command queue is full (${maxQueue}); dropped the oldest command (${commandType(dropped)})`);
      }
    }
    entry.queue.push(message);
  }

  function flush(entry: Entry, role: CommandAudience): void {
    while (entry.queue.length > 0) {
      const socket = entry.socket;
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
      const message = entry.queue[0]!;
      try {
        socket.send(message);
      } catch (error) {
        logError(`could not flush the ${role} command queue: ${String(error)}`);
        down(entry, role);
        return;
      }
      entry.queue.shift();
    }
  }

  function down(entry: Entry, role: CommandAudience): void {
    entry.socket = undefined;
    if (entry.closing) return;
    if (entry.attempts >= maxAttempts) {
      const dropped = entry.queue.splice(0);
      const types = [...new Set(dropped.map(commandType))];
      logError(
        `could not reconnect the ${role} command socket after ${entry.attempts} attempts; ` +
          `dropped ${dropped.length} queued command${dropped.length === 1 ? '' : 's'}` +
          `${types.length === 0 ? '' : ` (${types.join(', ')})`}`,
      );
      entry.attempts = 0;
      return;
    }
    if (entry.timer !== undefined) return;
    const delay = reconnectDelay(entry.attempts);
    log(`the ${role} command socket is reconnecting in ${delay} ms`);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      connect(entry, role);
    }, delay);
    entry.timer.unref?.();
  }

  function connect(entry: Entry, role: CommandAudience): void {
    if (entry.closing || entry.socket !== undefined) return;
    entry.attempts += 1;
    const socket = createSocket(`${wsBase}/ws?role=${encodeURIComponent(role)}`, socketOptions);
    entry.socket = socket;
    socket.on('open', () => {
      if (entry.socket !== socket || entry.closing) return;
      entry.attempts = 0;
      const reconnected = entry.opened;
      entry.opened = true;
      flush(entry, role);
      if (role === 'screen' && reconnected) {
        if (entry.lastHostMode !== undefined) {
          sendMessage(entry, role, JSON.stringify({ type: 'SET_HOST_MODE', human: entry.lastHostMode }));
        }
        if (entry.lastPaused !== undefined) {
          sendMessage(entry, role, JSON.stringify({ type: 'SET_PAUSED', paused: entry.lastPaused }));
        }
      }
    });
    socket.on('error', (error) => {
      if (entry.socket !== socket) return;
      logError(`could not send as ${role}: ${error.message}`);
      down(entry, role);
    });
    socket.on('close', () => {
      if (entry.socket !== socket) return;
      down(entry, role);
    });
  }

  return {
    sendAs(role, command) {
      const entry = entryFor(role);
      if (role === 'screen') {
        if (command.type === 'SET_HOST_MODE') entry.lastHostMode = command.human;
        if (command.type === 'SET_PAUSED') entry.lastPaused = command.paused;
      }
      const message = JSON.stringify(command);
      if (entry.closing) {
        logError(`not sending ${command.type} as ${role}: the command sockets are closed`);
        return;
      }
      if (entry.socket !== undefined && entry.socket.readyState === WebSocket.OPEN) {
        sendMessage(entry, role, message);
        return;
      }
      enqueue(entry, role, message);
      if (entry.socket === undefined) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        connect(entry, role);
      }
    },
    dropQueued() {
      for (const [role, entry] of entries) {
        if (entry.queue.length === 0) continue;
        const types = [...new Set(entry.queue.map(commandType))];
        logError(`the meeting was reset: dropped ${entry.queue.length} unsent ${role} command(s) (${types.join(', ')})`);
        entry.queue.length = 0;
      }
    },
    close() {
      for (const entry of entries.values()) {
        entry.closing = true;
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        entry.queue.length = 0;
        const socket = entry.socket;
        entry.socket = undefined;
        socket?.close();
      }
    },
  };
}
