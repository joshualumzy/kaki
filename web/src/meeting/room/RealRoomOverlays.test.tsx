/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  isHost: false,
  meetingState: {
    meetingId: 'mtg-1',
    phase: 'lobby',
    started: false,
    waitingForOwner: true,
    ownerName: 'Ada',
    offTheRecord: null as { since: string } | null,
    participants: [],
    notesPaused: null as string | null,
    cue: null as { text: string; at: string } | null,
  },
}));

vi.mock('./realRoom', () => ({
  useRealRoom: () => ({
    meetingState: mocks.meetingState,
    send: mocks.send,
    role: 'chef',
    isHost: mocks.isHost,
  }),
}));

vi.mock('../../product/api', () => ({ getMeetingInfo: vi.fn(async () => ({ historyWorkspaceId: null })) }));

import { RealEndedPanel, RealRoomBanners, RealWaitingOverlay } from './RealRoomOverlays';

beforeEach(() => {
  mocks.send.mockReset();
  mocks.isHost = false;
  mocks.meetingState.offTheRecord = null;
  mocks.meetingState.notesPaused = null;
  mocks.meetingState.cue = null;
  mocks.meetingState.waitingForOwner = true;
  mocks.meetingState.ownerName = 'Ada';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('real meeting notices', () => {
  it('says the room is off the record and lets anyone resume the notes', () => {
    mocks.meetingState.offTheRecord = { since: new Date().toISOString() };
    render(<RealRoomBanners />);

    expect(
      screen.getByText(/Off the record: nothing is being written down/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume the notes' }));
    expect(mocks.send).toHaveBeenCalledWith({ type: 'SET_OFF_THE_RECORD', on: false });
  });

  it('shows the notes-paused warning and the quiet agenda cue', () => {
    mocks.meetingState.notesPaused = "Kaki can't hear the room right now";
    mocks.meetingState.cue = { text: '5 min left on Budget', at: new Date().toISOString() };
    render(<RealRoomBanners />);

    expect(screen.getByRole('alert').textContent).toBe("Kaki can't hear the room right now");
    expect(screen.getByText('5 min left on Budget')).toBeTruthy();
  });

  it('waits for the owner and offers Start only to the host', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ started: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<RealWaitingOverlay meetingId="mtg-1" />);

    expect(screen.getByRole('heading', { name: 'Waiting for Ada to start' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the meeting' })).toBeNull();

    cleanup();
    mocks.isHost = true;
    render(<RealWaitingOverlay meetingId="mtg-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/meetings/mtg-1/meeting/start');
  });

  it('shows the server\'s busy message when a meeting cannot open', async () => {
    mocks.isHost = true;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'busy',
          message: 'Kaki is running as many meetings as it can right now. Try again in a few minutes.',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<RealWaitingOverlay meetingId="mtg-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Kaki is running as many meetings as it can right now. Try again in a few minutes.',
    );
  });

  it('shows a plain sentence and a Try again button when starting fails with no message', async () => {
    mocks.isHost = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    render(<RealWaitingOverlay meetingId="mtg-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't start the meeting. Try again.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says nothing while the meeting is running', () => {
    mocks.meetingState.waitingForOwner = false;
    const { container } = render(<RealWaitingOverlay meetingId="mtg-1" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ended real meeting', () => {
  it('thanks a guest and says the owner keeps the notes', async () => {
    mocks.meetingState.phase = 'ended';
    render(<RealEndedPanel meetingId="mtg-1" />);

    expect(screen.getByText('Meeting ended')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Thanks for joining. The notes are kept by Ada/)).toBeTruthy());
    expect(screen.queryByText(/Syncing/)).toBeNull();
    mocks.meetingState.phase = 'lobby';
  });
});
