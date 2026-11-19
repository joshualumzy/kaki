import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  isKakiCommand,
  isKakiEvent,
  isRoleIn,
  type KakiCommand,
  type KakiEvent,
  type Role,
  type Scenario,
} from '@kaki/shared';

/**
 * Who a socket belongs to: the shared screen, one role's phone, the AI runner's authenticated service
 * channel, or a read-only lifecycle feed any signed-in person may follow.
 */
export type ClientAudience = 'screen' | Role | 'service' | 'lifecycle';

/** A server-owned request asking the AI runner to prepare the meeting before Start commits. */
export interface RunnerStartRequest {
  /** Unique for this Start attempt; the runner echoes it back with the meeting id. */
  requestId: string;
  /** The same id as `requestId`, carried under the name the Start protocol uses. */
  attempt: string;
  /** The meeting this attempt belongs to; an acknowledgement for any other meeting is ignored. */
  meetingId: string;
  startedAt: string;
  agendaIndex: number;
  /** True when this is a saved meeting being resumed after a restart, not a fresh opening. */
  resumed: boolean;
}

/** A message the AI runner sends back over the service channel. */
export type ServiceMessage =
  | { kind: 'ready'; requestId: string; attempt: string; meetingId: string }
  | { kind: 'failed'; requestId: string; attempt: string; meetingId: string; reason?: string };

/** A command failure whose message is safe to show the sending client. */
export class CommandError extends Error {}

/** A server-owned handler for commands sent by clients. */
export type CommandHandler = (command: KakiCommand, sender: ClientAudience) => void | Promise<void>;

/** The result of checking whether a socket may connect. */
export type UpgradeDecision = { ok: true } | { ok: false; message: string };

/** Options for the hub; auth plugs into the WebSocket upgrade through `authorize`. */
export interface HubOptions {
  authorize?(request: IncomingMessage, audience: ClientAudience): Promise<UpgradeDecision>;
  /** Shared secret the AI runner presents on the service channel; required when auth is on. */
  serviceToken?: string;
}

/** Options for publishing an event to the hub. */
export interface PublishOptions {
  retainKey?: string;
}

/** The meeting hub: routes events to their audience and collects client commands. */
export interface Hub {
  /** Validate an event, deliver it to its audience, and notify in-process subscribers. */
  publish(event: KakiEvent, options?: PublishOptions): void;
  /** Listen to every published event; returns an unsubscribe function. */
  subscribe(handler: (event: KakiEvent) => void): () => void;
  /** Add a handler for validated client commands; every handler sees every command and ignores the ones it does not own. */
  onCommand(handler: CommandHandler): void;
  /** Ask every connected AI runner to open the meeting; false when no runner is connected. */
  requestStart?(request: RunnerStartRequest): boolean;
  /** Listen for readiness and failure messages from the AI runner. */
  onServiceMessage?(handler: (message: ServiceMessage) => void): void;
  /** Forget retained events whose key starts with `prefix`, so clients that connect later do not get them. */
  clearRetained(prefix: string): void;
  /** Close the WebSocket server and drop every client. */
  close(): void;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return data.toString('utf8');
}

function audienceFor(scenario: Scenario, rawRole: string | null): ClientAudience | undefined {
  if (rawRole === 'screen') return 'screen';
  if (rawRole === 'service') return 'service';
  if (rawRole === 'lifecycle') return 'lifecycle';
  return isRoleIn(scenario, rawRole) ? rawRole : undefined;
}

function wantsEvent(event: KakiEvent, audience: ClientAudience): boolean {
  // A lifecycle feed is read-only and only carries the meeting's start/reset/restore state.
  if (audience === 'lifecycle') {
    return event.type === 'MEETING_STARTED' || event.type === 'MEETING_RESET' || event.type === 'MEETING_RESTORED';
  }
  return (
    event.audience.kind === 'all' ||
    (event.audience.kind === 'screen' && (audience === 'screen' || audience === 'service')) ||
    (event.audience.kind === 'role' && (audience === event.audience.role || (audience === 'screen' && event.type === 'FACT_FOUND')))
  );
}

/** The service token a runner presented, from its Authorization header or the socket URL. */
function presentedServiceToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    return value === '' ? undefined : value;
  }
  const url = new URL(request.url ?? '/ws', 'http://localhost');
  const value = url.searchParams.get('token')?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const given = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseServiceMessage(value: unknown): ServiceMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as {
    kind?: unknown;
    requestId?: unknown;
    attempt?: unknown;
    meetingId?: unknown;
    reason?: unknown;
  };
  if (!nonEmptyString(message.requestId) || !nonEmptyString(message.attempt) || !nonEmptyString(message.meetingId)) {
    return undefined;
  }
  if (message.kind === 'ready') {
    return { kind: 'ready', requestId: message.requestId, attempt: message.attempt, meetingId: message.meetingId };
  }
  if (message.kind === 'failed') {
    return {
      kind: 'failed',
      requestId: message.requestId,
      attempt: message.attempt,
      meetingId: message.meetingId,
      ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
    };
  }
  return undefined;
}

