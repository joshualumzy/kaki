import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  createServiceChannel,
  createServiceDispatch,
  reconnectDelayMs,
} from '../../src/npc/serviceChannel';

type Listener = (...args: any[]) => void;

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

  reject(status: number): void {
    this.readyState = 3;
    this.emit('unexpected-response', {}, { statusCode: status, resume: () => undefined });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

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
});
