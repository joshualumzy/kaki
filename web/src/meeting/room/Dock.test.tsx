/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dock } from './Dock';

vi.mock('../../kaki', () => ({
  useScenario: () => ({ meetingTitle: 'Weekly sync' }),
}));

vi.mock('./ActiveRoleCards', () => ({
  ActiveRoleCards: () => <div data-testid="active-role-cards" />,
}));

vi.mock('./MeetingPanel', () => ({
  MeetingPanel: () => <div data-testid="meeting-panel" />,
}));

afterEach(cleanup);

describe('Dock', () => {
  it('labels the meeting code in plain words', () => {
    render(
      <Dock
        role={undefined}
        viewer={{ name: 'Ana', seatName: 'Ana' }}
        meetingId="mtg-1"
        meetingCode="CNXUPP"
      />,
    );

    expect(screen.getByLabelText('Meeting code').textContent).toBe('Join code: CNXUPP');
  });
});