/**
 * The commands the AI runner may send on its authenticated command sockets. It acts for the screen
 * to advance/end/pause and for its own roles to accept or approve a task, and nothing else.
 */
const RUNNER_SCREEN_COMMANDS = new Set(['NEXT_AGENDA_ITEM', 'END_MEETING', 'SET_PAUSED', 'SET_HOST_MODE']);
const RUNNER_ROLE_COMMANDS = new Set(['CLAIM_TASK', 'DECLINE_TASK', 'APPROVE_ACTION', 'RETRY_ACTION']);

function runnerMaySend(audience: ClientAudience, commandType: string): boolean {
  if (audience === 'screen') return RUNNER_SCREEN_COMMANDS.has(commandType);
  if (audience === 'service' || audience === 'lifecycle') return false;
  return RUNNER_ROLE_COMMANDS.has(commandType);
}

function rejectionFor(audience: ClientAudience, commandType: string, reason: string): KakiEvent {
  return {
    type: 'COMMAND_REJECTED',
    audience: audience === 'screen' ? { kind: 'screen' } : { kind: 'role', role: audience },
    payload: { commandType, reason },
  };
}

/** Create the `/ws` hub attached to an existing HTTP server for one scenario. */
export function createHub(httpServer: Server, scenario: Scenario, options: HubOptions = {}): Hub {
  const authorize = options.authorize;
  const serviceToken = options.serviceToken?.trim();
  const serviceTokenConfigured = serviceToken !== undefined && serviceToken !== '';
  /** True when a socket presents the AI runner's own token, on any audience. */
  const isRunnerRequest = (request: IncomingMessage): boolean =>
    serviceTokenConfigured && tokenMatches(presentedServiceToken(request), serviceToken ?? '');
  const verified = authorize === undefined && !serviceTokenConfigured;
  const wss = new WebSocketServer(
    verified
      ? { server: httpServer, path: '/ws' }
      : {
          server: httpServer,
          path: '/ws',
          verifyClient: (info, done) => {
            const url = new URL(info.req.url ?? '/ws', 'http://localhost');
            const audience = audienceFor(scenario, url.searchParams.get('role'));
            if (audience === undefined) {
              done(false, 401, 'Unknown role');
              return;
            }
            if (audience === 'service') {
              if (!serviceTokenConfigured) {
                console.error('kaki hub: refused the AI runner service channel because no service token is configured');
                done(false, 401, 'Service token not configured');
                return;
              }
              if (!tokenMatches(presentedServiceToken(info.req), serviceToken ?? '')) {
                console.error('kaki hub: refused the AI runner service channel: wrong or missing service token');
                done(false, 401, 'Service sign-in required');
                return;
              }
              done(true);
              return;
            }
            // The runner also drives its own commands (agenda advance, end, pause, task answers)
            // as the screen or its AI roles; its token stands in for a person's session there.
            if (isRunnerRequest(info.req)) {
              done(true);
              return;
            }
            if (authorize === undefined) {
              done(true);
              return;
            }
            void authorize(info.req, audience)
              .then((decision) => {
                if (decision.ok) {
                  done(true);
                } else {
                  done(false, 401, decision.message);
                }
              })
              .catch((error: unknown) => {
                console.error('kaki hub: WebSocket authorization failed', error);
                done(false, 500, 'Authorization failed');
              });
          },
        },
  );
  // ws re-emits the HTTP server's errors here; without a listener a port clash crashes the process
  // instead of letting listen() in createApp reject.
  wss.on('error', (error) => console.error('kaki hub: server error', error));
  const clients = new Map<WebSocket, ClientAudience>();
  const subscribers = new Set<(event: KakiEvent) => void>();
  const retained = new Map<string, KakiEvent>();
  const commandHandlers: CommandHandler[] = [];
  const serviceHandlers = new Set<(message: ServiceMessage) => void>();
  const serviceSockets = new Set<WebSocket>();
  /** Command sockets opened with the AI runner's token instead of a person's session. */
  const runnerSockets = new Set<WebSocket>();

  function sendTo(socket: WebSocket, audience: ClientAudience, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(message, (error) => {
        if (error) console.error(`kaki hub: failed to send to ${audience}`, error);
      });
    } catch (error) {
      console.error(`kaki hub: failed to send to ${audience}`, error);
    }
  }

  function sendRetained(socket: WebSocket, audience: ClientAudience): void {
    for (const event of retained.values()) {
      if (wantsEvent(event, audience)) sendTo(socket, audience, JSON.stringify(event));
    }
  }

  async function handleClientMessage(
    socket: WebSocket,
    audience: ClientAudience,
    data: RawData,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      if (audience === 'service') {
        console.error('kaki hub: ignored a malformed message from the AI runner service channel');
        return;
      }
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, 'unknown', 'Invalid JSON')));
      return;
    }

    if (audience === 'service') {
      const message = parseServiceMessage(parsed);
      if (message === undefined) {
        console.error('kaki hub: ignored an invalid message from the AI runner service channel', parsed);
        return;
      }
      for (const handler of serviceHandlers) {
        try {
          handler(message);
        } catch (error) {
          console.error('kaki hub: a runner service handler failed', error);
        }
      }
      return;
    }

    // A lifecycle feed is read-only: it follows start/reset state and may never drive the meeting.
    if (audience === 'lifecycle') {
      console.warn('kaki hub: ignored a command from the read-only lifecycle feed');
      return;
    }

    if (!isKakiCommand(parsed, scenario)) {
      const rawType =
        typeof parsed === 'object' && parsed !== null && 'type' in parsed && typeof parsed.type === 'string'
          ? parsed.type
          : 'unknown';
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, rawType, 'Invalid command')));
      return;
    }

    if (runnerSockets.has(socket) && !runnerMaySend(audience, parsed.type)) {
      console.warn(`kaki hub: refused ${parsed.type} from the AI runner on ${audience}: not one of its commands`);
      sendTo(
        socket,
        audience,
        JSON.stringify(rejectionFor(audience, parsed.type, 'The AI runner may not send that command')),
      );
      return;
    }

    if (commandHandlers.length === 0) {
      sendTo(
        socket,
        audience,
        JSON.stringify(rejectionFor(audience, parsed.type, 'No command handler is registered')),
      );
      return;
    }

    try {
      for (const handler of commandHandlers) await handler(parsed, audience);
    } catch (error) {
      if (error instanceof CommandError) {
        sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, error.message)));
        return;
      }
      console.error(`kaki hub: command ${parsed.type} from ${audience} failed`, error);
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, 'internal error')));
    }
  }

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', 'http://localhost');
    const rawRole = url.searchParams.get('role');
    const audience = audienceFor(scenario, rawRole);

    if (audience === undefined) {
      const reason = rawRole === null ? 'Missing role' : 'Unknown role';
      socket.close(1008, reason);
      return;
    }

    clients.set(socket, audience);
    if (audience === 'service') serviceSockets.add(socket);
    else if (isRunnerRequest(request)) runnerSockets.add(socket);
    sendRetained(socket, audience);
    socket.on('close', () => {
      clients.delete(socket);
      serviceSockets.delete(socket);
      runnerSockets.delete(socket);
    });
    socket.on('error', (error) => {
      console.error(`kaki hub: socket error for ${audience}`, error);
      clients.delete(socket);
      serviceSockets.delete(socket);
      runnerSockets.delete(socket);
    });
    socket.on('message', (data) => {
      void handleClientMessage(socket, audience, data);
    });
  });

  return {
    publish(event, options = {}) {
      if (!isKakiEvent(event, scenario)) {
        throw new Error(`kaki hub: refusing to publish an invalid event: ${JSON.stringify(event)}`);
      }

      if (options.retainKey !== undefined) {
        retained.delete(options.retainKey);
        retained.set(options.retainKey, event);
      }

      const message = JSON.stringify(event);
      for (const [socket, audience] of clients) {
        if (wantsEvent(event, audience)) sendTo(socket, audience, message);
      }

      for (const handler of subscribers) {
        try {
          handler(event);
        } catch (error) {
          console.error('kaki hub: a subscriber failed', error);
        }
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    onCommand(handler) {
      commandHandlers.push(handler);
    },
    requestStart(request) {
      if (serviceSockets.size === 0) return false;
      const message = JSON.stringify({ kind: 'prepare', request });
      let sent = false;
      for (const socket of serviceSockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        sendTo(socket, 'service', message);
        sent = true;
      }
      return sent;
    },
    onServiceMessage(handler) {
      serviceHandlers.add(handler);
    },
    clearRetained(prefix) {
      for (const key of [...retained.keys()]) if (key.startsWith(prefix)) retained.delete(key);
    },
    close() {
      for (const socket of clients.keys()) socket.terminate();
      clients.clear();
      serviceSockets.clear();
      runnerSockets.clear();
      serviceHandlers.clear();
      retained.clear();
      subscribers.clear();
      wss.close();
    },
  };
}
