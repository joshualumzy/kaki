/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  isHost: false,
  meetingState: {
    meetingId: 'mtg-1',
    phase: 'running',
    started: true,
    waitingForOwner: false,
    ownerName: 'Ada',
    offTheRecord: null as { since: string } | null,
    participants: [
      { name: 'ada', displayName: 'Ada Lovelace', seat: 'chef', photoUrl: null },
      { name: 'sam', displayName: 'Sam Tan', seat: 'cashier', photoUrl: 'https://photos.example/sam.jpg' },
    ],
    notesPaused: null,
    cue: null,
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

vi.mock('../MeetingOverlays', () => ({
  QrCode: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}));

vi.mock('@livekit/components-react', () => ({
  useLocalParticipant: () => ({
    localParticipant: {
      setMicrophoneEnabled: vi.fn(async () => undefined),
      setCameraEnabled: vi.fn(async () => undefined),
    },
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
  }),
  useRoomContext: () => ({ disconnect: mocks.disconnect }),
}));

import { RealMeetingBar } from './RealMeetingBar';

beforeEach(() => {
  mocks.send.mockReset();
  mocks.disconnect.mockReset();
  mocks.isHost = false;
  mocks.meetingState.offTheRecord = null;
});

afterEach(cleanup);

function renderBar(): void {
  render(<RealMeetingBar meetingId="mtg-1" meetingCode="K7QX" />);
}

describe('real meeting bar', () => {
  it('offers the real controls and never the practice ones', () => {
    renderBar();

    for (const label of ['Mic on', 'Camera off', 'Type', 'Off the record', 'Invite', 'People', 'Leave']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /End for everyone/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lock in my decision/ })).toBeNull();
  });

  it('turns the record off and back on for anyone in the room', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Off the record' }));
    expect(mocks.send).toHaveBeenCalledWith({ type: 'SET_OFF_THE_RECORD', on: true });

    cleanup();
    mocks.meetingState.offTheRecord = { since: new Date().toISOString() };
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Back on the record' }));
    expect(mocks.send).toHaveBeenCalledWith({ type: 'SET_OFF_THE_RECORD', on: false });
  });

  it('shows the invite link and QR with the meeting code', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));

    const link = screen.getByRole('link', { name: /\/m\/mtg-1\?code=K7QX/ });
    expect(link.getAttribute('href')).toContain('/m/mtg-1?code=K7QX');
    expect(screen.getByTestId('qr').getAttribute('data-value')).toContain('/m/mtg-1?code=K7QX');
  });

  it('lists the people with their photo or initials', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /People/ }));

    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Sam Tan')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Sam Tan' }).tagName).toBe('IMG');
    expect(screen.getByRole('img', { name: 'Ada Lovelace' }).textContent).toBe('AL');
  });

  it('lets only the host end the meeting, after a confirmation', () => {
    mocks.isHost = true;
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'End for everyone' }));
    expect(screen.getByText('End for everyone?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'End the meeting' }));
    expect(mocks.send).toHaveBeenCalledWith({ type: 'END_MEETING' });
  });

  it('leaves the room from the Leave button', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(mocks.disconnect).toHaveBeenCalled();
  });
});
