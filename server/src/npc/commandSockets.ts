import type { KakiCommand, Role } from '@kaki/shared';
import { WebSocket } from 'ws';

/** The screen and each AI role each get their own command socket, exactly as a phone would. */
type CommandAudience = Role | 'screen';

/** A command waiting for a reconnect, tagged with the meeting it was sent in. */
interface QueuedCommand {
  message: string;
  meetingId: string | undefined;
}

interface Entry {
  socket: WebSocket | undefined;
  queue: QueuedCommand[];
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  closing: boolean;
}

/** The runner's command socket settings: where to connect, how to log, retry and fence queued commands. */
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
  /** A real meeting's registry id; its command sockets carry `meeting=<id>` (legacy omits it). */
  meetingId?: string;
}

interface CommandSockets {
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
 * Command sockets for the runner's own writes (task Accept/Approve, agenda, host mode).
 * A socket that goes down is reopened with bounded, backed-off attempts and its queue is flushed in
 * order; the queue is capped so a long outage cannot grow without limit. Queued commands are fenced
 * to the meeting they were sent in, so a reconnect never replays an old meeting's command into the
 * next one. Pause is not among the runner's writes: a person's Stop/Resume goes straight to the
 * server from their browser.
 */
export function createCommandSockets(options: CommandSocketsOptions): CommandSockets {
  const { baseUrl, token, log, logError } = options;
  const maxQueue = options.maxQueue ?? 100;
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectDelay = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const currentMeetingId = options.currentMeetingId ?? (() => undefined);
  const meetingQuery =
    options.meetingId === undefined || options.meetingId === ''
      ? ''
      : `&meeting=${encodeURIComponent(options.meetingId)}`;
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
        closing: false,
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

  /** Drop queued commands that belong to another meeting. */
  function dropQueuedForOtherMeetings(entry: Entry, role: CommandAudience): void {
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
    dropQueuedForOtherMeetings(entry, role);
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
      const count = dropped.length;
      logError(
        `could not reconnect the ${role} command socket after ${entry.attempts} attempts; ` +
          `dropped ${count} queued command${count === 1 ? '' : 's'}` +
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
    const socket = createSocket(`${wsBase}/ws?role=${encodeURIComponent(role)}${meetingQuery}`, socketOptions);
    entry.socket = socket;
    socket.on('open', () => {
      if (entry.socket !== socket || entry.closing) return;
      entry.attempts = 0;
      flush(entry, role);
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
        if (entry.queue.length === 0) continue;
        const types = [...new Set(entry.queue.map((queued) => commandType(queued.message)))];
        logError(`the meeting was reset: dropped ${entry.queue.length} unsent ${role} command(s) (${types.join(', ')})`);
        entry.queue.length = 0;
      }
    },
    dropStale() {
      for (const [role, entry] of entries) dropQueuedForOtherMeetings(entry, role);
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
