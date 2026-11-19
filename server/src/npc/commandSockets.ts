import type { KakiCommand, Role } from '@kaki/shared';
import { WebSocket } from 'ws';

/** The screen and each AI role each get their own command socket, exactly as a phone would. */
type CommandAudience = Role | 'screen';

/** A command waiting for a reconnect, tagged with the meeting it was sent in. */
interface QueuedCommand {
  message: string;
  meetingId: string | undefined;
}

/** The latest value of a stateful screen cue, tagged with the meeting that set it. */
interface CachedState<T> {
  value: T;
  meetingId: string | undefined;
}

interface Entry {
  socket: WebSocket | undefined;
  queue: QueuedCommand[];
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  opened: boolean;
  closing: boolean;
  lastHostMode: CachedState<boolean> | undefined;
  lastPaused: CachedState<boolean> | undefined;
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
  /** The meeting the runner is in now, used to fence queued commands from older meetings. */
  currentMeetingId?(): string | undefined;
}

export interface CommandSockets {
  sendAs(role: CommandAudience, command: KakiCommand): void;
  /** Forget commands still waiting for a reconnect: they belong to a meeting that was reset. */
  dropQueued(): void;
  /** Forget queued commands whose meeting is not the runner's current meeting. */
  dropStale(): void;
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
  const currentMeetingId = options.currentMeetingId ?? (() => undefined);
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

  function sendMessage(
    entry: Entry,
    role: CommandAudience,
    message: string,
    meetingId: string | undefined,
  ): void {
    if (entry.socket === undefined || entry.socket.readyState !== WebSocket.OPEN) {
      enqueue(entry, role, message, meetingId);
      return;
    }
    try {
      entry.socket.send(message);
    } catch (error) {
      logError(`could not send as ${role}: ${String(error)}; queueing the command for the reconnect`);
      enqueue(entry, role, message, meetingId);
      down(entry, role);
    }
  }

  function enqueue(
    entry: Entry,
    role: CommandAudience,
    message: string,
    meetingId: string | undefined,
  ): void {
    if (entry.queue.length >= maxQueue) {
      const dropped = entry.queue.shift();
      if (dropped !== undefined) {
        logError(
          `the ${role} command queue is full (${maxQueue}); ` +
            `dropped the oldest command (${commandType(dropped.message)})`,
        );
      }
    }
    entry.queue.push({ message, meetingId });
  }

  /** Drop queued commands that belong to a meeting other than the runner's current one. */
  function dropStaleFor(entry: Entry, role: CommandAudience): void {
    const current = currentMeetingId();
    const stale = entry.queue.filter((queued) => queued.meetingId !== current);
    if (stale.length === 0) return;
    entry.queue = entry.queue.filter((queued) => queued.meetingId === current);
    const types = [...new Set(stale.map((queued) => commandType(queued.message)))];
    logError(
      `dropped ${stale.length} queued ${role} command${stale.length === 1 ? '' : 's'} ` +
        `from another meeting (${types.join(', ')}); the runner is now in ${current ?? 'no meeting'}`,
    );
  }

  function flush(entry: Entry, role: CommandAudience): void {
    dropStaleFor(entry, role);
    while (entry.queue.length > 0) {
      const socket = entry.socket;
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
      const message = entry.queue[0]!.message;
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
      const types = [...new Set(dropped.map((queued) => commandType(queued.message)))];
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
        const current = currentMeetingId();
        if (entry.lastHostMode !== undefined && entry.lastHostMode.meetingId === current) {
          sendMessage(entry, role, JSON.stringify({ type: 'SET_HOST_MODE', human: entry.lastHostMode.value }), current);
        }
        if (entry.lastPaused !== undefined && entry.lastPaused.meetingId === current) {
          sendMessage(entry, role, JSON.stringify({ type: 'SET_PAUSED', paused: entry.lastPaused.value }), current);
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
      const meetingId = currentMeetingId();
      if (role === 'screen') {
        if (command.type === 'SET_HOST_MODE') entry.lastHostMode = { value: command.human, meetingId };
        if (command.type === 'SET_PAUSED') entry.lastPaused = { value: command.paused, meetingId };
      }
      const message = JSON.stringify(command);
      if (entry.closing) {
        logError(`not sending ${command.type} as ${role}: the command sockets are closed`);
        return;
      }
      if (entry.socket !== undefined && entry.socket.readyState === WebSocket.OPEN) {
        sendMessage(entry, role, message, meetingId);
        return;
      }
      enqueue(entry, role, message, meetingId);
      // While a reconnect is already scheduled, let its backoff run: a new command must not
      // cut in line and force an immediate attempt. After the give-up bound there is no timer,
      // so the next command may start a fresh attempt cycle.
      if (entry.socket === undefined && entry.timer === undefined) {
        connect(entry, role);
      }
    },
    dropQueued() {
      for (const [role, entry] of entries) {
        // A reset ends the meeting the cached screen state belonged to.
        entry.lastHostMode = undefined;
        entry.lastPaused = undefined;
        if (entry.queue.length === 0) continue;
        const types = [...new Set(entry.queue.map((queued) => commandType(queued.message)))];
        logError(`the meeting was reset: dropped ${entry.queue.length} unsent ${role} command(s) (${types.join(', ')})`);
        entry.queue.length = 0;
      }
    },
    dropStale() {
      for (const [role, entry] of entries) dropStaleFor(entry, role);
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
