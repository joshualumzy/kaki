/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_TOPIC, NPC_STATE_TOPIC, type Scenario } from '@kaki/shared';

const mocks = vi.hoisted(() => ({ useScenario: vi.fn() }));

vi.mock('../kaki', () => ({ useScenario: mocks.useScenario }));

import { ConnectedStartPrompt, StartPrompt } from './StartPrompt';

const scenario: Scenario = {
  id: 'start-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [
    { id: 'producer', label: 'Operations Director' },
    { id: 'studio_manager', label: 'General Manager', facilitator: true },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' },
    { name: 'Sam', role: 'studio_manager', zoomDisplayName: 'Sam' },
  ],
  agenda: [],
  npcs: [
    { attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host', playable: true },
    { attendee: 'Arjun', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant', playable: true },
  ],
};

const room = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    handlers,
    localParticipant: { identity: 'visitor-1', publishData: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
    }),
  };
});

vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));

function emit(event: string, ...args: unknown[]): void {
  for (const handler of room.handlers.get(event) ?? []) handler(...args);
}

function sentStart(): { kind: string; requestId: string; session: string } {
  const payload = room.localParticipant.publishData.mock.calls.at(-1)![0] as Uint8Array;
  return JSON.parse(new TextDecoder().decode(payload));
}

function acknowledge(request: { requestId: string; session: string }, identity = 'Sam'): void {
  emit(
    'dataReceived',
    new TextEncoder().encode(JSON.stringify({ kind: 'started', requestId: request.requestId, session: request.session })),
    { identity },
    undefined,
    NPC_STATE_TOPIC,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  room.handlers.clear();
  room.on.mockClear();
  room.off.mockClear();
  room.localParticipant.publishData.mockReset();
  room.localParticipant.publishData.mockResolvedValue(undefined);
  mocks.useScenario.mockReset();
  mocks.useScenario.mockReturnValue(scenario);
});

function pressStart(): void {
  if (screen.queryByRole('button', { name: 'Start the meeting' }) === null) goToStart();
  fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
}

function goToStart(): void {
  fireEvent.click(screen.getByRole('button', { name: /Next: How to play/i }));
}

describe('StartPrompt', () => {
  it('lists today’s calls on the first screen', () => {
    mocks.useScenario.mockReturnValue({ ...scenario, agenda: [
      { title: 'Till login fix', minutes: 5, ownerRole: 'producer' },
      { title: 'Delivery promise', minutes: 5, ownerRole: 'producer' },
    ] });
    render(<StartPrompt onStart={vi.fn()} />);
    expect(screen.getByText(/Today’s 2 calls/)).toBeTruthy();
    expect(screen.getByText(/Till login fix/)).toBeTruthy();
    expect(screen.getByText(/10 minutes/)).toBeTruthy();
  });

  it('keeps Start off the first screen so the role is read before the meeting begins', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Start the meeting' })).toBeNull();
    expect(screen.getByText(/stay quiet until you start/)).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('teaches talking, Space or Esc to pause, and the Kaki panel on the second screen', () => {
    render(<StartPrompt onStart={vi.fn()} />);
    goToStart();
    expect(screen.getByText('Space')).toBeTruthy();
    expect(screen.getByText('Esc')).toBeTruthy();
    expect(screen.getByText(/Kaki panel/)).toBeTruthy();
  });

  it('starts the meeting when the button is pressed', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    pressStart();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('goes back to the role screen', () => {
    render(<StartPrompt onStart={vi.fn()} />);
    goToStart();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('button', { name: /Next: How to play/i })).toBeTruthy();
  });
});

describe('ConnectedStartPrompt', () => {
  it('retries with the same request and opens only after the matching acknowledgement', () => {
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    const request = sentStart();
    expect(request.kind).toBe('start');
    expect(request.session).toBe('visitor-1');
    expect(room.localParticipant.publishData.mock.calls.at(-1)![1]).toEqual({ reliable: true, topic: CONTROL_TOPIC });
    expect(screen.getByText(/waiting for the room to confirm/i)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    acknowledge({ ...request, requestId: 'someone-else' });
    acknowledge(request, 'visitor-1');
    acknowledge(request, 'Arjun');
    acknowledge({ ...request, session: 'visitor-2' });
    expect(onStarted).not.toHaveBeenCalled();

    acknowledge(request);
    expect(onStarted).toHaveBeenCalledTimes(1);
    acknowledge(request);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a recoverable message when the scenario is unavailable', () => {
    mocks.useScenario.mockReturnValue(undefined as never);
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    expect(screen.getByText(/not ready yet/i)).toBeTruthy();
    expect(room.localParticipant.publishData).not.toHaveBeenCalled();
    acknowledge({ requestId: 'req-1', session: 'visitor-1' }, 'Sam');
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('shows a recoverable failure when the transport rejects and the acknowledgement never comes', () => {
    vi.useFakeTimers();
    room.localParticipant.publishData.mockRejectedValue(new Error('transport down'));
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByText(/did not confirm the start/i)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    room.localParticipant.publishData.mockResolvedValue(undefined);
    pressStart();
    const request = sentStart();
    expect(screen.getByText(/waiting for the room to confirm/i)).toBeTruthy();
    act(() => acknowledge(request));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('queues Start when clicked while LiveKit is still connecting and sends it as soon as the room connects', () => {
    vi.useFakeTimers();
    const roomWithState = room as typeof room & { state?: string };
    roomWithState.state = 'connecting';
    room.localParticipant.identity = '';
    const onStarted = vi.fn();
    try {
      render(<ConnectedStartPrompt onStarted={onStarted} />);
      pressStart();
      expect(screen.getByText(/waiting for the room to confirm/i)).toBeTruthy();
      expect(room.localParticipant.publishData).not.toHaveBeenCalled();

      // Still connecting on the first retry tick: nothing sent yet.
      act(() => {
        vi.advanceTimersByTime(750);
      });
      expect(room.localParticipant.publishData).not.toHaveBeenCalled();

      // LiveKit finishes connecting and sets the participant identity.
      roomWithState.state = 'connected';
      room.localParticipant.identity = 'visitor-1';
      act(() => {
        emit('connected');
      });
      expect(room.localParticipant.publishData).toHaveBeenCalledTimes(1);
      const request = sentStart();
      expect(request.kind).toBe('start');
      expect(request.session).toBe('visitor-1');

      act(() => acknowledge(request));
      expect(onStarted).toHaveBeenCalledTimes(1);
    } finally {
      delete roomWithState.state;
      room.localParticipant.identity = 'visitor-1';
    }
  });

  it('reports a rejected Start publish instead of hiding the transport failure', async () => {
    vi.useFakeTimers();
    room.localParticipant.publishData.mockRejectedValue(new Error('channel closed'));
    render(<ConnectedStartPrompt onStarted={vi.fn()} />);
    pressStart();
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText(/could not send Start \(channel closed\)/i)).toBeTruthy();
  });

  it('stops retrying and ignores acknowledgements after unmount', () => {
    vi.useFakeTimers();
    const onStarted = vi.fn();
    const { unmount } = render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    const request = sentStart();
    unmount();
    act(() => acknowledge(request));
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onStarted).not.toHaveBeenCalled();
    expect(room.localParticipant.publishData).toHaveBeenCalledTimes(1);
  });
});
