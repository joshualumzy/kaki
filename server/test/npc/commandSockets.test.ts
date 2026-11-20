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

  it('does not replay host-mode or pause state after a screen reconnect', async () => {
    const { socketsApi, sockets } = setup();
    socketsApi.sendAs('screen', { type: 'SET_HOST_MODE', human: false });
    sockets[0]!.open();

    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'SET_HOST_MODE', human: false }),
      JSON.stringify({ type: 'SET_PAUSED', paused: true }),
    ]);

    sockets[0]!.fail();
    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([]);
  });

  it('does not replay an earlier pause after the server has resumed the meeting', async () => {
    const { socketsApi, sockets } = setup();

    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'SET_PAUSED', paused: true })]);

    // The screen command resumed the meeting; the runner's snapshot already resumed local playback.
    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
  });

  it('keeps only the latest pause intent while the socket is down', async () => {
    const { socketsApi, sockets, logs } = setup();

    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: false });
    expect(logs.some((line) => line.includes('replaced the unsent SET_PAUSED'))).toBe(true);

    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: 'SET_PAUSED', paused: false })]);
  });

  it('drops a Stop queued before a server restart, even when the screen reconnects first', async () => {
    let version = { epoch: { startedAt: 1_000, id: 'old-server' }, seq: 4 };
    const { socketsApi, sockets, errors } = setup({
      currentMeetingId: () => 'meeting-1',
      currentVersion: () => version,
    });

    // The person pressed Stop while the screen was down, against the old server incarnation.
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    sockets[0]!.fail();
    await tick();

    // The server restarted (new epoch, same meeting). The screen socket reconnects before the
    // service channel has adopted the new snapshot; the old Stop must still be dropped.
    version = { epoch: { startedAt: 2_000, id: 'new-server' }, seq: 1 };
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
    expect(
      errors.some(
        (message) => message.includes('older server epoch') && message.includes('SET_PAUSED'),
      ),
    ).toBe(true);
  });

  it('drops an unsent pause when a newer server snapshot owns the state (crash restore)', async () => {
    const { socketsApi, sockets, errors } = setup();

    // The screen was down when the person pressed Stop; the server then restored the meeting alive.
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    socketsApi.dropStateIntents();

    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
    expect(errors.some((message) => message.includes('dropped the unsent SET_PAUSED screen intent'))).toBe(true);
  });

  it('does not replay a Stop after the screen resumed while the socket was down', async () => {
    const { socketsApi, sockets } = setup();

    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    // The screen's Resume changed the server snapshot, which supersedes the unsent Stop.
    socketsApi.dropStateIntents();

    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
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

  it('drops a queued command from an earlier meeting instead of sending it into the current one', async () => {
    let meetingId: string | undefined = 'meeting-a';
    const { socketsApi, sockets, errors } = setup({ currentMeetingId: () => meetingId });

    socketsApi.sendAs('screen', { type: 'END_MEETING' });
    sockets[0]!.fail();
    await tick();

    meetingId = 'meeting-b';
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
    expect(
      errors.some(
        (message) => message.includes('from another meeting') && message.includes('END_MEETING'),
      ),
    ).toBe(true);
  });

  it('drops only the old meeting queue when a service reconnect reveals the meeting changed', async () => {
    let meetingId: string | undefined = 'meeting-a';
    const { socketsApi, sockets } = setup({ currentMeetingId: () => meetingId });

    socketsApi.sendAs('screen', { type: 'END_MEETING' });
    sockets[0]!.fail();
    await tick();

    meetingId = 'meeting-b';
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: false });
    socketsApi.dropStale();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: 'SET_PAUSED', paused: false })]);
  });

  it('does not replay screen state cached in another meeting after a reset', async () => {
    let meetingId: string | undefined = 'meeting-a';
    const { socketsApi, sockets } = setup({ currentMeetingId: () => meetingId });

    socketsApi.sendAs('screen', { type: 'SET_HOST_MODE', human: false });
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    sockets[0]!.open();

    socketsApi.dropQueued();
    meetingId = 'meeting-b';
    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
  });

  it('does not replay screen state set in another meeting even without a reset', async () => {
    let meetingId: string | undefined = 'meeting-a';
    const { socketsApi, sockets } = setup({ currentMeetingId: () => meetingId });

    socketsApi.sendAs('screen', { type: 'SET_HOST_MODE', human: true });
    socketsApi.sendAs('screen', { type: 'SET_PAUSED', paused: true });
    sockets[0]!.open();

    meetingId = 'meeting-b';
    sockets[0]!.fail();
    await tick();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
  });

  it('waits for a pending reconnect instead of opening a socket for every new command', async () => {
    const { socketsApi, sockets } = setup({ reconnectDelayMs: () => 20 });

    socketsApi.sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
    expect(sockets).toHaveLength(1);
    sockets[0]!.fail();
    expect(sockets).toHaveLength(1);

    socketsApi.sendAs('screen', { type: 'END_MEETING' });
    expect(sockets).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }),
      JSON.stringify({ type: 'END_MEETING' }),
    ]);
  });

  it('closes its sockets on shutdown', () => {
    const { socketsApi, sockets } = setup();
    socketsApi.sendAs('cashier', { type: 'MARK_DONE', taskId: 't-1' });
    expect(sockets[0]!.readyState).toBe(0);

    socketsApi.close();
    expect(sockets[0]!.readyState).toBe(3);
  });
});
