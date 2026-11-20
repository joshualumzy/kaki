/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario, Task } from '@kaki/shared';
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

const duplicateFact = roleFact;
const distinctFact = 'The shop has $750 left in its launch budget.';

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
  {
    type: 'FACT_FOUND',
    audience: { kind: 'role', role: 'operations_director' },
    payload: {
      questionId: 'q-cash',
      question: 'How do we take cash?',
      facts: [
        { text: duplicateFact, source: 'gitea ticket', date: '2026-11-06' },
        { text: distinctFact, source: 'wiki SOP', date: '2026-11-06' },
      ],
      agendaIndex: 0,
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
  },
  initialAgendaIndex = 0,
) {
  return { ...result, speechByTopic: speechByTopicFromEvents(result.events, initialAgendaIndex) };
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

  it('uses the active item seat fact instead of a role-card fact from another topic', () => {
    scenario.agenda[0]!.seatFacts = { operations_director: 'Current topic fact' };
    mocks.useKaki.mockReturnValue(withSpeech({ events: events.filter((event) => event.type !== 'FACT_FOUND'),
      tasks: new Map(), connected: true, rejection: null, send: vi.fn() }));
    try {
      render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);
      expect(screen.getByText('Current topic fact')).toBeTruthy();
      expect(within(screen.getByLabelText('Current topic context')).queryByText(roleFact)).toBeNull();
    } finally {
      scenario.agenda[0]!.seatFacts = { operations_director: roleFact };
    }
  });

  it('shows one current-topic surface and drops the company fact that repeats the role card', () => {
    render(
      <MeetingPanel
        viewer={{ name: 'Joshua', seatName: 'Wei Ling' }}
        role={scenario.roles[0]}
      />,
    );

    expect(screen.getAllByLabelText('Current topic context')).toHaveLength(1);
    expect(screen.queryByLabelText('From the company records')).toBeNull();
    expect(screen.getAllByText(duplicateFact)).toHaveLength(1);
    expect(screen.getByText(distinctFact)).toBeTruthy();
  });

  it('keeps the topic-2 Wingman surface after more than 50 events since the topic changed', () => {
    const topicFact = 'The third topic fact the visitor can share.';
    mocks.useScenario.mockReturnValue({
      ...scenario,
      agenda: [
        scenario.agenda[0]!,
        { title: 'Second topic', minutes: 4, canWait: false, deadline: 'before lunch', ownerRole: 'tech_pos_lead' },
        {
          title: 'Third topic',
          minutes: 4,
          canWait: false,
          deadline: 'before close',
          ownerRole: 'tech_pos_lead',
          seatFacts: { operations_director: topicFact },
        },
      ],
    });

    const briefingLine = (text: string): KakiEvent => ({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: 'Wei Ling', text, timestamp: '2026-11-07T10:05:00Z', speakerRole: 'operations_director' },
    });
    const topicTwo: KakiEvent = {
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: { agendaIndex: 2, openQuestions: [], elapsedSeconds: 0, speakerTalkSeconds: {} },
    };

    mocks.useKaki.mockReturnValue(withSpeech({
      events: [topicTwo, briefingLine('Here is my stance on the third topic.')],
      tasks: new Map(), connected: true, rejection: null, send: vi.fn(),
    }));
    const view = render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);
    expect(screen.getByLabelText('Current topic context')).toBeTruthy();

    const laterEvents: KakiEvent[] = [
      ...Array.from({ length: 60 }, (_, index): KakiEvent => ({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Arjun', text: `filler ${index}`, timestamp: '2026-11-07T10:06:00Z' },
      })),
      briefingLine('Still speaking on the same topic.'),
    ];
    mocks.useKaki.mockReturnValue(withSpeech({
      events: laterEvents,
      tasks: new Map(), connected: true, rejection: null, send: vi.fn(),
    }, 2));
    view.rerender(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} role={scenario.roles[0]} />);

    expect(screen.getByLabelText('Current topic context')).toBeTruthy();
    expect(screen.getByText(topicFact)).toBeTruthy();
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
