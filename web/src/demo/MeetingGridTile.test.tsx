/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingGrid } from './MeetingGrid';

const mocks = vi.hoisted(() => ({
  tile: { identity: 'Owner', name: 'Owner', metadata: 'role_1' },
  localIdentity: 'Owner',
}));

const scenario: Scenario = {
  id: 'team',
  organisation: 'Test',
  meetingTitle: 'Supplier huddle',
  roles: [{ id: 'role_1', label: 'Owner' }],
  attendees: [{ name: 'Owner', role: 'role_1', zoomDisplayName: 'Owner' }],
  agenda: [{ title: 'Supplier tray sizes', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'role_1' }],
};

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null,
  GridLayout: ({ children }: { children?: unknown }) => children,
  ParticipantTile: () => null,
  RoomAudioRenderer: () => null,
  useDataChannel: () => undefined,
  useIsSpeaking: () => false,
  useLocalParticipant: () => ({ isMicrophoneEnabled: false, localParticipant: { identity: mocks.localIdentity } }),
  useParticipants: () => [mocks.tile],
  useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: mocks.tile }),
  useTracks: () => [{ participant: mocks.tile }],
}));
vi.mock('../kaki', () => ({
  useScenario: () => scenario,
  useKaki: () => ({
    events: [] as KakiEvent[],
    latestRecord: undefined,
    speechByTopic: new Map(),
    tasks: new Map(),
    rejection: null,
    send: vi.fn(),
    connected: true,
  }),
}));
vi.mock('./TypeBar', () => ({ ConnectedTypeBar: () => null }));
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

beforeEach(() => {
  mocks.tile = { identity: 'Owner', name: 'Owner', metadata: 'role_1' };
  mocks.localIdentity = 'Owner';
});

afterEach(cleanup);

describe('meeting tiles', () => {
  it('marks only the local person as You and shows the meeting role label, never its id', () => {
    mocks.tile = { identity: 'Chair', name: 'Chair', metadata: 'role_1' };
    mocks.localIdentity = 'Chair';
    render(<MeetingGrid role="role_1" />);

    expect(screen.getByText('Chair (You)')).toBeTruthy();
    expect(screen.getByText('· Owner')).toBeTruthy();
    expect(screen.queryByText(/role_1/)).toBeNull();
  });

  it('does not put You on another person’s tile', () => {
    mocks.tile = { identity: 'Ana', name: 'Ana', metadata: 'role_1' };
    mocks.localIdentity = 'Owner';
    render(<MeetingGrid role="role_1" />);

    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.queryByText('Ana (You)')).toBeNull();
  });
});
