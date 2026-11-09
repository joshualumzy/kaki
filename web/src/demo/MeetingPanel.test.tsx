/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario, Task } from '@kaki/shared';

const mocks = vi.hoisted(() => ({
  useKaki: vi.fn(),
  useScenario: vi.fn(),
}));

vi.mock('../kaki', () => ({
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
      id: 'producer',
      label: 'Operations Director',
      card: { youAre: 'You run the floor.', facts: [roleFact], responsibility: 'Keep the floor running.' },
    },
    { id: 'lead_programmer', label: 'Tech & POS Lead' },
  ],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [
    {
      title: 'Elderly regulars turned away at cashless kiosks',
      minutes: 4,
      ownerRole: 'producer',
      decision: 'how do we take cash without putting a coin drawer at the counter?',
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
      openQuestions: [{ id: 'q-cash', text: 'How do we take cash?', forRole: 'producer' }],
      elapsedSeconds: 5,
      speakerTalkSeconds: {},
    },
  },
  {
    type: 'FACT_FOUND',
    audience: { kind: 'role', role: 'producer' },
    payload: {
      questionId: 'q-cash',
      question: 'How do we take cash?',
      facts: [
        { text: duplicateFact, source: 'gitea ticket', date: '2026-11-06' },
        { text: distinctFact, source: 'wiki SOP', date: '2026-11-06' },
      ],
    },
  },
];

beforeEach(() => {
  mocks.useScenario.mockReturnValue(scenario);
  mocks.useKaki.mockReturnValue({
    events,
    tasks: new Map(),
    connected: true,
    rejection: null,
    send: vi.fn(),
  });
});

afterEach(cleanup);

describe('MeetingPanel', () => {
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

  it('shows the accepted decision on a task card', () => {
    const decision = 'We will move the cash box away from the food prep area and count the float every night.';
    const task: Task = {
      id: 'task-1',
      title: 'Post the cash box decision in the team channel',
      context: 'Announce the cash box move.',
      decisionSource: decision,
      suggestedAssignee: 'producer',
      assignee: 'producer',
      actionKind: 'mattermost_post',
      status: 'DISPATCHED',
      updatedAt: '2026-11-08T10:00:00Z',
    };
    mocks.useKaki.mockReturnValue({
      events: [],
      tasks: new Map([[task.id, task]]),
      connected: true,
      rejection: null,
      send: vi.fn(),
    });

    render(<MeetingPanel viewer={{ name: 'Joshua', seatName: 'Wei Ling' }} />);

    expect(
      screen.getByText((_, element) => element?.textContent === `Accepted decision: ${decision}`),
    ).toBeTruthy();
  });

  it('progressively reveals colleague trade-off cards without spoiling them upfront', () => {
    const scenarioWithTradeOffs: Scenario = {
      ...scenario,
      agenda: [
        {
          title: 'Butter slice review',
          minutes: 4,
          ownerRole: 'lead_programmer',
          decision: 'how do we fix the butter slice?',
          discussion: {
            openingViews: [],
            tradeOffs: [
              {
                attendee: 'Daniel',
                role: 'marketing_lead',
                tradeOff: 'Zack video has 90k views calling butter transparent',
                question: 'What do we show on camera?',
              },
              {
                attendee: 'Mei',
                role: 'game_designer',
                tradeOff: 'Takeaway steam melts butter flat; doubling costs $1100',
                question: 'What do we change?',
              },
            ],
          },
        },
      ],
    };
    mocks.useScenario.mockReturnValue(scenarioWithTradeOffs);

    // Initial state: meeting started and welcoming finished (elapsed 25s), but neither Daniel nor Mei has spoken yet
    mocks.useKaki.mockReturnValue({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 25, speakerTalkSeconds: {} },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    });

    const { rerender } = render(
      <MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />,
    );

    // No spoilers before anyone speaks!
    expect(screen.getByText("Listening to the team's opening points…")).toBeTruthy();
    expect(screen.queryByText('Zack video has 90k views calling butter transparent')).toBeNull();
    expect(screen.queryByText('Takeaway steam melts butter flat; doubling costs $1100')).toBeNull();

    // Daniel speaks
    mocks.useKaki.mockReturnValue({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 5, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Zack posted a video calling our butter transparent.', timestamp: '2026-11-08T10:00:05Z' },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    });

    rerender(<MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />);

    // Daniel's card is now revealed, Mei's is still hidden!
    expect(screen.getByText('Zack video has 90k views calling butter transparent')).toBeTruthy();
    expect(screen.queryByText('Takeaway steam melts butter flat; doubling costs $1100')).toBeNull();

    // Mei speaks
    mocks.useKaki.mockReturnValue({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 8, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Zack posted a video calling our butter transparent.', timestamp: '2026-11-08T10:00:05Z' },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Mei', text: 'Zack bought takeaway toast; the steam melted the butter flat.', timestamp: '2026-11-08T10:00:08Z' },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    });

    rerender(<MeetingPanel viewer={{ name: 'Visitor', seatName: 'Visitor' }} role={undefined} />);

    // Now both cards are revealed!
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
          ownerRole: 'lead_programmer',
          decision: 'how do we fix the butter slice?',
          discussion: {
            openingViews: [],
            tradeOffs: [
              {
                attendee: 'Wei Ling',
                role: 'producer',
                tradeOff: 'Margin limit: Remaining launch budget is capped at $750',
                question: 'What can we spend?',
              },
              {
                attendee: 'Daniel',
                role: 'marketing_lead',
                tradeOff: 'Viral roast: Video has 90k views',
                question: 'What do we show?',
              },
            ],
          },
        },
      ],
    };
    mocks.useScenario.mockReturnValue(scenarioWithVisitorTradeOff);

    // Visitor joined as Operations Director (role: producer, name: Foo)
    // Daniel and "Wei Ling" both have transcript chunks
    mocks.useKaki.mockReturnValue({
      events: [
        {
          type: 'MEETING_RECORD_UPDATED',
          audience: { kind: 'all' },
          payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 30, speakerTalkSeconds: {} },
        },
        {
          type: 'TRANSCRIPT_CHUNK',
          audience: { kind: 'all' },
          payload: { speaker: 'Daniel', text: 'Zack posted a video.', timestamp: '2026-11-08T10:00:05Z' },
        },
      ],
      tasks: new Map(),
      connected: true,
      rejection: null,
      send: vi.fn(),
    });

    render(
      <MeetingPanel
        viewer={{ name: 'Foo', seatName: 'Wei Ling' }}
        role={scenario.roles[0]} // producer
      />,
    );

    // Daniel's card is in the standoff list with headline bolded
    expect(screen.getByText('Viral roast:')).toBeTruthy();
    expect(screen.getByText('Video has 90k views')).toBeTruthy();

    // The phantom "Wei Ling" card MUST NOT be in the standoff list!
    expect(screen.queryByText('Margin limit:')).toBeNull();
    expect(screen.queryByText('Remaining launch budget is capped at $750')).toBeNull();
  });
});
