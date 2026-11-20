import { sameRunnerEpoch, type KakiCommand, type Role, type RunnerSnapshotVersion } from '@kaki/shared';
import { WebSocket } from 'ws';

/** The screen and each AI role each get their own command socket, exactly as a phone would. */
type CommandAudience = Role | 'screen';

/** A command waiting for a reconnect, tagged with the meeting it was sent in. */
interface QueuedCommand {
  message: string;
  meetingId: string | undefined;
}

/** A pause or host-mode report: the latest intent only, never a queue of stale state. */
interface StateIntent {
  message: string;
  meetingId: string | undefined;
  type: string;
  /** The server snapshot the person acted against, so a restart cannot replay it into a new epoch. */
  version: RunnerSnapshotVersion | undefined;
}

interface Entry {
  socket: WebSocket | undefined;
  queue: QueuedCommand[];
  intent: StateIntent | undefined;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  closing: boolean;
}

/** Commands that report state the server owns; only the latest matters and a snapshot supersedes it. */
const STATE_COMMANDS = new Set(['SET_PAUSED', 'SET_HOST_MODE']);

function isStateCommand(type: string): boolean {
  return STATE_COMMANDS.has(type);
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
  /** The snapshot version the runner holds, so a state intent from another epoch is never replayed. */
  currentVersion?(): RunnerSnapshotVersion | undefined;
}

export interface CommandSockets {
  sendAs(role: CommandAudience, command: KakiCommand): void;
  /** Forget commands still waiting for a reconnect: they belong to a meeting that was reset. */
  dropQueued(): void;
  /** Forget queued commands whose meeting is not the runner's current meeting. */
  dropStale(): void;
  /**
   * Forget unsettled pause/host-mode intents: a newer server snapshot now owns that state, so
   * replaying an old intent after a reconnect would overrule it.
   */
  dropStateIntents(): void;
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
 * order; the queue is capped so a long outage cannot grow without limit. State is never replayed on
 * reconnect: host mode and pause belong to the server, and a stale pause would freeze the meeting.
 */
export function createCommandSockets(options: CommandSocketsOptions): CommandSockets {
  const { baseUrl, token, log, logError } = options;
  const maxQueue = options.maxQueue ?? 100;
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectDelay = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const currentMeetingId = options.currentMeetingId ?? (() => undefined);
  const currentVersion = options.currentVersion ?? (() => undefined);
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
        intent: undefined,
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

  /** Drop queued commands and an intent that belong to another meeting or server epoch. */
  function dropStaleFor(entry: Entry, role: CommandAudience): void {
    const current = currentMeetingId();
    if (entry.intent !== undefined) {
      if (entry.intent.meetingId !== current) {
        logError(
          `dropped the unsent ${entry.intent.type} ${role} intent from another meeting; ` +
            `the runner is now in ${current ?? 'no meeting'}`,
        );
        entry.intent = undefined;
      } else {
        const held = currentVersion();
        if (
          entry.intent.version !== undefined &&
          held !== undefined &&
          !sameRunnerEpoch(entry.intent.version.epoch, held.epoch)
        ) {
          // The server restarted while this intent waited. Replaying it would write a Stop made
          // against the old incarnation into the new one before its snapshot is even read.
          logError(
            `dropped the unsent ${entry.intent.type} ${role} intent from an older server epoch; ` +
              `the runner now holds ${held.epoch.id}`,
          );
          entry.intent = undefined;
        }
      }
    }
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
    if (entry.intent !== undefined) {
      const socket = entry.socket;
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
      const intent = entry.intent;
      try {
        socket.send(intent.message);
      } catch (error) {
        logError(`could not flush the ${role} ${intent.type} intent: ${String(error)}`);
        down(entry, role);
        return;
      }
      entry.intent = undefined;
    }
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
      let count = dropped.length;
      if (entry.intent !== undefined) {
        count += 1;
        types.push(entry.intent.type);
        entry.intent = undefined;
      }
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
    const socket = createSocket(`${wsBase}/ws?role=${encodeURIComponent(role)}`, socketOptions);
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
      if (isStateCommand(command.type)) {
        // State is not a cue. Keep only the latest intent; a newer snapshot drops it instead of
        // replaying an old pause into a meeting the server has since changed.
        if (entry.socket !== undefined && entry.socket.readyState === WebSocket.OPEN) {
          try {
            entry.socket.send(message);
            return;
          } catch (error) {
            logError(`could not send ${command.type} as ${role}: ${String(error)}; keeping one intent for the reconnect`);
            down(entry, role);
          }
        }
        if (entry.intent !== undefined && entry.intent.message !== message) {
          log(`replaced the unsent ${entry.intent.type} ${role} intent with a newer one`);
        }
        entry.intent = { message, meetingId, type: command.type, version: currentVersion() };
        if (entry.socket === undefined && entry.timer === undefined) connect(entry, role);
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
        if (entry.intent !== undefined) {
          logError(`the meeting was reset: dropped the unsent ${entry.intent.type} ${role} intent`);
          entry.intent = undefined;
        }
        if (entry.queue.length === 0) continue;
        const types = [...new Set(entry.queue.map((queued) => commandType(queued.message)))];
        logError(`the meeting was reset: dropped ${entry.queue.length} unsent ${role} command(s) (${types.join(', ')})`);
        entry.queue.length = 0;
      }
    },
    dropStale() {
      for (const [role, entry] of entries) dropStaleFor(entry, role);
    },
    dropStateIntents() {
      for (const [role, entry] of entries) {
        if (entry.intent === undefined) continue;
        logError(
          `dropped the unsent ${entry.intent.type} ${role} intent; ` +
            'a newer server snapshot now owns that state',
        );
        entry.intent = undefined;
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
        entry.intent = undefined;
        const socket = entry.socket;
        entry.socket = undefined;
        socket?.close();
      }
    },
  };
}
