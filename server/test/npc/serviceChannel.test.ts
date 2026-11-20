import { Agent, createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createServiceChannel,
  createServiceDispatch,
  isReplayedCue,
  reconnectDelayMs,
} from '../../src/npc/serviceChannel';

type Listener = (...args: any[]) => void;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeServiceSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }

  terminate(): void {
    this.close();
  }

  reject(status: number): void {
    this.readyState = 3;
    this.emit(
      'unexpected-response',
      { destroy: () => undefined },
      { statusCode: status, destroy: () => undefined },
    );
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe('replayed retained cues', () => {
  it('drops a retained host cue but dispatches a real one right after it', () => {
    const seen: string[] = [];
    const handle = createServiceDispatch({
      dispatch: (event) => seen.push((event as { payload: { text: string } }).payload.text),
      logError: () => undefined,
      ignore: isReplayedCue,
    });

    handle(
      JSON.stringify({
        type: 'HOST_SPEECH_TRIGGERED',
        audience: { kind: 'screen' },
        payload: { kind: 'OPENING', text: 'An old welcome' },
        replayed: true,
      }),
    );
    handle(
      JSON.stringify({
        type: 'HOST_SPEECH_TRIGGERED',
        audience: { kind: 'screen' },
        payload: { kind: 'OPENING', text: 'A live welcome' },
      }),
    );

    expect(seen).toEqual(['A live welcome']);
  });
});

describe('the service-channel dispatch', () => {
  it('logs a throwing handler with the event type and keeps dispatching later messages', () => {
    const errors: string[] = [];
    const seen: string[] = [];
    const responder = {
      handle: () => {
        throw new Error('the responder exploded');
      },
    };
    const handle = createServiceDispatch({
      dispatch: (event) => {
        const type = (event as { type: string }).type;
        seen.push(type);
        if (type === 'TASK_UPDATED') responder.handle();
      },
      logError: (message) => errors.push(message),
    });

    handle(JSON.stringify({ type: 'TASK_UPDATED' }));
    handle(JSON.stringify({ type: 'MEETING_RESET' }));

    expect(seen).toEqual(['TASK_UPDATED', 'MEETING_RESET']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TASK_UPDATED');
    expect(errors[0]).toContain('the responder exploded');
  });

  it('logs malformed JSON instead of throwing', () => {
    const errors: string[] = [];
    const handle = createServiceDispatch({
      dispatch: () => {
        throw new Error('must not run');
      },
      logError: (message) => errors.push(message),
    });

    expect(() => handle('{ not json')).not.toThrow();
    expect(errors[0]).toContain('not JSON');
    expect(errors[0]).toContain('{ not json');
  });
});

describe('the service channel reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off exponentially up to a cap', () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
    expect(reconnectDelayMs(5)).toBe(10_000);
    expect(reconnectDelayMs(6)).toBe(10_000);
    expect(reconnectDelayMs(20)).toBe(10_000);
  });

  it('retries with backoff and reports a rejected token once per token', () => {
    vi.useFakeTimers();
    const sockets: FakeServiceSocket[] = [];
    const errors: string[] = [];
    const channel = createServiceChannel({
      token: 'bad-token',
      createSocket: () => {
        const socket = new FakeServiceSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onOpen: () => undefined,
      log: () => undefined,
      logError: (message) => errors.push(message),
    });

    channel.start();
    expect(sockets).toHaveLength(1);

    sockets[0]!.reject(401);
    expect(errors.filter((message) => message.includes('service token rejected'))).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.reject(401);
    expect(errors.filter((message) => message.includes('service token rejected'))).toHaveLength(1);

    channel.stop();
  });

  it('closes every rejected handshake instead of leaving connections open', async () => {
    const connections = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => connections.delete(socket));
      // An upgraded socket is raw, so a client FIN only half-closes it; finish it so the test
      // can see the connection actually go away.
      socket.on('end', () => socket.destroy());
    });
    server.on('upgrade', (_request, socket) => {
      // Answer with 401 but keep the connection open: a client that only drains the response
      // and forgets the request leaves a connection here that stop() cannot reach.
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    let attempts = 0;
    const channel = createServiceChannel({
      token: 'bad-token',
      createSocket: () => {
        attempts += 1;
        return new WebSocket(`ws://127.0.0.1:${port}/ws?role=service`, {
          agent: new Agent({ keepAlive: true }),
        });
      },
      onOpen: () => undefined,
      log: () => undefined,
      logError: () => undefined,
      baseDelayMs: 5,
      maxDelayMs: 5,
    });

    try {
      channel.start();
      await waitFor(() => attempts >= 3);
      channel.stop();
      await waitFor(() => connections.size === 0);
      expect(connections.size).toBe(0);
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
