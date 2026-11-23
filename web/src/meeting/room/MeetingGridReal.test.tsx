/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import type { KakiEvent, MeetingStateSnapshot } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  meetingState: undefined as MeetingStateSnapshot | undefined,
  events: [] as KakiEvent[],
}));

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null,
  GridLayout: ({ children }: { children?: unknown }) => children,
  ParticipantTile: () => null,
  RoomAudioRenderer: () => null,
  useDataChannel: () => undefined,
  useIsSpeaking: () => false,
  useLocalParticipant: () => ({ isMicrophoneEnabled: true, localParticipant: { identity: 'ada' } }),
  useParticipants: () => [],
  useRoomContext: () => ({ localParticipant: { publishData: vi.fn() } }),
  useTrackRefContext: () => ({ participant: { identity: 'ada', name: 'Ada' } }),
  useTracks: () => [],
}));

vi.mock('../../kaki', () => ({
  useScenario: () => ({
    id: 'real',
    organisation: 'Test',
    meetingTitle: 'Weekly planning',
    roles: [{ id: 'chef', label: 'Chef' }],
    attendees: [{ name: 'Ada', role: 'chef', displayName: 'Ada' }],
    agenda: [{ title: 'Budget', minutes: 10, ownerRole: 'chef' }],
  }),
  useKaki: () => ({
    events: mocks.events,
    latestRecord: undefined,
    speechByTopic: new Map(),
    tasks: new Map(),
    rejection: null,
    send: vi.fn(),
    connected: true,
    meetingState: mocks.meetingState,
  }),
}));

vi.mock('./realRoom', () => ({
  useRealRoom: () => ({
    meetingState: mocks.meetingState,
    send: vi.fn(),
    role: 'chef',
    isHost: false,
  }),
}));

vi.mock('./RealMeetingBar', () => ({
  RealMeetingBar: () => <div data-testid="real-bar" />,
}));
vi.mock('./MutedHint', () => ({ MutedHint: () => null }));
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

import { MeetingGrid } from './MeetingGrid';

function state(overrides: Partial<MeetingStateSnapshot> = {}): MeetingStateSnapshot {
  return {
    meetingId: 'mtg-1',
    phase: 'running',
    started: true,
    waitingForOwner: false,
    ownerName: 'Ada',
    offTheRecord: null,
    participants: [{ name: 'ada', displayName: 'Ada', seat: 'chef', photoUrl: null }],
    notesPaused: null,
    cue: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.events = [];
  mocks.meetingState = state();
});

afterEach(cleanup);

describe('real meeting stage', () => {
  it('uses the real bottom bar and never the practice controls', () => {
    render(<MeetingGrid role="chef" real meetingId="mtg-1" />);

    expect(screen.getByTestId('real-bar')).toBeTruthy();
    expect(screen.queryByText(/Your turn/)).toBeNull();
    expect(screen.queryByText(/Need an idea/)).toBeNull();
    expect(screen.queryByText('Mic muted')).toBeNull();
  });

  it('hides captions and notices while the room is off the record', () => {
    mocks.events = [
      {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: {
          speaker: 'Ada',
          text: 'This must never be shown while off the record.',
          timestamp: new Date().toISOString(),
        },
      },
    ];
    mocks.meetingState = state({ offTheRecord: { since: new Date().toISOString() } });
    render(<MeetingGrid role="chef" real meetingId="mtg-1" />);

    expect(screen.queryByText(/This must never be shown/)).toBeNull();
    expect(screen.getByText(/Off the record: nothing is being written down/)).toBeTruthy();
  });

  it('shows a placeholder tile for a seated person LiveKit does not have yet', () => {
    mocks.meetingState = state({
      participants: [
        { name: 'ada', displayName: 'Ada', seat: 'chef', photoUrl: null },
        { name: 'sam', displayName: 'Sam', seat: 'cashier', photoUrl: null },
        { name: 'sam', displayName: 'Sam', seat: 'cashier-2', photoUrl: null },
      ],
    });
    render(<MeetingGrid role="chef" real meetingId="mtg-1" />);

    const pending = screen.getByLabelText('Joining the meeting');
    expect(pending.textContent).toContain('Sam');
    expect(pending.textContent).toContain('Sam (2)');
  });
});
