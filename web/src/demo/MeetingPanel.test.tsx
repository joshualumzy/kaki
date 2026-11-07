/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';

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
});
