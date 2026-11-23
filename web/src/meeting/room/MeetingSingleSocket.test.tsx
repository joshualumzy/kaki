/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

const scenario: Scenario = {
  id: 'meeting-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [{ id: 'operations_director', label: 'Producer' }],
  attendees: [{ name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' }],
  agenda: [],
  npcs: [
    { attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host', playable: true },
  ],
};

vi.mock('../../kaki/ScenarioContext', () => ({
  useScenario: () => scenario,
  useRefreshScenario: () => async () => scenario,
}));
vi.mock('../../auth/useMe', () => ({
  useMe: () => ({ status: 'ready', me: { authEnabled: false } }),
}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRoomContext: () => ({
    disconnect: vi.fn().mockResolvedValue(undefined),
    localParticipant: { identity: 'visitor-1', publishData: vi.fn() },
    state: 'connected',
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  }),
}));
// The stage and dock are mocked, but each still follows its real feeds through useKaki.
vi.mock('./MeetingGrid', async () => {
  const { useKaki } = await import('../../kaki');
  return {
    MeetingGrid: function Grid() {
      useKaki({ kind: 'role', role: 'operations_director' });
      useKaki({ kind: 'screen' });
      return null;
    },
  };
});
vi.mock('./Dock', async () => {
  const { useKaki } = await import('../../kaki');
  return {
    Dock: function DockView() {
      useKaki({ kind: 'role', role: 'operations_director' });
      useKaki({ kind: 'screen' });
      return null;
    },
  };
});

interface FakeSocketInstance {
  emit(type: string, event?: unknown): void;
  close(): void;
  readonly url: string;
}

const sockets = vi.hoisted(() => [] as FakeSocketInstance[]);

class FakeWebSocket {
  static OPEN = 1;

  readyState = FakeWebSocket.OPEN;

  readonly sent: string[] = [];

  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(data?: string): void {
    if (data !== undefined) this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

let Meeting: typeof import('./Meeting').default;

beforeEach(async () => {
  vi.resetModules();
  sockets.splice(0);
  window.sessionStorage.clear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/meeting/state')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ meetingId: 'meeting-a', started: false }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: 'token',
          url: 'ws://localhost:7880',
          meetingCode: 'ABCD',
          role: 'operations_director',
          started: false,
        }),
      };
    }),
  );
  Meeting = (await import('./Meeting')).default;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the meeting page', () => {
  it('opens exactly one Kaki socket for all of its parts', async () => {
    render(<Meeting />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Wei Ling' } });
    fireEvent.click(screen.getByRole('button', { name: /join with mic/i }));

    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 4_000 });
    const socket = sockets[0]!;
    expect(socket.url).toContain('audiences=screen');
    expect(socket.url).toContain('audiences=role%3Aoperations_director');

    // A reconnect replaces that one socket, never stacking a new one per consumer.
    act(() => socket.close());
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 4_000 });
    expect(sockets[1]!.url).toBe(socket.url);
  });
});
