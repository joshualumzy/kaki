/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KAKI_LISTENER_IDENTITY, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeStageTaskFor, cardFactForItem, colleagueStance, MeetingGrid, reactionForColleague, starterChipsFromAgendaItem, tracksWithSpeakerFirst, visibleStageTracks } from './MeetingGrid';

const mocks = vi.hoisted(() => ({
  screenEvents: [] as KakiEvent[],
  roleEvents: [] as KakiEvent[],
  screenTasks: new Map<string, Task>(),
  latestRecord: null as KakiEvent | null,
  typeBarProps: [] as Array<{ paused?: boolean; pauseRejection?: unknown }>,
}));

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null, GridLayout: () => null, ParticipantTile: () => null, RoomAudioRenderer: () => null,
  useDataChannel: () => undefined, useIsSpeaking: () => false, useLocalParticipant: () => ({ isMicrophoneEnabled: false }),
  useParticipants: () => [], useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: { identity: 'Sam' } }), useTracks: () => [],
}));
vi.mock('../kaki', async () => {
  const { speechByTopicFromEvents } = await import('../kaki/topicSpeech');
  return {
    useScenario: () => ({
      id: 'test', organisation: 'Test', meetingTitle: 'Prep', roles: [{ id: 'chef', label: 'Chef' }],
      attendees: [{ name: 'Sam', role: 'chef' }],
      agenda: [
        { title: 'Prep', minutes: 5, ownerRole: 'chef' },
        { title: 'Stock', minutes: 5, ownerRole: 'chef' },
      ],
      npcs: [{ attendee: 'Sam', role: 'host' }],
    }),
    useKaki: (audience: { kind: string }) => {
      if (audience.kind !== 'screen') {
        return { tasks: [], events: mocks.roleEvents, latestRecord: undefined, speechByTopic: new Map() };
      }
      const latestRecord = mocks.latestRecord
        ?? [...mocks.screenEvents].reverse().find((event) => event.type === 'MEETING_RECORD_UPDATED');
      return {
        events: mocks.screenEvents,
        tasks: mocks.screenTasks,
        latestRecord,
        speechByTopic: speechByTopicFromEvents(
          mocks.screenEvents,
          latestRecord?.type === 'MEETING_RECORD_UPDATED' ? latestRecord.payload.agendaIndex : 0,
        ),
      };
    },
  };
});
vi.mock('./TypeBar', () => ({
  ConnectedTypeBar: (props: { paused?: boolean; pauseRejection?: unknown }) => {
    mocks.typeBarProps.push(props);
    return null;
  },
}));
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

type RecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

function record(
  agendaIndex: number,
  openQuestions: RecordEvent['payload']['openQuestions'] = [],
  extra: Partial<RecordEvent['payload']> = {},
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'screen' },
    payload: {
      agendaIndex, openQuestions, elapsedSeconds: 0, speakerTalkSeconds: {},
      notetakerStatus: 'ok', quietRoles: [],
      ...extra,
    },
  };
}

function line(
  speaker: string,
  text: string,
  speakerRole?: Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }>['payload']['speakerRole'],
): KakiEvent {
  return {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: {
      speaker,
      text,
      timestamp: new Date().toISOString(),
      ...(speakerRole === undefined ? {} : { speakerRole }),
    },
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
  mocks.screenTasks.clear();
  mocks.latestRecord = null;
  mocks.typeBarProps.splice(0, mocks.typeBarProps.length);
  mocks.roleEvents.splice(0, mocks.roleEvents.length);
  mocks.screenEvents.splice(0, mocks.screenEvents.length,
    line('Sam', 'What is your decision?'),
    line('Visitor', 'Use fresh stock.'),
  );
});

afterEach(cleanup);

describe('scenario-owned copy', () => {
  const stanceScenario: Scenario = {
    id: 'owner', organisation: 'Northwind Labs', meetingTitle: 'Supplier huddle',
    roles: [{ id: 'lead', label: 'Supplier lead', card: { youAre: 'You lead suppliers.', facts: [], responsibility: 'Keep trays right.' } }],
    attendees: [{ name: 'Mei', role: 'lead', zoomDisplayName: 'Mei' }],
    agenda: [{ title: 'Trays', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'lead' }],
  };

  it('takes a colleague stance from the scenario angle, never a pack role id', () => {
    const item = {
      title: 'Trays', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'lead',
      discussion: { openingViews: [{ attendee: 'Mei', angle: 'Protects the morning delivery' }], tradeOffs: [] },
    };
    expect(colleagueStance(stanceScenario, 'Mei', item)).toBe('Protects the morning delivery');
    expect(colleagueStance(stanceScenario, 'Mei', undefined)).toBe('Keep trays right.');
    expect(colleagueStance(stanceScenario, 'Someone else', item)).toBeUndefined();
  });

  it('addresses the fallback starter chips to the meeting host named by the scenario', () => {
    const chips = starterChipsFromAgendaItem(undefined, undefined, [], 'Mei');
    expect(chips[0]).toMatch(/^Mei, could you summarize/);
    expect(chips.join(' ')).not.toContain('Sam');
  });
});

