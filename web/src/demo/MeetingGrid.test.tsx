/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingGrid } from './MeetingGrid';

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null, GridLayout: () => null, ParticipantTile: () => null, RoomAudioRenderer: () => null,
  useDataChannel: () => undefined, useIsSpeaking: () => false, useLocalParticipant: () => ({ isMicrophoneEnabled: false }),
  useParticipants: () => [], useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: { identity: 'Sam' } }), useTracks: () => [],
}));
vi.mock('../kaki', () => ({
  useScenario: () => ({
    id: 'test', organisation: 'Test', meetingTitle: 'Prep', roles: [{ id: 'chef', label: 'Chef' }],
    attendees: [{ name: 'Sam', role: 'chef' }], agenda: [{ title: 'Prep', minutes: 5, ownerRole: 'chef' }],
    npcs: [{ attendee: 'Sam', role: 'host' }],
  }),
  useKaki: (role: string) => role === 'screen' ? { events: [], tasks: [] } : {
    tasks: [], events: [
      { type: 'TRANSCRIPT_CHUNK', payload: { speaker: 'Sam', text: 'What is your decision?', timestamp: new Date().toISOString() } },
      { type: 'TRANSCRIPT_CHUNK', payload: { speaker: 'Visitor', text: 'Use fresh stock.', timestamp: new Date().toISOString() } },
    ],
  },
}));
vi.mock('./TypeBar', () => ({ ConnectedTypeBar: () => null }));
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

afterEach(cleanup);

describe('MeetingGrid starter ideas', () => {
  it('offers tabling the topic without a fixed-time follow-up after the visitor has spoken', () => {
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /10 AM/ })).toBeNull();
  });
});
