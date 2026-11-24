/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, MeetingStateSnapshot, Scenario, Task, WingmanNotePayload } from '@kaki/shared';
import type { KakiRejection } from '../../kaki';
import { speechByTopicFromEvents } from '../../kaki/topicSpeech';

const mocks = vi.hoisted(() => ({
  useKaki: vi.fn(),
  useScenario: vi.fn(),
}));

vi.mock('../../kaki', () => ({
  useKaki: mocks.useKaki,
  useScenario: mocks.useScenario,
}));

import { MeetingPanel } from './MeetingPanel';

const roleFact = 'Physical kiosk cash acceptors cost $1,400 and take 3 weeks to deliver.';

const scenario: Scenario = {
  id: 'test-cafe',
  organisation: 'Test Cafe',
  meetingTitle: 'Morning huddle',
  roles: [
    {
      id: 'operations_director',
      label: 'Operations Director',
      card: { youAre: 'You run the floor.', facts: [roleFact], responsibility: 'Keep the floor running.' },
    },
    { id: 'tech_pos_lead', label: 'Tech & POS Lead' },
  ],
  attendees: [{ name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' }],
  agenda: [
    {
      title: 'Elderly regulars turned away at cashless kiosks',
      minutes: 4,
      canWait: false,
      deadline: 'before doors open at 8',
      ownerRole: 'operations_director',
      decision: 'how do we take cash without putting a coin drawer at the counter?',
      seatFacts: { operations_director: roleFact },
    },
  ],
};

const events: KakiEvent[] = [
  {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: { speaker: 'Arjun', text: 'Let us look at the kiosks.', timestamp: '2026-11-07T10:00:00Z' },
  },
  {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [{ id: 'q-cash', text: 'How do we take cash?', forRole: 'operations_director', agendaIndex: 0 }],
      elapsedSeconds: 5,
      speakerTalkSeconds: {},
    },
  },
];

function withSpeech(
  result: {
    events: KakiEvent[];
    tasks: Map<string, Task>;
    connected: boolean;
    rejection: KakiRejection | null;
    send: () => void;
    wingmanNotes?: WingmanNotePayload[];
    rejections?: KakiRejection[];
    askWingman?: () => boolean;
    meetingState?: MeetingStateSnapshot;
  },
  initialAgendaIndex = 0,
) {
  const wingmanNotes = result.wingmanNotes ?? [];
  return {
    ...result,
    wingmanNotes,
    wingmanHistory: wingmanNotes.map((note) => ({ note })),
    rejections: result.rejections ?? (result.rejection === null ? [] : [result.rejection]),
    askWingman: result.askWingman ?? vi.fn(() => true),
    speechByTopic: speechByTopicFromEvents(result.events, initialAgendaIndex),
  };
}

beforeEach(() => {
  mocks.useScenario.mockReturnValue(scenario);
  mocks.useKaki.mockReturnValue(withSpeech({
    events,
    tasks: new Map(),
    connected: true,
    rejection: null,
    send: vi.fn(),
  }));
});

afterEach(cleanup);

describe('MeetingPanel team meetings', () => {
  const recordOnly: KakiEvent[] = [{
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [],
      elapsedSeconds: 5,
      speakerTalkSeconds: {},
      notetakerStatus: 'ok',
      quietRoles: [],
    },
  }];

  function renderWith(events: KakiEvent[], withAi: boolean): void {
    mocks.useScenario.mockReturnValue(
      withAi ? { ...scenario, npcs: [{ attendee: 'Sam', role: 'host' }] } : scenario,
    );
    mocks.useKaki.mockReturnValue(withSpeech({
      events,
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Owner', seatName: 'Owner' }} role={scenario.roles[0]} />);
  }

  it('says Kaki cannot be reached after 30 seconds without a connection, with a Reload button', () => {
    vi.useFakeTimers();
    try {
      mocks.useKaki.mockReturnValue(withSpeech({ events, tasks: new Map(), connected: false, rejection: null, send: vi.fn() }));
      render(<MeetingPanel viewer={{ name: 'Owner', seatName: 'Owner' }} role={scenario.roles[0]} />);
      expect(screen.getByText('Reconnecting…')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByRole('alert').textContent).toContain("Can't reach Kaki. Your meeting is saved.");
      expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent about AI colleagues in a team meeting with no AI cast', () => {
    renderWith(recordOnly, false);
    expect(screen.queryByText(/Colleagues are sharing their opening stances/i)).toBeNull();
  });

  it('keeps the AI colleagues briefing for a practice meeting', () => {
    renderWith(recordOnly, true);
    expect(screen.getByText(/Colleagues are sharing their opening stances/i)).toBeTruthy();
  });
});

describe('MeetingPanel', () => {
  it('orders the Host, Wingman and Action board sections', () => {
    const suggested: Task = {
      id: 'suggested-1',
      title: 'Post the opening update',
      context: '',
      suggestedAssignee: 'tech_pos_lead',
      status: 'SUGGESTED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events,
      tasks: new Map([[suggested.id, suggested]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    const { container } = render(
      <MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />,
    );

    const headings = [...container.querySelectorAll('.kd-section-title')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings.slice(0, 3)).toEqual(['Host', 'Wingman', 'Action board']);
  });

  it('puts the Need an idea button inside the Wingman section, under the ask box', () => {
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} practice />);

    const wingman = screen.getByLabelText('Wingman section');
    const ask = within(wingman).getByLabelText('Ask Kaki about this meeting');
    const idea = within(wingman).getByRole('button', { name: /Need an idea/ });
    expect(wingman.contains(ask)).toBe(true);
    expect(ask.compareDocumentPosition(idea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('the panel clock', () => {
    const twoItemScenario: Scenario = {
      ...scenario,
      agenda: [
        { ...scenario.agenda[0]!, minutes: 3 },
        { ...scenario.agenda[0]!, title: 'Stock for the rush', minutes: 2 },
      ],
    };
    const record: KakiEvent = {
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 66, speakerTalkSeconds: {} },
    };

    function renderClock(isHost: boolean): void {
      mocks.useScenario.mockReturnValue(twoItemScenario);
      mocks.useKaki.mockReturnValue(withSpeech({
        events: [record],
        tasks: new Map(),
        connected: true,
        rejection: null,
        send: vi.fn(),
      }));
      render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} isHost={isHost} />);
    }

    it('gives a non-host one compact row with the item and time left, no agenda list', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
        renderClock(false);

        expect(screen.getByText(/Now · 1 of 2/)).toBeTruthy();
        expect(screen.getByText('Elderly regulars turned away at cashless kiosks')).toBeTruthy();
        expect(screen.getByText('1:54 left')).toBeTruthy();
        expect(screen.queryByText('2m')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
        expect(screen.getByText('2m')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the full clock and agenda for the host', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
        renderClock(true);

        expect(screen.getByText(/Now · item 1 of 2/)).toBeTruthy();
        expect(screen.getByText('3m')).toBeTruthy();
        expect(screen.getByText('2m')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Agenda' })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('offers starter ideas in a practice meeting and never in a real one', () => {
    const { rerender } = render(
      <MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} practice />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByText(/could you summarize the two main options/i)).toBeTruthy();

    rerender(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} real />);
    expect(screen.queryByRole('button', { name: /Need an idea/ })).toBeNull();
  });

  it('counts a renamed seat by its speakerRole even when its name matches an AI attendee', () => {
    const twoItems: Scenario = {
      ...scenario,
      npcs: [{ attendee: 'Renamed Guest', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host' }],
      agenda: [
        scenario.agenda[0]!,
        { ...scenario.agenda[0]!, title: 'Stock for the rush' },
      ],
    };
    mocks.useScenario.mockReturnValue(twoItems);
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 1, openQuestions: [], elapsedSeconds: 5, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: {
            speaker: 'Renamed Guest',
            text: 'We should order more for the morning.',
            timestamp: '2026-11-07T10:00:00Z',
            speakerRole: 'operations_director',
          },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} practice />);

    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByText(/table it for now/)).toBeTruthy();
  });

  it("offers only the current agenda item's open questions as quick replies", () => {
    const twoItems: Scenario = {
      ...scenario,
      agenda: [
        scenario.agenda[0]!,
        { ...scenario.agenda[0]!, title: 'Stock for the rush' },
      ],
    };
    mocks.useScenario.mockReturnValue(twoItems);
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: {
            agendaIndex: 1,
            openQuestions: [
              { id: 'q-old', text: 'What happened to the old regulars?', forRole: 'operations_director', agendaIndex: 0 },
              { id: 'q-now', text: 'How much stock do we need for the rush?', forRole: 'operations_director', agendaIndex: 1 },
            ],
            elapsedSeconds: 5,
            speakerTalkSeconds: {},
          },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} practice />);

    fireEvent.click(screen.getByRole('button', { name: /Need an idea/ }));
    expect(screen.getByText(/How much stock do we need for the rush\?/)).toBeTruthy();
    expect(screen.queryByText(/What happened to the old regulars\?/)).toBeNull();
  });

  it('replaces a cut transcript line in place instead of listing the whole line and then the cut line', () => {
    const full: KakiEvent = {
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: {
        speaker: 'Arjun',
        text: 'The build is red and the crash only happens on Android.',
        timestamp: '2026-11-07T10:00:00Z',
        lineId: 'line-1',
      },
    };
    const cut: KakiEvent = {
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: {
        speaker: 'Arjun',
        text: 'The build is red',
        timestamp: '2026-11-07T10:00:01Z',
        lineId: 'line-1',
        cut: true,
      },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [full],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    const view = render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);
    expect(screen.getByText('The build is red and the crash only happens on Android.')).toBeTruthy();

    mocks.useKaki.mockReturnValue(withSpeech({
      events: [full, cut],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    view.rerender(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);

    expect(screen.queryByText('The build is red and the crash only happens on Android.')).toBeNull();
    expect(screen.getByText('The build is red …')).toBeTruthy();
  });

  const wingmanNotes: WingmanNotePayload[] = [
    {
      id: 'answer:operations_director',
      kind: 'answer',
      urgency: 'quiet',
      title: 'Wingman',
      text: 'You asked what we decided: the cash box moves.',
      questionText: 'what did we decide?',
      questionFrom: 'you',
      at: '2026-11-06T10:05:00.000Z',
      facts: [{ text: 'The shop still has launch budget left.', source: 'wiki SOP', date: '2026-11-06' }],
      sources: ['wiki SOP (2026-11-06)'],
    },
    {
      id: 'given:operations_director:task-1',
      kind: 'given',
      urgency: 'quiet',
      title: 'You were given a to-do',
      text: 'You were given: Post the cash box decision. Accept or change it on the card.',
    },
    {
      id: 'asked:operations_director',
      kind: 'asked_you',
      urgency: 'act_now',
      title: 'Ravi asked you',
      text: 'Ravi asked you: What should the kiosk do at 8?',
      questionText: 'What should the kiosk do at 8?',
      questionFrom: 'person',
      askedBy: 'Ravi',
      at: '2026-11-06T10:05:00.000Z',
    },
    {
      id: 'record:operations_director:1',
      kind: 'record',
      urgency: 'quiet',
      title: 'Records on this',
      text: 'This record answers what you are discussing: the kiosk accepts notes.',
      facts: [{ text: 'The kiosk accepts notes.', source: 'Gitea ticket', date: '2026-11-05' }],
      sources: ['Gitea ticket (2026-11-05)'],
    },
  ];

  it("renders this seat's private Wingman notes with their facts and sources", () => {
    mocks.useKaki.mockReturnValue(withSpeech({
      events,
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
      wingmanNotes,
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);

    const panel = within(screen.getByLabelText('Wingman'));
    expect(panel.getByText('Answer')).toBeTruthy();
    expect(panel.getByText('You asked what we decided: the cash box moves.')).toBeTruthy();
    expect(panel.getByText('The shop still has launch budget left.')).toBeTruthy();
    expect(panel.getByText('(wiki SOP · 2026-11-06)')).toBeTruthy();
    expect(panel.getByText('You were given')).toBeTruthy();
    expect(panel.getByText('Asked you')).toBeTruthy();
    expect(panel.getByText('Record')).toBeTruthy();
  });

  it('mounts the same private Wingman panel for a real participant and a practice visitor', () => {
    const first = render(
      <MeetingPanel
        viewer={{ name: 'Joshua', seatName: 'Wei Ling' }}
        role={scenario.roles[0]}
        sharedAudience="participant"
      />,
    );
    expect(screen.getByLabelText('Wingman')).toBeTruthy();
    first.unmount();

    render(
      <MeetingPanel
        viewer={{ name: 'Joshua', seatName: 'Wei Ling' }}
        role={scenario.roles[0]}
        practice
      />,
    );
    expect(screen.getByLabelText('Wingman')).toBeTruthy();
  });

  it('shows a refused ask in the Wingman panel rather than swallowing it', () => {
    const refusal: KakiRejection = { commandType: 'ASK_WINGMAN', reason: 'Only a person in a seat can ask the Wingman' };
    mocks.useKaki.mockReturnValue(withSpeech({
      events,
      tasks: new Map(),
      connected: true,
      rejection: refusal,
      rejections: [refusal],
      send: vi.fn(),
      wingmanNotes,
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);

    expect(within(screen.getByLabelText('Wingman')).getByRole('alert').textContent).toContain(
      'Only a person in a seat can ask the Wingman',
    );
  });

  it('shows the accepted decision on a task card', () => {
    const decision = 'We will move the cash box away from the food prep area and count the float every night.';
    const task: Task = {
      id: 'task-1',
      title: 'Post the cash box decision in the team channel',
      context: 'Announce the cash box move.',
      decisionSource: decision,
      suggestedAssignee: 'operations_director',
      assignee: 'operations_director',
      actionKind: 'mattermost_post',
      status: 'DISPATCHED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[task.id, task]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(
      screen.getByText((_, element) => element?.textContent === `Accepted decision: ${decision}`),
    ).toBeTruthy();
  });

  it('shows an undecided card as unresolved, with the reason and host controls', () => {
    const task: Task = {
      id: 'task-undecided',
      title: 'Post the cash box decision',
      context: 'Announce the cash box move.',
      suggestedAssignee: 'operations_director',
      error: 'AI colleague could not decide',
      status: 'SUGGESTED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[task.id, task]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Joshua', seatName: 'Wei Ling' }}
        role={scenario.roles[0]}
        isHost
      />,
    );

    expect(screen.getByText('Decision unresolved')).toBeTruthy();
    expect(screen.getByText('AI colleague could not decide')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dispatch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('shows a review issue on the shared record', () => {
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [{
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'screen' },
        payload: {
          agendaIndex: 0,
          openQuestions: [],
          elapsedSeconds: 5,
          speakerTalkSeconds: {},
          reviewIssues: [{ id: 'review-1', text: 'Could not confirm whether the cash question was answered.', agendaIndex: 0 }],
        },
      }],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(screen.getByText(/Needs a person's eye/)).toBeTruthy();
    expect(screen.getByText('Could not confirm whether the cash question was answered.')).toBeTruthy();
  });

  it('shows a catch only after the room has actually raised it, and never spoils an unraised one', () => {
    const scenarioWithTradeOffs: Scenario = {
      ...scenario,
      agenda: [
        {
          title: 'Butter slice review',
          minutes: 4,
          canWait: false,
          deadline: 'before doors open at 8',
          ownerRole: 'tech_pos_lead',
          decision: 'how do we fix the butter slice?',
          discussion: {
            openingViews: [],
            tradeOffs: [
              {
                attendee: 'Daniel',
                role: 'marketing_lead',
                idea: 'the viral butter video',
                tradeOff: 'Zack video has 90k views calling butter transparent',
                question: 'What do we show on camera?',
              },
              {
                attendee: 'Mei',
                role: 'menu_store_lead',
                idea: 'thicker butter slices',
                tradeOff: 'Takeaway steam melts butter flat; doubling costs $1100',
                question: 'What do we change?',
              },
            ],
          },
        },
      ],
    };
    mocks.useScenario.mockReturnValue(scenarioWithTradeOffs);

    // Daniel and Mei have both spoken at length, but neither catch has been raised yet.
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 25, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Hey team, Daniel here from Marketing.', timestamp: '2026-11-08T10:00:03Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Mei', text: 'I am Mei from Menu and Store Experience.', timestamp: '2026-11-08T10:00:06Z' },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    const { rerender } = render(
      <MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />,
    );

    expect(screen.queryByText('Zack video has 90k views calling butter transparent')).toBeNull();
    expect(screen.queryByText('Takeaway steam melts butter flat; doubling costs $1100')).toBeNull();

    // Daniel's catch is heard: only his card appears.
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 25, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Hey team, Daniel here from Marketing.', timestamp: '2026-11-08T10:00:03Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Mei', text: 'I am Mei from Menu and Store Experience.', timestamp: '2026-11-08T10:00:06Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: {
            speaker: 'Daniel',
            text: 'Zack posted a video calling our butter transparent.',
            timestamp: '2026-11-08T10:00:08Z',
            catchId: '0:catch:0',
          },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    rerender(<MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />);

    expect(screen.getByText('Zack video has 90k views calling butter transparent')).toBeTruthy();
    expect(screen.queryByText('Takeaway steam melts butter flat; doubling costs $1100')).toBeNull();

    // Mei's catch is heard too: both cards are now shown.
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 25, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Hey team, Daniel here from Marketing.', timestamp: '2026-11-08T10:00:03Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Mei', text: 'I am Mei from Menu and Store Experience.', timestamp: '2026-11-08T10:00:06Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: {
            speaker: 'Daniel',
            text: 'Zack posted a video calling our butter transparent.',
            timestamp: '2026-11-08T10:00:08Z',
            catchId: '0:catch:0',
          },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: {
            speaker: 'Mei',
            text: 'Zack bought takeaway toast; the steam melted the butter flat.',
            timestamp: '2026-11-08T10:00:10Z',
            catchId: '0:catch:1',
          },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    rerender(<MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />);

    expect(screen.getByText('Zack video has 90k views calling butter transparent')).toBeTruthy();
    expect(screen.getByText('Takeaway steam melts butter flat; doubling costs $1100')).toBeTruthy();
  });

  it('excludes the visitor\'s own seat from the standoff cards to prevent phantom names and duplicate facts', () => {
    const scenarioWithVisitorTradeOff: Scenario = {
      ...scenario,
      agenda: [
        {
          title: 'Butter slice review',
          minutes: 4,
          canWait: false,
          deadline: 'before doors open at 8',
          ownerRole: 'tech_pos_lead',
          decision: 'how do we fix the butter slice?',
          discussion: {
            openingViews: [],
            tradeOffs: [
              {
                attendee: 'Wei Ling',
                role: 'operations_director',
                idea: 'a bigger launch budget',
                tradeOff: 'Margin limit: Remaining launch budget is capped at $750',
                question: 'What can we spend?',
              },
              {
                attendee: 'Daniel',
                role: 'marketing_lead',
                idea: 'using the viral video',
                tradeOff: 'Viral roast: Video has 90k views',
                question: 'What do we show?',
              },
            ],
          },
        },
      ],
    };
    mocks.useScenario.mockReturnValue(scenarioWithVisitorTradeOff);

    // Visitor joined as Operations Director (role: operations_director, name: Foo)
    // Daniel and "Wei Ling" both have transcript chunks
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 30, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Hey team, Daniel here from Marketing.', timestamp: '2026-11-08T10:00:03Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: {
            speaker: 'Daniel',
            text: 'Zack posted a video.',
            timestamp: '2026-11-08T10:00:05Z',
            catchId: '0:catch:1',
          },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Foo', seatName: 'Wei Ling' }}
        role={scenario.roles[0]} // operations_director
      />,
    );

    // Daniel's card is in the standoff list with headline bolded
    expect(screen.getByText('Viral roast:')).toBeTruthy();
    expect(screen.getByText('Video has 90k views')).toBeTruthy();

    // The phantom "Wei Ling" card MUST NOT be in the standoff list!
    expect(screen.queryByText('Margin limit:')).toBeNull();
    expect(screen.queryByText('Remaining launch budget is capped at $750')).toBeNull();
  });

  it('hides a superseded card from the action board', () => {
    const superseded: Task = {
      id: 'old-card',
      title: 'Old superseded decision',
      context: '',
      suggestedAssignee: 'operations_director',
      status: 'SUPERSEDED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    const current: Task = {
      id: 'current-card',
      title: 'Current decision',
      context: '',
      suggestedAssignee: 'operations_director',
      status: 'DISPATCHED',
      updatedAt: '2026-11-08T10:05:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[superseded.id, superseded], [current.id, current]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(screen.queryByText('Old superseded decision')).toBeNull();
    expect(screen.getByText('Current decision')).toBeTruthy();
  });

  it('offers task dispatch to the person with meeting control even in a non-facilitator seat', () => {
    const suggested: Task = {
      id: 'task-suggested',
      title: 'Order the cash box',
      context: 'Kaki heard a decision.',
      suggestedAssignee: 'operations_director',
      status: 'SUGGESTED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[suggested.id, suggested]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    // The owner on /meeting holds a non-facilitator seat, but the screen's authority is theirs.
    render(
      <MeetingPanel
        viewer={{ name: 'Owner', seatName: 'Owner' }}
        role={scenario.roles[0]}
        sharedAudience="screen"
      />,
    );
    expect(screen.getByRole('button', { name: 'Dispatch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('never shows task dispatch to a phone participant, even in the facilitator seat', () => {
    const suggested: Task = {
      id: 'task-suggested-2',
      title: 'Order the cash box',
      context: 'Kaki heard a decision.',
      suggestedAssignee: 'operations_director',
      status: 'SUGGESTED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[suggested.id, suggested]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    // A friend on /join took the facilitator seat: the server refuses their dispatch, so no buttons.
    render(
      <MeetingPanel
        viewer={{ name: 'Ana', seatName: 'Ana' }}
        role={{ id: 'operations_director', label: 'Operations Director', facilitator: true }}
        isHost
        sharedAudience="participant"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('never shows task dispatch to a practice visitor, whose socket may not dispatch', () => {
    const suggested: Task = {
      id: 'task-suggested-3',
      title: 'Order the cash box',
      context: 'Kaki heard a decision.',
      suggestedAssignee: 'operations_director',
      status: 'SUGGESTED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[suggested.id, suggested]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Visitor', seatName: 'Visitor' }}
        role={scenario.roles[0]}
        sharedAudience="screen"
        practice
      />,
    );
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('does not point a participant at host controls they do not have', () => {
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [events[0]!],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Ana', seatName: 'Ana' }}
        role={{ id: 'operations_director', label: 'Operations Director', facilitator: true }}
        isHost
        sharedAudience="participant"
      />,
    );
    expect(screen.queryByText(/Next agenda item/)).toBeNull();
  });

  it('gives the shared-screen person one pair of meeting controls and nobody else any', () => {
    const recordOnly: KakiEvent[] = [{
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 5, speakerTalkSeconds: {} },
    }];
    mocks.useKaki.mockReturnValue(withSpeech({
      events: recordOnly,
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    const { unmount } = render(
      <MeetingPanel
        viewer={{ name: 'Owner', seatName: 'Owner' }}
        role={scenario.roles[0]}
        sharedAudience="screen"
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Next agenda item' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'End meeting' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Skip to next topic/ })).toBeNull();
    unmount();

    render(
      <MeetingPanel
        viewer={{ name: 'Ana', seatName: 'Ana' }}
        role={scenario.roles[0]}
        sharedAudience="participant"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Next agenda item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End meeting' })).toBeNull();
  });

  it('shows a rejected command to whoever pressed it', () => {
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map(),
      connected: true,
      rejection: { commandType: 'NEXT_AGENDA_ITEM', reason: 'That was the last agenda item' },
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Ana', seatName: 'Ana' }}
        role={scenario.roles[0]}
        sharedAudience="participant"
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('That was the last agenda item');
  });

  it('shows the minutes draft, its reviewer and a link to that card until it is published', () => {
    const draft: Task = {
      id: 'minutes-draft',
      title: 'Publish meeting minutes to the team wiki',
      context: 'The end-of-meeting minutes.',
      suggestedAssignee: 'operations_director',
      assignee: 'operations_director',
      actionKind: 'wiki_page',
      purpose: 'meeting_minutes',
      status: 'DRAFT_READY',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    const closing: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [closing],
      tasks: new Map([[draft.id, draft]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(
      <MeetingPanel
        viewer={{ name: 'Joshua', seatName: 'Wei Ling' }}
        role={scenario.roles[0]}
        sharedAudience="screen"
      />,
    );

    expect(screen.getByText('Minutes draft ready for review.')).toBeTruthy();
    expect(screen.getByText(/Assigned to/).textContent).toContain('Joshua');
    expect(screen.getByRole('link', { name: /Open the minutes draft/ }).getAttribute('href')).toBe(
      '#task-minutes-draft',
    );
    expect(screen.queryByText(/publishing meeting minutes/i)).toBeNull();
  });

  it('shows why the minutes draft failed instead of pretending it is being published', () => {
    const failed: Task = {
      id: 'minutes-failed',
      title: 'Publish meeting minutes to the team wiki',
      context: 'The end-of-meeting minutes.',
      suggestedAssignee: 'operations_director',
      assignee: 'operations_director',
      actionKind: 'wiki_page',
      purpose: 'meeting_minutes',
      status: 'FAILED',
      error: 'The wiki is not reachable.',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    const closing: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [closing],
      tasks: new Map([[failed.id, failed]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);

    expect(screen.getByText('The meeting minutes could not be prepared.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The wiki is not reachable.');
    expect(screen.queryByText(/publishing meeting minutes/i)).toBeNull();
  });

  it('shows the minutes link for the minutes task even when its title is reworded', () => {
    const minutes: Task = {
      id: 'minutes-card',
      title: 'Write up what we agreed for the noticeboard',
      context: 'The end-of-meeting minutes.',
      suggestedAssignee: 'operations_director',
      actionKind: 'wiki_page',
      purpose: 'meeting_minutes',
      status: 'COMPLETED',
      artifactUrl: 'https://wiki.test/meeting-minutes',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map([[minutes.id, minutes]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(screen.getByText('Open meeting minutes in Wiki ↗')).toBeTruthy();
  });

  it('does not treat an ordinary task whose title starts like the minutes as the minutes', () => {
    const ordinary: Task = {
      id: 'ordinary-card',
      title: 'Publish meeting minutes to the noticeboard',
      context: 'A normal follow-up about how we publish notes.',
      suggestedAssignee: 'operations_director',
      actionKind: 'wiki_page',
      status: 'COMPLETED',
      artifactUrl: 'https://wiki.test/noticeboard',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    const closing: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'CLOSING', text: 'That concludes our meeting.' },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [closing],
      tasks: new Map([[ordinary.id, ordinary]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(screen.getByLabelText('End-of-meeting minutes')).toBeTruthy();
    expect(screen.queryByText('Open meeting minutes in Wiki ↗')).toBeNull();
  });

  it('keeps unanswered questions off the live view and shows them only when the meeting ends', () => {
    const question = {
      id: 'q-cash',
      text: 'How do we take cash?',
      forRole: 'operations_director',
      agendaIndex: 0,
    };
    const live: KakiEvent = {
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: {
        agendaIndex: 0,
        openQuestions: [question],
        elapsedSeconds: 5,
        speakerTalkSeconds: {},
      },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [live],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    const view = render(
      <MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} isHost />,
    );

    expect(screen.queryByText('How do we take cash?')).toBeNull();
    expect(screen.queryByText(/Open questions/)).toBeNull();
    view.unmount();

    const ended: KakiEvent = {
      ...live,
      payload: { ...live.payload, ended: true },
    };
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [ended],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} isHost />);

    expect(screen.getByText('Unanswered questions · 1')).toBeTruthy();
    expect(screen.getByText('How do we take cash?')).toBeTruthy();
  });
});

describe('practice minutes and sign-in', () => {
  const ended: KakiEvent = {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [],
      elapsedSeconds: 30,
      speakerTalkSeconds: {},
      ended: true,
    },
  };

  function renderPractice(signedIn: boolean): void {
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [ended],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} practice signedIn={signedIn} />);
  }

  it('tells a signed-out visitor the minutes are on the sample wiki and to sign in to keep them', () => {
    renderPractice(false);
    expect(screen.getByText('Minutes are on the sample wiki')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in to keep your meetings' }).getAttribute('href')).toBe(
      '/signin?next=/practice',
    );
  });

  it('does not tell a signed-in visitor to sign in: their minutes are kept in their own history', () => {
    renderPractice(true);
    expect(screen.queryByText('Minutes are on the sample wiki')).toBeNull();
    expect(screen.queryByText('Sign in to keep your meetings')).toBeNull();
  });
});

describe('the host briefing', () => {
  const packStory = "It's 7 AM on opening day and the shutters are about to go up.";
  const packDecision = 'Do we open on time with the old till?';

  function hostScenario(): Scenario {
    return {
      ...scenario,
      meetingTitle: 'Team playtest meeting',
      hostBrief: { goal: packStory, decision: packDecision },
      npcs: [
        {
          attendee: 'Wei Ling',
          voice: 'v',
          personality: 'Warm.',
          agenda: 'Wei Ling wants the kiosks ready before doors open.',
          concerns: [],
          role: 'host',
        },
      ],
    };
  }

  function renderHost(practice: boolean): void {
    mocks.useScenario.mockReturnValue(hostScenario());
    mocks.useKaki.mockReturnValue(withSpeech({
      events: [],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Owner', seatName: 'Owner' }} isHost practice={practice} />);
  }

  it('briefs a team meeting on its own title, people and agenda, never the pack story', () => {
    renderHost(false);

    const brief = within(screen.getByLabelText('Your briefing as host'));
    expect(screen.getByText('You are hosting · Team playtest meeting')).toBeTruthy();
    expect(brief.getByText(/Wei Ling · Operations Director/)).toBeTruthy();
    expect(brief.getByText(/Elderly regulars turned away at cashless kiosks/)).toBeTruthy();
    expect(screen.queryByText(packStory)).toBeNull();
    expect(screen.queryByText(packDecision)).toBeNull();
    expect(screen.queryByText(/kiosks ready before doors open/)).toBeNull();
  });

  it('keeps the pack story for a practice meeting', () => {
    renderHost(true);

    expect(screen.getByText(packStory)).toBeTruthy();
    expect(screen.getByText(packDecision)).toBeTruthy();
  });
});

describe('MeetingPanel real meeting', () => {
  const recordOnly: KakiEvent[] = [{
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 5, speakerTalkSeconds: {} },
  }];

  function renderReal(agenda: Scenario['agenda'], real: boolean): void {
    mocks.useScenario.mockReturnValue({ ...scenario, agenda });
    mocks.useKaki.mockReturnValue(withSpeech({
      events: recordOnly,
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    }));
    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: undefined }} role={scenario.roles[0]} real={real} />);
  }

  it('keeps one End in the bar, and hides the empty agenda clock and controls', () => {
    renderReal([], true);
    expect(screen.queryByRole('button', { name: 'End meeting' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next agenda item' })).toBeNull();
    expect(screen.queryByText(/Now · item/)).toBeNull();
    expect(screen.queryByText(/of 0:00/)).toBeNull();
  });

  it('still offers Next agenda item for a real meeting that has an agenda', () => {
    renderReal(scenario.agenda, true);
    expect(screen.getByRole('button', { name: 'Next agenda item' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End meeting' })).toBeNull();
    expect(screen.getByText(/Now · 1 of 1/)).toBeTruthy();
  });

  it('leaves the practice controls exactly as they were', () => {
    renderReal(scenario.agenda, false);
    expect(screen.getByRole('button', { name: 'End meeting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next agenda item' })).toBeTruthy();
  });

  it('labels two same-named people by their seat, exactly as the People list does', () => {
    const sameNameScenario: Scenario = {
      ...scenario,
      roles: [
        { id: 'person_a', label: 'Sam' },
        { id: 'person_b', label: 'Sam' },
      ],
      attendees: [
        { name: 'Sam', role: 'person_a', displayName: 'Sam' },
        { name: 'Sam', role: 'person_b', displayName: 'Sam' },
      ],
      agenda: [],
    };
    const sameNameEvents: KakiEvent[] = [
      {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Sam', text: 'First line.', timestamp: '2026-11-07T10:00:00Z', speakerRole: 'person_a' },
      },
      {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Sam', text: 'Second line.', timestamp: '2026-11-07T10:00:01Z', speakerRole: 'person_b' },
      },
    ];
    const meetingState: MeetingStateSnapshot = {
      meetingId: 'mtg-1',
      phase: 'running',
      started: true,
      waitingForOwner: false,
      ownerName: 'Sam',
      offTheRecord: null,
      notesPaused: null,
      cue: null,
      participants: [
        { name: 'sam', displayName: 'Sam', seat: 'person_a', photoUrl: null },
        { name: 'sam', displayName: 'Sam', seat: 'person_b', photoUrl: null },
      ],
    };
    mocks.useScenario.mockReturnValue(sameNameScenario);
    mocks.useKaki.mockReturnValue(withSpeech({
      events: sameNameEvents,
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
      meetingState,
    }));

    render(<MeetingPanel viewer={{ name: 'Sam', seatName: 'Sam', seat: 'person_a' }} />);

    expect(screen.getByText('Sam (you)')).toBeTruthy();
    expect(screen.getByText('Sam (2)')).toBeTruthy();
    expect(screen.queryByText('Sam (2) (you)')).toBeNull();
  });
});