describe('MeetingGrid starter ideas', () => {
  it('offers tabling the topic without a fixed-time follow-up after the visitor has spoken', () => {
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /10 AM/ })).toBeNull();
    expect(screen.getByRole('button', { name: /what's still open on this one\?/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /lock in both parts/i })).toBeNull();
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

  it('offers the Table topic chip on topic 2 after the topic record has left the event window', () => {
    mocks.latestRecord = record(2);
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      ...Array.from({ length: 60 }, (_, index) => line('Sam', `filler ${index}`)),
      line('Renamed Guest', 'Before I call it, what is the practical catch for the team?', 'chef'),
    );
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
  });

  it('does not offer the Table topic chip before the viewer speaks on the current topic', () => {
    mocks.latestRecord = record(2);
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      line('Sam', 'Here is the stock question.'),
      line('Other Person', 'We should order more.', 'host'),
    );
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.queryByRole('button', { name: /Table topic/ })).toBeNull();
  });

  it('counts a renamed seat by its speakerRole even when its name matches an AI attendee', () => {
    mocks.latestRecord = record(2);
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      line('Sam', 'Before I call it, what is the practical catch for the team?', 'chef'),
    );
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByRole('button', { name: /Table topic/ })).toBeTruthy();
  });

  it('offers only the current agenda item\'s open questions as quick replies', () => {
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      record(1, [
        { id: 'q-old', text: 'What happened to the old regulars?', forRole: 'chef', agendaIndex: 0 },
        { id: 'q-now', text: 'How much stock do we need for the rush?', forRole: 'chef', agendaIndex: 1 },
      ]),
      line('Sam', 'What do you think about stock?'),
      line('Chef', 'We should order more.'),
    );
    render(<MeetingGrid role="chef" />);
    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));

    expect(screen.getByRole('button', { name: /How much stock do we need for the rush\?/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /What happened to the old regulars\?/ })).toBeNull();
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

describe('visibleStageTracks', () => {
  it('never shows the runner listener as a tile, even with no AI cast', () => {
    const listener = { participant: { identity: KAKI_LISTENER_IDENTITY, metadata: 'listener' } };
    const guest = { participant: { identity: 'Guest', metadata: 'producer' } };
    expect(visibleStageTracks([listener, guest], { npcs: [] })).toEqual([guest]);
  });

  it('shows only AI attendees in this meeting cast', () => {
    const castMember = { participant: { identity: 'Sam', metadata: 'AI attendee' } };
    const absentColleague = { participant: { identity: 'Arjun', metadata: 'AI attendee' } };
    const scenario = { npcs: [{ attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [] }] };
    expect(visibleStageTracks([castMember, absentColleague], scenario)).toEqual([castMember]);
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
      canWait: false,
      deadline: 'before doors open at 8',
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

describe('phone stage ordering and settled topic', () => {
  function track(identity: string) {
    return { participant: { identity } };
  }

  it('moves the speaking colleague to the front of the page', () => {
    const tracks = [track('Sam'), track('Arjun'), track('Mei')];
    expect(tracksWithSpeakerFirst(tracks, 'Mei').map((entry) => entry.participant.identity))
      .toEqual(['Mei', 'Sam', 'Arjun']);
    expect(tracksWithSpeakerFirst(tracks, 'Sam').map((entry) => entry.participant.identity))
      .toEqual(['Sam', 'Arjun', 'Mei']);
    expect(tracksWithSpeakerFirst(tracks, undefined).map((entry) => entry.participant.identity))
      .toEqual(['Sam', 'Arjun', 'Mei']);
  });

  it('hides the Jump in hint once the current topic has a follow-up card to review', () => {
    mocks.screenEvents.splice(0, mocks.screenEvents.length,
      record(0),
      line('Sam', 'What do you think about stock?'),
      line('Chef', 'We should order more.'),
    );
    mocks.screenTasks.set('follow-up', {
      id: 'follow-up', title: 'Share the decision', context: '', suggestedAssignee: 'chef',
      agendaItemTitle: 'Prep', status: 'DRAFT_READY', updatedAt: '2026-11-13T10:05:00.000Z',
    });
    render(<MeetingGrid role="chef" />);
    expect(screen.queryByRole('region', { name: /Your turn and starter questions/ })).toBeNull();
  });
});

describe('pause button state', () => {
  it('follows the latest server record, including an empty-room pause', () => {
    mocks.screenEvents = [
      record(0, [], { paused: true, pauseKind: 'empty-room' }),
      line('Sam', 'Take a minute.'),
    ];
    const view = render(<MeetingGrid role="chef" />);
    expect(mocks.typeBarProps.at(-1)?.paused).toBe(true);

    mocks.screenEvents = [
      record(0),
      line('Sam', 'Carry on.'),
    ];
    view.rerender(<MeetingGrid role="chef" />);
    expect(mocks.typeBarProps.at(-1)?.paused).toBe(false);
  });

  it('takes the pause from the hook\'s record even after it leaves the event window', () => {
    // The hook owns the newest record; the 50-event window has already pushed it out.
    mocks.screenEvents = [line('Sam', 'Carry on.')];
    mocks.latestRecord = record(0, [], { paused: true, pauseKind: 'person' });
    render(<MeetingGrid role="chef" />);
    expect(mocks.typeBarProps.at(-1)?.paused).toBe(true);
  });
});
