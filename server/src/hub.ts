import type { Server } from 'node:http';
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
  /** Set the single handler that receives validated client commands. */
  onCommand(handler: CommandHandler): void;
  /** Close the WebSocket server and drop every client. */
  close(): void;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return data.toString('utf8');
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
export function createHub(httpServer: Server, scenario: Scenario): Hub {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Map<WebSocket, ClientAudience>();
  const subscribers = new Set<(event: KakiEvent) => void>();
  const retained = new Map<string, KakiEvent>();
  let commandHandler: CommandHandler | undefined;

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

    if (commandHandler === undefined) {
      sendTo(
        socket,
        audience,
        JSON.stringify(rejectionFor(audience, parsed.type, 'No command handler is registered')),
      );
      return;
    }

    try {
      await commandHandler(parsed, audience);
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
    const audience: ClientAudience | undefined =
      rawRole === 'screen' ? 'screen' : isRoleIn(scenario, rawRole) ? rawRole : undefined;

    if (audience === undefined) {
      const reason = rawRole === null ? 'Missing role' : `Unknown role: ${rawRole.slice(0, 80)}`;
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
      commandHandler = handler;
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
