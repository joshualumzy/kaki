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
          id: 'operations_director',
          label: 'Producer',
          card: { youAre: 'You are Wei Ling.', facts: ['The build crashes.', 'The deadline moved.'], responsibility: 'You decide what ships.' },
        }}
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
          id: 'operations_director',
          label: 'Producer',
          card: { youAre: 'You are Wei Ling, the operations_director.', facts: ['Fact.'], responsibility: 'You decide.' },
        }}
        viewerName="Yoo"
        seatName="Wei Ling"
      />,
    );
    expect(screen.getByText('You are Yoo, the operations_director.')).toBeTruthy();
  });

  it('shows the role card own facts and no agenda-driven facts', () => {
    render(<RoleCard role={{ id: 'operations_director', label: 'Director', card: {
      youAre: 'You lead operations.', responsibility: 'Keep the floor running.', facts: ['The build crashes.'],
    } }} />);
    expect(screen.getByText('The build crashes.')).toBeTruthy();
    expect(screen.getByText(/You lead operations/)).toBeTruthy();
  });

  it('shows no facts list when the role card has none', () => {
    render(<RoleCard role={{ id: 'operations_director', label: 'Director', card: {
      youAre: 'You lead operations.', responsibility: 'Keep the floor running.', facts: [],
    } }} />);
    expect(screen.queryByText('What you know')).toBeNull();
  });
});
