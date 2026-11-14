/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { KakiEvent, Task } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeStageTaskFor, cardFactForItem, MeetingGrid, reactionForColleague } from './MeetingGrid';

const mocks = vi.hoisted(() => ({ screenEvents: [] as KakiEvent[], roleEvents: [] as KakiEvent[] }));

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
    : { tasks: [], events: mocks.roleEvents },
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

function fact(agendaIndex: number, text: string): KakiEvent {
  return {
    type: 'FACT_FOUND',
    audience: { kind: 'role', role: 'chef' },
    payload: {
      questionId: `q-${agendaIndex}`,
      question: `Question on agenda item ${agendaIndex + 1}`,
      facts: [{ text, source: 'Store records', date: '2026-11-13' }],
      agendaIndex,
    },
  };
}

beforeEach(() => {
  mocks.roleEvents.splice(0, mocks.roleEvents.length);
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

  it('shows only the fact for the active agenda item, not an older topic fact', () => {
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      record(1),
      line('Sam', 'What do you think about stock?'),
      line('Chef', 'We should order more.'),
    );
    mocks.roleEvents.splice(0, mocks.roleEvents.length,
      fact(0, 'Ten stools are in the storeroom.'),
      fact(1, 'The storeroom is inspected every morning.'),
    );
    render(<MeetingGrid role="chef" />);

    expect(screen.getByText('The storeroom is inspected every morning.')).toBeTruthy();
    expect(screen.queryByText('Ten stools are in the storeroom.')).toBeNull();
  });
});

describe('activeStageTaskFor', () => {
  function task(overrides: Partial<Task> & Pick<Task, 'id' | 'status' | 'updatedAt'>): Task {
    return { title: overrides.id, context: '', suggestedAssignee: 'chef', ...overrides };
  }

  it('announces the visitor task on the current topic instead of an older open task', () => {
    const olderTopicOne = task({
      id: 'draft-kopi', status: 'DRAFT_READY', updatedAt: '2026-11-13T10:05:00.000Z', agendaItemTitle: 'Prep',
    });
    const currentTopicTwo = task({
      id: 'stock-count', status: 'DISPATCHED', updatedAt: '2026-11-13T10:00:00.000Z', agendaItemTitle: 'Stock',
    });
    expect(activeStageTaskFor([olderTopicOne, currentTopicTwo], 'chef', 'Stock')?.id).toBe('stock-count');
  });

  it('falls back to the most recently updated open task when the current topic has none', () => {
    const older = task({
      id: 'draft-kopi', status: 'DRAFT_READY', updatedAt: '2026-11-13T10:00:00.000Z', agendaItemTitle: 'Prep',
    });
    const newer = task({
      id: 'stock-count', status: 'DISPATCHED', updatedAt: '2026-11-13T10:05:00.000Z', agendaItemTitle: 'Stock',
    });
    expect(activeStageTaskFor([older, newer], 'chef', 'Delivery')?.id).toBe('stock-count');
  });

  it('ignores tasks that are finished or belong to another role', () => {
    const done = task({ id: 'done', status: 'COMPLETED', updatedAt: '2026-11-13T10:09:00.000Z' });
    const otherRole = task({
      id: 'other', status: 'DISPATCHED', updatedAt: '2026-11-13T10:08:00.000Z', suggestedAssignee: 'host',
    });
    expect(activeStageTaskFor([done, otherRole], 'chef', 'Prep')).toBeUndefined();
  });
});

describe('cardFactForItem', () => {
  it('shows exactly the seat fact the current topic gives that seat', () => {
    const item = {
      title: 'Laptop campers and the breakfast seat crunch',
      minutes: 5,
      ownerRole: 'lead_programmer',
      seatFacts: { producer: 'The blocked seats cost about $420.', lead_programmer: 'The booth sockets share one timer switch.' },
    };
    expect(cardFactForItem(item, 'producer')).toBe('The blocked seats cost about $420.');
    expect(cardFactForItem(item, 'lead_programmer')).toBe('The booth sockets share one timer switch.');
    expect(cardFactForItem(item, 'marketing_lead')).toBeUndefined();
    expect(cardFactForItem(undefined, 'producer')).toBeUndefined();
  });
});

describe('AI colleague reactions', () => {
  it('shows a live reaction for four seconds on the browser clock even when the server clock is far off', () => {
    const receivedAt = Date.parse('2026-11-13T00:00:00.000Z');
    const reaction: KakiEvent & { receivedAt: number } = { type: 'COLLEAGUE_REACTION', audience: { kind: 'all' },
      payload: { who: 'Sam', emoji: '🤔', timestamp: '2020-01-01T00:00:00.000Z' }, receivedAt };
    expect(reactionForColleague('Sam', [reaction], receivedAt)).toMatchObject({ emoji: '🤔' });
    expect(reactionForColleague('Sam', [reaction], receivedAt + 3999)).toMatchObject({ emoji: '🤔' });
    expect(reactionForColleague('Sam', [reaction], receivedAt + 4000)).toBeUndefined();
    expect(reactionForColleague('Ada', [reaction], receivedAt)).toBeUndefined();
  });

  it('does not show a badge for a reaction that is not live in this browser, such as one replayed from history', () => {
    const now = Date.parse('2026-11-13T00:00:00.000Z');
    const reaction: KakiEvent & { receivedAt: number } = { type: 'COLLEAGUE_REACTION', audience: { kind: 'all' },
      payload: { who: 'Sam', emoji: '🤔', timestamp: new Date(now).toISOString() }, receivedAt: now - 10_000 };
    expect(reactionForColleague('Sam', [reaction], now)).toBeUndefined();
  });

  it('does not infer a badge from decision or agreement words in transcripts', () => {
    const now = Date.now();
    expect(reactionForColleague('Sam', [line('Visitor', 'Good call, let us lock that in.')], now)).toBeUndefined();
  });
});
