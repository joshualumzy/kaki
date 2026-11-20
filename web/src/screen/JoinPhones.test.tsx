/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('refuses to show join links without a meeting code, then retries', async () => {
    let codeResponse = json({ error: 'Could not read the meeting code' }, 500);
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/join-info' ? json({ baseUrl: 'http://kaki.local' }) : codeResponse,
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<JoinPhones meetingId="meeting-a" />);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not read the meeting code'),
    );
    expect(screen.queryByText('Chef')).toBeNull();

    codeResponse = json({ code: 'NEW2' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('NEW2')).toBeTruthy());
    expect(
      screen.getByText('http://kaki.local/phone?role=chef&code=NEW2'),
    ).toBeTruthy();
  });

  it('rejects a malformed meeting-code answer', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/join-info' ? json({ baseUrl: 'http://kaki.local' }) : json({ code: '   ' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<JoinPhones meetingId="meeting-a" />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no meeting code'));
    expect(screen.queryByText('Chef')).toBeNull();
  });

  it('gives up with an error and a retry when the requests never answer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<JoinPhones meetingId="meeting-a" />);
    expect(screen.getByText(/Finding this screen/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByRole('alert').textContent).toContain('did not answer in time');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
