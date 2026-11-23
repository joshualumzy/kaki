/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { HostCueCard } from './HostCueCard';

afterEach(cleanup);

const realMeeting = {
  id: 'real-m',
  meetingTitle: 'Raffles Place opening week',
  roles: [
    { id: 'everyone', label: 'Everyone' },
    { id: 'person_owner', label: 'Owner', facilitator: true },
    { id: 'person_arjun', label: 'Arjun Rao' },
  ],
  attendees: [
    { name: 'Wei Ling Tan', role: 'person_owner', displayName: 'Wei Ling Tan' },
    { name: 'Arjun Rao', role: 'person_arjun', displayName: 'Arjun Rao' },
  ],
  agenda: [{ title: 'Breakfast seat crunch', minutes: 10, canWait: true, deadline: 'today', ownerRole: 'everyone' }],
} as unknown as Scenario;

const namedRole = {
  ...realMeeting,
  roles: [
    { id: 'everyone', label: 'Everyone' },
    { id: 'person_owner', label: 'Owner', facilitator: true },
    { id: 'person_arjun', label: 'Tech & POS Lead' },
  ],
} as unknown as Scenario;

describe('HostCueCard', () => {
  it('shows a person whose role label is their own name only once', () => {
    render(<HostCueCard scenario={realMeeting} agendaIndex={0} started />);
    expect(screen.getByText(/Tip: Arjun Rao will help co-host/)).toBeTruthy();
    expect(screen.queryByText(/Arjun Rao \(Arjun Rao\)/)).toBeNull();
  });

  it('keeps the bracketed role when it adds meaning beyond the name', () => {
    render(<HostCueCard scenario={namedRole} agendaIndex={0} started />);
    expect(screen.getByText(/Tip: Arjun Rao \(Tech & POS Lead\) will help co-host/)).toBeTruthy();
  });
});
