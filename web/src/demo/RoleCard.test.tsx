/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleCard } from './RoleCard';

afterEach(cleanup);

describe('RoleCard', () => {
  it('shows who you are, what you know and what you answer for', () => {
    render(
      <RoleCard
        role={{
          id: 'producer',
          label: 'Producer',
          card: { youAre: 'You are Wei Ling.', facts: ['The build crashes.', 'The deadline moved.'], responsibility: 'You decide what ships.' },
        }}
        agenda={[{ title: 'Build', minutes: 5, ownerRole: 'producer', seatFacts: { producer: 'The build crashes.' } },
          { title: 'Deadline', minutes: 5, ownerRole: 'producer', seatFacts: { producer: 'The deadline moved.' } }]}
      />,
    );
    expect(screen.getByLabelText('Your role: Producer')).toBeTruthy();
    expect(screen.getByText('You are Wei Ling.')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['The build crashes.', 'The deadline moved.']);
    expect(screen.getByText(/You decide what ships/)).toBeTruthy();
  });

  it('shows nothing for a role without a card', () => {
    const { container } = render(<RoleCard role={{ id: 'chef', label: 'Chef' }} />);
    expect(container.textContent).toBe('');
  });

  it('replaces the seat character name in youAre with the visitor name', () => {
    render(
      <RoleCard
        role={{
          id: 'producer',
          label: 'Producer',
          card: { youAre: 'You are Wei Ling, the producer.', facts: ['Fact.'], responsibility: 'You decide.' },
        }}
        viewerName="Yoo"
        seatName="Wei Ling"
      />,
    );
    expect(screen.getByText('You are Yoo, the producer.')).toBeTruthy();
  });

  it('shows only seat facts from the selected meeting items', () => {
    render(<RoleCard
      role={{ id: 'producer', label: 'Director', card: {
        youAre: 'You lead operations.', responsibility: 'Keep the floor running.', facts: ['Foreign topic fact'],
      } }}
      agenda={[{ title: 'Current', minutes: 5, ownerRole: 'producer',
        seatFacts: { producer: 'Current seat fact' } }]}
    />);
    expect(screen.getByText('Current seat fact')).toBeTruthy();
    expect(screen.queryByText('Foreign topic fact')).toBeNull();
  });

  it('does not show a role-card fact when the selected items have no fact for that role', () => {
    render(<RoleCard role={{ id: 'producer', label: 'Director', card: {
      youAre: 'You lead operations.', responsibility: 'Keep the floor running.', facts: ['Foreign topic fact'],
    } }} agenda={[{ title: 'Current', minutes: 5, ownerRole: 'cashier', seatFacts: { cashier: 'Another fact' } }]} />);
    expect(screen.queryByText('Foreign topic fact')).toBeNull();
  });
});
