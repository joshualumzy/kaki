/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScenario, type Scenario } from '@kaki/shared';
import kopitiamJson from '../../../../scenarios/kopitiam/scenario.json';

const mocks = vi.hoisted(() => ({ useScenario: vi.fn() }));

vi.mock('../../kaki', () => ({ useScenario: mocks.useScenario }));

import { ConnectedStartPrompt, StartPrompt } from './StartPrompt';

const scenario: Scenario = {
  id: 'start-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [
    { id: 'operations_director', label: 'Operations Director' },
    { id: 'general_manager', label: 'General Manager', facilitator: true },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' },
    { name: 'Sam', role: 'general_manager', displayName: 'Sam' },
  ],
  agenda: [],
  npcs: [
    { attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host', playable: true },
    { attendee: 'Arjun', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'participant', playable: true },
  ],
};

function replyWith(body: Record<string, unknown>, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
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

const kopitiam = parseScenario(kopitiamJson);
const kopitiamMinutes = kopitiam.agenda.reduce((sum, item) => sum + item.minutes, 0);

describe('StartPrompt', () => {
  it('renders the Kopitiam practice briefing exactly as the old start prompt', () => {
    mocks.useScenario.mockReturnValue(kopitiam);
    const { container } = render(<StartPrompt onStart={vi.fn()} />);
    expect(container.querySelector('.kd-story-badge')?.textContent).toBe('Nanyang Kopi & Toast · Opening day');
    expect(container.querySelector('.kd-story-hero-img')?.getAttribute('src')).toBe('/scenario/kopitiam-hero.svg');
    expect(container.querySelector('.kd-story-shop-intro')?.textContent).toBe(
      'Our renovated Nanyang Kopi & Toast flagship at Raffles Place opens this morning. ' +
        `You’re opening-day lead: the team has ${kopitiamMinutes} minutes, and the calls are yours.`,
    );
  });

  it('shows no pack story or artwork for an owner meeting without a practice briefing', () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      organisation: 'Northwind Labs',
      meetingTitle: 'Weekly planning',
      situation: undefined,
    });
    const { container } = render(<StartPrompt onStart={vi.fn()} />);
    expect(container.querySelector('.kd-story-hero-img')).toBeNull();
    expect(screen.queryByText(/Nanyang Kopi/)).toBeNull();
    expect(screen.queryByText(/Opening day/)).toBeNull();
    expect(container.querySelector('.kd-story-shop-intro')?.textContent).not.toMatch(/Nanyang Kopi|Raffles Place/);
  });

  it('lists today’s calls on the first screen', () => {
    mocks.useScenario.mockReturnValue({ ...scenario, agenda: [
      { title: 'Till login fix', minutes: 5, ownerRole: 'operations_director' },
      { title: 'Delivery promise', minutes: 5, ownerRole: 'operations_director' },
    ] });
    render(<StartPrompt onStart={vi.fn()} />);
    expect(screen.getByText(/Today’s 2 calls/)).toBeTruthy();
    expect(screen.getByText(/Till login fix/)).toBeTruthy();
    expect(screen.getByText(/10 minutes/)).toBeTruthy();
  });

  it('shows the meeting\'s own organisation and situation, not the Kopitiam briefing', () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      organisation: 'Northwind Labs',
      meetingTitle: 'Weekly planning',
      situation: 'The team meets to choose next week’s priorities.',
    });
    render(<StartPrompt onStart={vi.fn()} />);
    expect(screen.getByText('Northwind Labs')).toBeTruthy();
    expect(screen.getByText('Weekly planning')).toBeTruthy();
    expect(screen.getByText(/next week’s priorities/)).toBeTruthy();
    expect(screen.queryByText(/Nanyang Kopi/)).toBeNull();
    expect(screen.queryByText(/Opening day/)).toBeNull();
  });

  it('keeps Start off the first screen so the role is read before the meeting begins', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Start the meeting' })).toBeNull();
    expect(screen.getByText(/stay quiet until you start/)).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('teaches talking on the mic and the Kaki panel on the second screen, with no typing or pause keys', () => {
    const { container } = render(<StartPrompt onStart={vi.fn()} />);
    goToStart();
    expect(screen.getByText(/speak into your mic/)).toBeTruthy();
    expect(screen.getByText(/Kaki panel/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\btype\b/i);
    expect(screen.queryByText('Space')).toBeNull();
    expect(screen.queryByText('Esc')).toBeNull();
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
  it('posts the one Start to the server and opens when it confirms', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ started: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    expect(screen.getByText(/waiting for the room to confirm/i)).toBeTruthy();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/meeting/start', expect.objectContaining({ method: 'POST' }));
  });

  it('fails closed with a recoverable message when the scenario is unavailable', () => {
    mocks.useScenario.mockReturnValue(undefined as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    expect(screen.getByText(/not ready yet/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('shows the server reason and lets the person try again', async () => {
    replyWith({ error: 'Join the meeting before starting it.' }, false, 409);
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    expect(await screen.findByText(/Join the meeting before starting it/i)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();

    replyWith({ started: true });
    pressStart();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it('does not send a second Start while the first is waiting', () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    render(<ConnectedStartPrompt onStarted={vi.fn()} />);
    pressStart();
    pressStart();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a server that never confirms the start', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const onStarted = vi.fn();
    render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    await act(async () => {
      vi.advanceTimersByTime(8000);
      await Promise.resolve();
    });
    expect(screen.getByText(/did not confirm the start/i)).toBeTruthy();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('ignores a late answer after unmount', async () => {
    let resolveFetch: ((value: { ok: boolean; status: number; json: () => Promise<{ started: boolean }> }) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));
    const onStarted = vi.fn();
    const { unmount } = render(<ConnectedStartPrompt onStarted={onStarted} />);
    pressStart();
    unmount();
    await act(async () => {
      resolveFetch?.({ ok: true, status: 200, json: async () => ({ started: true }) });
      await Promise.resolve();
    });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('shows a failed Start after StrictMode has run setup twice', async () => {
    replyWith({ error: 'The AI attendees are not connected.' }, false, 503);
    render(
      <StrictMode>
        <ConnectedStartPrompt onStarted={vi.fn()} />
      </StrictMode>,
    );
    pressStart();
    expect(await screen.findByText(/AI attendees are not connected/i)).toBeTruthy();
  });
});
