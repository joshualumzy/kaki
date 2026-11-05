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
  organisation: 'Lah Studios',
  meetingTitle: 'Launch readiness',
  roles: [{ id: 'producer', label: 'Producer' }],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [],
  situation: 'The game still crashes.',
} as unknown as Scenario;

describe('SituationCard', () => {
  it('shows the situation and who is in the room', () => {
    render(<SituationCard scenario={scenario} />);
    expect(screen.getByText('The game still crashes.')).toBeTruthy();
    expect(screen.getByText('Wei Ling, Producer')).toBeTruthy();
  });

  it('shows nothing when the scenario has no situation', () => {
    const { container } = render(<SituationCard scenario={{ ...scenario, situation: undefined }} />);
    expect(container.textContent).toBe('');
  });
});
