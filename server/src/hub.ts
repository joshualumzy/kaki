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

/** Who a socket belongs to: the shared screen or one role's phone. */
export type ClientAudience = 'screen' | Role;

/** A command failure whose message is safe to show the sending client. */
export class CommandError extends Error {}

/** A server-owned handler for commands sent by clients. */
export type CommandHandler = (command: KakiCommand, sender: ClientAudience) => void | Promise<void>;

/** The result of checking whether a socket may connect. */
export type UpgradeDecision = { ok: true } | { ok: false; message: string };

/** Options for the hub; auth plugs into the WebSocket upgrade through `authorize`. */
export interface HubOptions {
  authorize?(request: IncomingMessage, audience: ClientAudience): Promise<UpgradeDecision>;
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
  return isRoleIn(scenario, rawRole) ? rawRole : undefined;
}

function wantsEvent(event: KakiEvent, audience: ClientAudience): boolean {
  return (
    event.audience.kind === 'all' ||
    (event.audience.kind === 'screen' && audience === 'screen') ||
    (event.audience.kind === 'role' && audience === event.audience.role)
  );
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
  const wss = new WebSocketServer(
    authorize === undefined
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
      sendTo(socket, audience, JSON.stringify(rejectionFor(audience, 'unknown', 'Invalid JSON')));
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
    sendRetained(socket, audience);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', (error) => {
      console.error(`kaki hub: socket error for ${audience}`, error);
      clients.delete(socket);
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
    clearRetained(prefix) {
      for (const key of [...retained.keys()]) if (key.startsWith(prefix)) retained.delete(key);
    },
    close() {
      for (const socket of clients.keys()) socket.terminate();
      clients.clear();
      retained.clear();
      subscribers.clear();
      wss.close();
    },
  };
}
