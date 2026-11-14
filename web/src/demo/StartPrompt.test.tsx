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

describe('StartPrompt', () => {
  it('uses agenda artwork rather than guessing from a title', () => {
    mocks.useScenario.mockReturnValue({ ...scenario, agenda: [
      { title: 'A neutral title', minutes: 5, ownerRole: 'producer', art: '/scenario/current.svg' },
    ] });
    render(<StartPrompt onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Today’s 1 Topics/i }));
    expect((screen.getByAltText('A neutral title') as HTMLImageElement).getAttribute('src')).toBe('/scenario/current.svg');
  });

  it('tells the person to read their briefing and waits for the button', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    expect(screen.getByText(/Your briefing/)).toBeTruthy();
    expect(screen.getByText(/stay quiet until you start/)).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts the meeting when the button is pressed', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('walks through the live spotlight tour highlighting both the left stage and right Kaki wingman dock', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    fireEvent.click(screen.getByRole('tab', { name: /3\. Live Room Spotlight/i }));
    expect(screen.getByText(/Highlighting · Live Meeting Stage/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Next: Spotlight Kaki Wingman/i }));
    expect(screen.getByText(/Highlighting · Kaki Wingman Dock/i)).toBeTruthy();
  });
});

describe('ConnectedStartPrompt', () => {
  it('retries with the same request and opens only after the matching acknowledgement', () => {
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByText(/did not confirm the start/i)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    room.localParticipant.publishData.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    const request = sentStart();
    expect(screen.getByText(/waiting for the room to confirm/i)).toBeTruthy();
    act(() => acknowledge(request));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected Start publish instead of hiding the transport failure', async () => {
    vi.useFakeTimers();
    room.localParticipant.publishData.mockRejectedValue(new Error('channel closed'));
    render(<ConnectedStartPrompt onStarted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText(/could not send Start \(channel closed\)/i)).toBeTruthy();
  });

  it('stops retrying and ignores acknowledgements after unmount', () => {
    vi.useFakeTimers();
    const onStarted = vi.fn();
    const { unmount } = render(<ConnectedStartPrompt onStarted={onStarted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
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
