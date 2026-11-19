/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scenario = {
  id: 'test-kitchen',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service readiness',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'manager', label: 'Manager' },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
    { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy (Manager)' },
  ],
  agenda: [],
  npcs: [
    {
      attendee: 'Cy',
      voice: 'test-voice',
      personality: 'Quiet until asked.',
      agenda: 'Keep the kitchen running.',
      concerns: [],
    },
  ],
};

vi.mock('../kaki', () => ({
  useScenario: () => scenario,
}));

vi.mock('qrcode', () => ({
  toString: vi.fn(async () => '<svg />'),
}));

import { JoinPhones } from './JoinPhones';

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('join phones card', () => {
  it('re-fetches the meeting code and QR links when the meeting changes', async () => {
    let code = 'OLD1';
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/join-info' ? json({ baseUrl: 'http://kaki.local' }) : json({ code }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<JoinPhones meetingId="meeting-a" />);
    await waitFor(() => expect(screen.getByText('OLD1')).toBeTruthy());
    expect(screen.queryByText('Manager')).toBeNull();

    code = 'NEW2';
    rerender(<JoinPhones meetingId="meeting-b" />);

    await waitFor(() => expect(screen.getByText('NEW2')).toBeTruthy());
    expect(screen.queryByText('OLD1')).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/meeting-code')).toHaveLength(2);
  });
});
