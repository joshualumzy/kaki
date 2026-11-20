/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { SituationCard } from './SituationCard';

afterEach(cleanup);

const scenario = {
  id: 's',
  organisation: 'Nanyang Kopi & Toast',
  meetingTitle: 'Raffles Place launch readiness',
  roles: [{ id: 'operations_director', label: 'Producer' }],
  attendees: [{ name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' }],
  agenda: [],
  situation: 'The launch is tomorrow morning.',
} as unknown as Scenario;

describe('SituationCard', () => {
  it('shows the situation and who is in the room', () => {
    render(<SituationCard scenario={scenario} />);
    expect(screen.getByText('The launch is tomorrow morning.')).toBeTruthy();
    expect(screen.getByText('Wei Ling, Producer')).toBeTruthy();
  });

  it('shows nothing when the scenario has no situation', () => {
    const { container } = render(<SituationCard scenario={{ ...scenario, situation: undefined }} />);
    expect(container.textContent).toBe('');
  });

  it('splits multi-line situation text into separate paragraphs', () => {
    render(<SituationCard scenario={{ ...scenario, situation: 'Intro line.\n(1) First issue.\n(2) Second issue.' }} />);
    expect(screen.getByText('Intro line.')).toBeTruthy();
    expect(screen.getByText('(1) First issue.')).toBeTruthy();
    expect(screen.getByText('(2) Second issue.')).toBeTruthy();
  });

  it('replaces the scripted attendee name with the visitor name for their role', () => {
    render(<SituationCard scenario={scenario} viewerName="Yoo" viewerRoleId="operations_director" />);
    expect(screen.getByText('Yoo (you), Producer')).toBeTruthy();
    expect(screen.queryByText('Wei Ling, Producer')).toBeNull();
  });
});
