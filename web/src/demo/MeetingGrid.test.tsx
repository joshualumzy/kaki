/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { KakiEvent } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingGrid } from './MeetingGrid';

const mocks = vi.hoisted(() => ({ screenEvents: [] as KakiEvent[] }));

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null, GridLayout: () => null, ParticipantTile: () => null, RoomAudioRenderer: () => null,
  useDataChannel: () => undefined, useIsSpeaking: () => false, useLocalParticipant: () => ({ isMicrophoneEnabled: false }),
  useParticipants: () => [], useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: { identity: 'Sam' } }), useTracks: () => [],
}));
vi.mock('../kaki', () => ({
  useScenario: () => ({
    id: 'test', organisation: 'Test', meetingTitle: 'Prep', roles: [{ id: 'chef', label: 'Chef' }],
    attendees: [{ name: 'Sam', role: 'chef' }],
    agenda: [
      { title: 'Prep', minutes: 5, ownerRole: 'chef' },
      { title: 'Stock', minutes: 5, ownerRole: 'chef' },
    ],
    npcs: [{ attendee: 'Sam', role: 'host' }],
  }),
  useKaki: (audience: string) => audience === 'screen'
    ? { events: mocks.screenEvents, tasks: [] }
    : { tasks: [], events: [] },
}));
vi.mock('./TypeBar', () => ({ ConnectedTypeBar: () => null }));
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

function record(agendaIndex: number): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'screen' },
    payload: {
      agendaIndex, openQuestions: [], elapsedSeconds: 0, speakerTalkSeconds: {},
      notetakerStatus: 'ok', quietRoles: [],
    },
  };
}

function line(speaker: string, text: string): KakiEvent {
  return {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { speaker, text, timestamp: new Date().toISOString() },
  };
}

beforeEach(() => {
  mocks.screenEvents.splice(0, mocks.screenEvents.length,
    line('Sam', 'What is your decision?'),
    line('Visitor', 'Use fresh stock.'),
  );
});

afterEach(cleanup);

describe('MeetingGrid starter ideas', () => {
  it('offers tabling the topic without a fixed-time follow-up after the visitor has spoken', () => {
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /10 AM/ })).toBeNull();
  });

  it('shows the turn region when a colleague has briefed on a later topic and the AI is idle', () => {
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      record(1),
      line('Sam', 'What do you think about stock?'),
      line('Chef', 'We should order more.'),
    );
    render(<MeetingGrid role="chef" />);
    expect(screen.getByRole('region', { name: /Your turn and starter questions/ })).toBeTruthy();
  });

  it('offers the Table topic chip after the visitor speaks on a later topic', () => {
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      record(1),
      line('Sam', 'What do you think about stock?'),
      line('Chef', 'We should order more.'),
      line('Visitor', 'Let us wait a week.'),
    );
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
  });
});
