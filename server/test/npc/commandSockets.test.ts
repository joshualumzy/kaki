import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { createCommandSockets, type CommandSocketsOptions } from '../../src/npc/commandSockets';

type Listener = (...args: any[]) => void;

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('the socket is not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from(''));
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  fail(message = 'connect failed'): void {
    this.readyState = 3;
    this.emit('error', new Error(message));
    this.emit('close', 1006, Buffer.from(''));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<CommandSocketsOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const socketsApi = createCommandSockets({
    baseUrl: 'http://127.0.0.1:3001',
    token: 'runner-secret',
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    reconnectDelayMs: () => 0,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    ...overrides,
  });
  return { socketsApi, sockets, errors, logs };
}

describe('the runner command sockets', () => {
  it('reopens a socket that fails before opening and delivers queued commands in order', async () => {
    const { socketsApi, sockets, errors } = setup();

    socketsApi.sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
    socketsApi.sendAs('screen', { type: 'END_MEETING' });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([]);

    sockets[0]!.fail();
    await tick();

    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }),
      JSON.stringify({ type: 'END_MEETING' }),
    ]);
    expect(errors.some((message) => message.includes('could not send as screen'))).toBe(true);
  });

  it('gives up loudly after the reconnect bound and names the dropped commands', async () => {
    const { socketsApi, sockets, errors } = setup({ maxReconnectAttempts: 2 });

    socketsApi.sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
    expect(sockets).toHaveLength(1);

    sockets[0]!.fail();
    await tick();
    expect(sockets).toHaveLength(2);

    sockets[1]!.fail();
    await tick();
    expect(sockets).toHaveLength(2);

    const loud = errors.find((message) => message.includes('could not reconnect'));
    expect(loud).toBeDefined();
    expect(loud).toContain('dropped 1 queued command');
    expect(loud).toContain('NEXT_AGENDA_ITEM');
  });

  it('re-sends the latest host mode and paused state after a screen reconnect', async () => {
    const { socketsApi, sockets } = setup();

    socketsApi.sendAs('screen', { type: 'SET_HOST_MODE', human: false });
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'SET_HOST_MODE', human: false }),
      JSON.stringify({ type: 'SET_PAUSED', paused: true }),
    ]);

    socketsApi.sendAs('screen', { type: 'SET_HOST_MODE', human: true });
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: false });
    expect(sockets[0]!.sent).toHaveLength(4);

    sockets[0]!.fail();
    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      JSON.stringify({ type: 'SET_HOST_MODE', human: true }),
      JSON.stringify({ type: 'SET_PAUSED', paused: false }),
    ]);
  });

  it('drops the oldest command with a loud log when the queue is full', () => {
    const { socketsApi, errors } = setup({ maxQueue: 1 });

    socketsApi.sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
    socketsApi.sendAs('screen', { type: 'END_MEETING' });

    expect(
      errors.some(
        (message) => message.includes('command queue is full') && message.includes('NEXT_AGENDA_ITEM'),
      ),
    ).toBe(true);
  });

  it('drops unsent commands when the meeting resets, so they never reach the next meeting', async () => {
    const { socketsApi, sockets, errors } = setup();
    socketsApi.sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
    sockets[0]!.fail();
    await tick();

    socketsApi.dropQueued();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
    expect(errors.some((message) => message.includes('dropped 1 unsent screen command(s) (NEXT_AGENDA_ITEM)'))).toBe(true);
  });

  it('closes its sockets on shutdown', () => {
    const { socketsApi, sockets } = setup();
    socketsApi.sendAs('cashier', { type: 'MARK_DONE', taskId: 't-1' });
    expect(sockets[0]!.readyState).toBe(0);

    socketsApi.close();
    expect(sockets[0]!.readyState).toBe(3);
  });
});
