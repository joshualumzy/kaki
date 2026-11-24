/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KAKI_LISTENER_IDENTITY, type KakiEvent, type Scenario, type Task, type WingmanNotePayload } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingGrid } from './MeetingGrid';
import { activeStageTaskFor, colleagueStance, reactionForColleague, starterChipsFromAgendaItem, tracksWithSpeakerFirst, visibleStageTracks } from './stageModel';

const mocks = vi.hoisted(() => ({
  screenEvents: [] as KakiEvent[],
  roleEvents: [] as KakiEvent[],
  roleNotes: [] as WingmanNotePayload[],
  screenTasks: new Map<string, Task>(),
  latestRecord: null as KakiEvent | null,
}));

vi.mock('@livekit/components-react', () => ({
  ControlBar: () => null, GridLayout: () => null, ParticipantTile: () => null, RoomAudioRenderer: () => null,
  useDataChannel: () => undefined, useIsSpeaking: () => false, useLocalParticipant: () => ({ isMicrophoneEnabled: false }),
  useParticipants: () => [], useRoomContext: () => ({ localParticipant: { publishData: vi.fn().mockResolvedValue(undefined) } }),
  useTrackRefContext: () => ({ participant: { identity: 'Sam' } }), useTracks: () => [],
}));
vi.mock('../../kaki', async () => {
  const { speechByTopicFromEvents } = await import('../../kaki/topicSpeech');
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
        return {
          tasks: [],
          events: mocks.roleEvents,
          latestRecord: undefined,
          speechByTopic: new Map(),
          wingmanNotes: mocks.roleNotes,
          send: vi.fn(),
          rejection: null,
        };
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
vi.mock('./Orb', () => ({ Orb: () => null, orbPalette: () => ['--c'] }));

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

beforeEach(() => {
  mocks.screenTasks.clear();
  mocks.latestRecord = null;
  mocks.roleEvents.splice(0, mocks.roleEvents.length);
  mocks.roleNotes.splice(0, mocks.roleNotes.length);
  mocks.screenEvents.splice(0, mocks.screenEvents.length,
    line('Sam', 'What is your decision?'),
    line('Visitor', 'Use fresh stock.'),
  );
});

afterEach(cleanup);

describe('scenario-owned copy', () => {
  const stanceScenario: Scenario = {
    id: 'owner', organisation: 'Northwind Labs', meetingTitle: 'Supplier huddle',
    roles: [{
      id: 'lead', label: 'Supplier lead', stance: 'Protects the morning delivery',
      card: { youAre: 'You lead suppliers.', facts: [], responsibility: 'Keep trays right.' },
    }],
    attendees: [{ name: 'Mei', role: 'lead', displayName: 'Mei' }],
    agenda: [{ title: 'Trays', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'lead' }],
  };

  it('takes a colleague stance only from the scenario seat stance, never a pack role id', () => {
    expect(colleagueStance(stanceScenario, 'Mei')).toBe('Protects the morning delivery');
    expect(colleagueStance(stanceScenario, 'Someone else')).toBeUndefined();
  });

  it('shows no stance for an owner meeting whose scenario gives none', () => {
    const owner: Scenario = {
      ...stanceScenario,
      roles: [{ ...stanceScenario.roles[0]!, stance: undefined }],
    };
    expect(colleagueStance(owner, 'Mei')).toBeUndefined();
  });

  it('addresses the fallback starter chips to the meeting host named by the scenario', () => {
    const chips = starterChipsFromAgendaItem(undefined, undefined, [], 'Mei');
    expect(chips[0]).toMatch(/^Mei, could you summarize/);
    expect(chips.join(' ')).not.toContain('Sam');
  });
});

describe('MeetingGrid stage stays a stage', () => {
  it('keeps the Wingman ideas and the asked-you card out of the stage', () => {
    mocks.roleNotes.splice(0, mocks.roleNotes.length, {
      id: 'asked:chef',
      kind: 'asked_you',
      urgency: 'act_now',
      title: 'Alex asked you',
      text: 'Alex asked you: What is the plan for the morning rush?',
    });
    render(<MeetingGrid role="chef" />);

    expect(screen.queryByRole('button', { name: /Need an idea/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /Your turn and starter questions/ })).toBeNull();
    expect(screen.queryByRole('alertdialog', { name: 'Wingman asks you now' })).toBeNull();
  });

  it('never tells the person to type on the stage', () => {
    render(<MeetingGrid role="chef" />);
    expect(document.body.textContent).not.toMatch(/\btype\b/i);
  });
});

describe('visibleStageTracks', () => {
  it('never shows the runner listener as a tile, even with no AI cast', () => {
    const listener = { participant: { identity: KAKI_LISTENER_IDENTITY, metadata: 'listener' } };
    const guest = { participant: { identity: 'Guest', metadata: 'operations_director' } };
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
});

describe('stage action pill', () => {
  function setNarrow(matches: boolean): () => void {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    return () => {
      if (original === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
    };
  }

  it('points a phone at a task that needs this seat, in the panel', () => {
    const restore = setNarrow(true);
    try {
      mocks.screenTasks.set('needs-you', {
        id: 'needs-you', title: 'Share the stock count', context: '', suggestedAssignee: 'chef',
        agendaItemTitle: 'Prep', status: 'DISPATCHED', updatedAt: '2026-11-13T10:05:00.000Z',
      });
      const onOpenKaki = vi.fn();
      render(<MeetingGrid role="chef" onOpenKaki={onOpenKaki} />);

      const pill = screen.getByRole('status');
      expect(pill.textContent).toContain('A task needs you · open in Kaki →');
      fireEvent.click(pill);
      expect(onOpenKaki).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('points a phone at a draft ready for review, in the panel', () => {
    const restore = setNarrow(true);
    try {
      mocks.screenTasks.set('draft', {
        id: 'draft', title: 'Share the stock count', context: '', suggestedAssignee: 'chef',
        agendaItemTitle: 'Prep', status: 'DRAFT_READY', updatedAt: '2026-11-13T10:05:00.000Z',
      });
      render(<MeetingGrid role="chef" />);

      expect(screen.getByRole('status').textContent).toContain('Draft ready · review in Kaki →');
    } finally {
      restore();
    }
  });

  it('says Published when the task is live, and can be dismissed', () => {
    mocks.screenTasks.set('live', {
      id: 'live', title: 'Share the stock count', context: '', suggestedAssignee: 'chef',
      status: 'COMPLETED', artifactUrl: 'https://example.test/live', updatedAt: '2026-11-13T10:05:00.000Z',
    });
    render(<MeetingGrid role="chef" />);

    expect(screen.getByRole('status').textContent).toContain('Published · open in Kaki →');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('stage wording', () => {
  it('calls the AI seats colleagues', () => {
    render(<MeetingGrid role="chef" />);
    expect(screen.getByText(/Waiting for the AI colleagues/)).toBeTruthy();
  });
});

describe('speaking is the only input', () => {
  it('has no text box, Send, Lock or Pause under the stage', () => {
    render(<MeetingGrid role="chef" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    for (const name of [/^Send$/, /Lock in my decision/, /^Pause$/, /^Stop$/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('never tells the visitor to type', () => {
    render(<MeetingGrid role="chef" />);
    expect(document.querySelector('.kd-stage-col')?.textContent).not.toMatch(/\btype\b/i);
  });
});
