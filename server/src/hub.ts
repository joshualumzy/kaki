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
import type { Principal } from './access';

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

/** The result of checking whether a socket may connect; the principal is the same one HTTP uses. */
export type UpgradeDecision =
  | {
      ok: true;
      participant?: boolean;
      principal?: Principal;
      sessionTokenHash?: string;
      runner?: boolean;
    }
  | { ok: false; message: string };

/** One socket message may not exceed this: the clients send small commands, not uploads. */
const MAX_PAYLOAD_BYTES = 1_000_000;

/** Options for the hub; auth plugs into the WebSocket upgrade through `authorize`. */
export interface HubOptions {
  authorize?(request: IncomingMessage, audience: ClientAudience): Promise<UpgradeDecision>;
  /** True when a person currently holds this role, so the runner's token may not act as it. */
  isHumanSeat?(role: string): boolean;
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
  /** Revoke a gone meeting's phone sessions: bump the authorization generation and close their feeds. */
  endRoleSessions?(reason: string): void;
  /** Close every socket authorized by one session that has been replaced or signed out. */
  endSession?(sessionTokenHash: string): void;
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
  const isHumanSeat = options.isHumanSeat ?? (() => false);
  /** The roles an AI profile currently voices; Start narrows this to the sealed AI seats. */
  const aiVoiceRoles = (): Set<string> => {
    const profiles = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
    return new Set(
      scenario.attendees.filter((attendee) => profiles.has(attendee.name)).map((attendee) => attendee.role),
    );
  };
  /**
   * The runner may drive the screen command subset and the AI seats it voices, never a human
   * seat. A person currently in the seat wins over the profile, so a leaked token cannot approve
   * that person's outside actions.
   */
  const runnerMayUseAudience = (audience: ClientAudience): boolean => {
    if (audience === 'screen' || audience === 'service') return true;
    if (audience === 'lifecycle') return false;
    return aiVoiceRoles().has(audience) && !isHumanSeat(audience);
  };
  const verified = authorize === undefined;
  /** Bumped whenever a meeting's code rotates, so upgrades authorized under the old code cannot register. */
  let revocationGeneration = 0;
  /** Sessions retired while a socket was still authorizing, so its upgrade cannot register afterwards. */
  const revokedSessions = new Set<string>();
  /** How each pending upgrade was authorized, kept until its socket registers. */
  const pendingAuthorizations = new WeakMap<
    IncomingMessage,
    { generation: number; participant: boolean; sessionTokenHash?: string; runner: boolean }
  >();
  const wss = new WebSocketServer(
    verified
      ? { server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES }
      : {
          server: httpServer,
          path: '/ws',
          maxPayload: MAX_PAYLOAD_BYTES,
          verifyClient: (info, done) => {
            const url = new URL(info.req.url ?? '/ws', 'http://localhost');
            const audience = audienceFor(scenario, url.searchParams.get('role'));
            if (audience === undefined) {
              done(false, 401, 'Unknown role');
              return;
            }
            if (authorize === undefined) {
              done(true);
              return;
            }
            const generation = revocationGeneration;
            void authorize(info.req, audience)
              .then((decision) => {
                if (decision.ok) {
                  pendingAuthorizations.set(info.req, {
                    generation,
                    participant: decision.participant === true || decision.principal?.kind === 'seat',
                    runner: decision.runner === true,
                    ...(decision.sessionTokenHash === undefined
                      ? {}
                      : { sessionTokenHash: decision.sessionTokenHash }),
                  });
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
  /** Sockets behind a participant's phone session, whatever audience they follow. */
  const participantSockets = new Set<WebSocket>();
  /** The session each person's socket was authorized by, so replacing it can close the socket. */
  const socketSessions = new Map<WebSocket, string>();

  function forgetSocket(socket: WebSocket): void {
    clients.delete(socket);
    serviceSockets.delete(socket);
    runnerSockets.delete(socket);
    participantSockets.delete(socket);
    socketSessions.delete(socket);
  }

  /** Drop every authority the socket had before starting the close handshake. */
  function revokeSocket(socket: WebSocket, code: number, reason: string): void {
    forgetSocket(socket);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

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
    // Revocation removes the socket from the client set synchronously, while the close handshake
    // may still allow frames to arrive; those frames must carry no authority.
    if (!clients.has(socket)) return;
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

    if (runnerSockets.has(socket)) {
      // The cast can change when Start seals the setup or a person takes the seat. Re-check the
      // runner's eligibility on every command and revoke the socket the moment it no longer holds.
      if (!runnerMayUseAudience(audience)) {
        console.warn(`kaki hub: closing the AI runner socket on ${audience}: it is no longer an AI-cast role`);
        socket.close(4008, 'The AI runner may not act as this role');
        return;
      }
      if (!runnerMaySend(audience, parsed.type)) {
        const reason = 'The AI runner may not send that command';
        console.warn(`kaki hub: refused ${parsed.type} from the AI runner on ${audience}: ${reason}`);
        sendTo(socket, audience, JSON.stringify(rejectionFor(audience, parsed.type, reason)));
        return;
      }
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

    const authorization = pendingAuthorizations.get(request);
    const seatAudience =
      audience !== 'screen' && audience !== 'service' && audience !== 'lifecycle';
    if (
      authorization !== undefined &&
      authorization.generation !== revocationGeneration &&
      (authorization.participant === true || (seatAudience && authorization.runner !== true))
    ) {
      // Authorized for the previous meeting's generation: the phone or seat grant is gone.
      socket.close(4001);
      return;
    }
    if (
      authorization?.sessionTokenHash !== undefined &&
      revokedSessions.has(authorization.sessionTokenHash)
    ) {
      // The session was retired after this upgrade authorized, so it must not register now.
      socket.close(4001);
      return;
    }

    clients.set(socket, audience);
    if (audience === 'service') serviceSockets.add(socket);
    else if (authorization?.runner === true) runnerSockets.add(socket);
    else if (authorization?.participant === true) participantSockets.add(socket);
    if (authorization?.sessionTokenHash !== undefined) {
      socketSessions.set(socket, authorization.sessionTokenHash);
    }
    sendRetained(socket, audience);
    socket.on('close', () => {
      forgetSocket(socket);
    });
    socket.on('error', (error) => {
      console.error(`kaki hub: socket error for ${audience}`, error);
      forgetSocket(socket);
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
    endRoleSessions(reason) {
      revocationGeneration += 1;
      for (const [socket, audience] of [...clients]) {
        if (audience === 'screen' || audience === 'service') continue;
        if (runnerSockets.has(socket)) continue;
        // A host's read-only lifecycle feed survives; a participant's must not follow the new meeting.
        if (audience === 'lifecycle' && !participantSockets.has(socket)) continue;
        const session = socketSessions.get(socket);
        if (session !== undefined) revokedSessions.add(session);
        revokeSocket(socket, 4001, reason);
      }
    },
    endSession(sessionTokenHash) {
      // Retired before the sockets close: a pending upgrade authorized by this session is refused.
      revokedSessions.add(sessionTokenHash);
      for (const [socket, session] of [...socketSessions]) {
        if (session === sessionTokenHash) revokeSocket(socket, 4001, 'Signed in again elsewhere');
      }
    },
    close() {
      for (const socket of clients.keys()) socket.terminate();
      clients.clear();
      serviceSockets.clear();
      runnerSockets.clear();
      participantSockets.clear();
      socketSessions.clear();
      revokedSessions.clear();
      serviceHandlers.clear();
      retained.clear();
      subscribers.clear();
      wss.close();
    },
  };
}
