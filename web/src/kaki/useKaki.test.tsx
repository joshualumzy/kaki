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

function startEvent(): { data: string } {
  return {
    data: JSON.stringify({
      type: 'MEETING_STARTED',
      audience: { kind: 'all' },
      payload: { startedAt: '2026-11-19T09:00:00.000Z' },
    }),
  };
}

function resetEvent(): { data: string } {
  return {
    data: JSON.stringify({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: {} }),
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

    act(() => socket.emit('message', resetEvent()));
    await waitFor(() => expect(result.current.started).toBe(false));
    // The reset clears the event list; the lifecycle flag is the state the browser can still read.
    expect(result.current.events).toEqual([]);
  });

  it('reads the authoritative lifecycle state when a lifecycle feed connects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ started: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki('lifecycle'));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/meeting/state');
  });
});
