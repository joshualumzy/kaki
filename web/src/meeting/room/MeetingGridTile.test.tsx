/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from '@testing-library/react';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingGrid } from './MeetingGrid';

const mocks = vi.hoisted(() => ({
  tile: { identity: 'Owner', name: 'Owner', metadata: 'role_1' },
  localIdentity: 'Owner',
  dataHandlers: new Map<string, (message: { payload: Uint8Array }) => void>(),
}));

const scenario: Scenario = {
  id: 'team',
  organisation: 'Test',
  meetingTitle: 'Supplier huddle',
  roles: [{ id: 'role_1', label: 'Owner' }],
  attendees: [{ name: 'Owner', role: 'role_1', displayName: 'Owner' }],
  agenda: [{ title: 'Supplier tray sizes', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'role_1' }],
};

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null,
  GridLayout: ({ children }: { children?: unknown }) => children,
  ParticipantTile: () => null,
  RoomAudioRenderer: () => null,
  useDataChannel: (topic: string, handler: (message: { payload: Uint8Array }) => void) => { mocks.dataHandlers.set(topic, handler); },
  useIsSpeaking: () => false,
  useLocalParticipant: () => ({ isMicrophoneEnabled: false, localParticipant: { identity: mocks.localIdentity } }),
  useParticipants: () => [mocks.tile],
  useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: mocks.tile }),
  useTracks: () => [{ participant: mocks.tile }],
}));
vi.mock('../../kaki', () => ({
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
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

beforeEach(() => {
  mocks.tile = { identity: 'Owner', name: 'Owner', metadata: 'role_1' };
  mocks.localIdentity = 'Owner';
  mocks.dataHandlers.clear();
});

function speechStatus(participants: Record<string, { state: string; message?: string }>, outage?: { message: string }): void {
  const handler = mocks.dataHandlers.get('kaki.speech-status');
  if (handler === undefined) throw new Error('speech status was not subscribed');
  act(() => {
    handler({ payload: new TextEncoder().encode(JSON.stringify({ participants, ...(outage === undefined ? {} : { outage }) })) });
  });
}

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

  it('shows Transcribing only on the person whose speech is being recognised', () => {
    mocks.tile = { identity: 'Ana', name: 'Ana', metadata: 'role_1' };
    mocks.localIdentity = 'Owner';
    render(<MeetingGrid role="role_1" />);

    speechStatus({ Ana: { state: 'transcribing' } });
    expect(screen.getByText('⏳ Transcribing…')).toBeTruthy();

    speechStatus({ Ben: { state: 'transcribing' } });
    expect(screen.queryByText('⏳ Transcribing…')).toBeNull();
  });

  it('shows the speaker their own recognition failure and asks them to say it again', () => {
    mocks.tile = { identity: 'Owner', name: 'Owner', metadata: 'role_1' };
    mocks.localIdentity = 'Owner';
    render(<MeetingGrid role="role_1" />);

    speechStatus({ Owner: { state: 'failed', message: 'Kaki could not hear that. Please say it again.' } });
    expect(screen.getByRole('alert').textContent).toContain('Kaki could not hear that');
    expect(screen.queryByRole('button', { name: /type/i })).toBeNull();
  });

  it('shows a lasting recognition outage to everyone in the room', () => {
    mocks.tile = { identity: 'Ana', name: 'Ana', metadata: 'role_1' };
    mocks.localIdentity = 'Owner';
    render(<MeetingGrid role="role_1" />);

    speechStatus({ Ana: { state: 'failed' } }, { message: 'Speech recognition is not working.' });
    expect(screen.getByRole('alert').textContent).toContain('Speech recognition is not working');
  });

  it('does not put You on another person’s tile', () => {
    mocks.tile = { identity: 'Ana', name: 'Ana', metadata: 'role_1' };
    mocks.localIdentity = 'Owner';
    render(<MeetingGrid role="role_1" />);

    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.queryByText('Ana (You)')).toBeNull();
  });
});
