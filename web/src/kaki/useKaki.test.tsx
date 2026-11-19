/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ScenarioContext', () => {
  const scenario = {
    id: 'lifecycle-test',
    organisation: 'Test Kitchen',
    meetingTitle: 'Prep',
    roles: [{ id: 'chef', label: 'Chef' }],
    attendees: [{ name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' }],
    agenda: [{ title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' }],
  };
  return { useScenario: () => scenario };
});

interface FakeSocketInstance {
  emit(type: string, event?: unknown): void;
}

const sockets = vi.hoisted(() => [] as FakeSocketInstance[]);

class FakeWebSocket {
  static OPEN = 1;

  static readonly instances = sockets;

  readyState = FakeWebSocket.OPEN;

  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(): void {
    // The hook only sends from its send() helper, which these tests do not exercise.
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

function startEvent(meetingId = 'meeting-a'): { data: string } {
  return {
    data: JSON.stringify({
      type: 'MEETING_STARTED',
      audience: { kind: 'all' },
      payload: { meetingId, startedAt: '2026-11-19T09:00:00.000Z' },
    }),
  };
}

function resetEvent(meetingId = 'meeting-b'): { data: string } {
  return {
    data: JSON.stringify({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId } }),
  };
}

beforeEach(() => {
  sockets.splice(0);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useKaki lifecycle state', () => {
  it('keeps an explicit started flag after a reset clears the event list', async () => {
    // Import after the WebSocket stub is in place and the hook's module graph is fresh.
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki('chef'));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', startEvent()));
    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.events.some((event) => event.type === 'MEETING_STARTED')).toBe(true);
    expect(result.current.meetingId).toBe('meeting-a');

    act(() => socket.emit('message', resetEvent()));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(result.current.meetingId).toBe('meeting-b');
    // The reset clears the event list; the lifecycle flag is the state the browser can still read.
    expect(result.current.events).toEqual([]);
  });

  it('reads the authoritative lifecycle state when a lifecycle feed connects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki('lifecycle'));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/meeting/state');
  });

  it('discards a state answer from a socket that has been replaced', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki('lifecycle'));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    // The first socket closes before its answer arrives; the hook reconnects on its own.
    act(() => first.emit('close'));
    await waitFor(() => expect(sockets[1]).toBeDefined());
    const second = sockets[1]!;
    act(() => second.emit('open'));

    await act(async () => {
      answers[1]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-new', started: false }),
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.started).toBe(false));

    await act(async () => {
      answers[0]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-old', started: true }),
      });
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The closed socket's old answer must not reopen Start after the reset.
    expect(result.current.started).toBe(false);
  });

  it('stops reconnecting and reports the ended meeting after a failed reconnect', async () => {
    const ended = 'This meeting has ended; scan the new code.';
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: ended, authEnabled: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki('chef'));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    act(() => first.emit('close', { code: 1006 }));
    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const failed = sockets[1]!;

    // The reconnect was refused before it opened: the phone must ask whether its meeting is gone.
    act(() => failed.emit('close', { code: 1006 }));
    await waitFor(() => expect(result.current.ended).toBe(ended));

    const count = sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(sockets.length).toBe(count);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', undefined);
  });

});
