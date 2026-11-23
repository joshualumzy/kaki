/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  meetingId: undefined as string | undefined,
}));

vi.mock('../kaki', () => ({
  MeetingScopeProvider: ({ meetingId, children }: { meetingId?: string; children: ReactNode }) => {
    mocks.meetingId = meetingId;
    return <>{children}</>;
  },
  ScenarioProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./room/Meeting', () => ({
  default: ({ practiceMeetingId, signedIn, onNewPractice }: { practiceMeetingId?: string; signedIn?: boolean; onNewPractice?: () => void }) => (
    <div>
      <div data-testid="practice-room">{practiceMeetingId}</div>
      <div data-testid="practice-signed-in">{signedIn === true ? 'signed-in' : 'signed-out'}</div>
      {onNewPractice === undefined ? null : (
        <button type="button" onClick={onNewPractice}>
          Start a new practice
        </button>
      )}
    </div>
  ),
}));

let PracticePage: typeof import('./PracticePage').PracticePage;

beforeEach(async () => {
  vi.resetModules();
  mocks.meetingId = undefined;
  PracticePage = (await import('./PracticePage')).PracticePage;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('PracticePage', () => {
  it('asks the server for this visitor’s practice, then uses that meeting id', async () => {
    const fetchMock = vi.fn(async () => reply(200, { meetingId: 'practice-1' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PracticePage />);

    expect(await screen.findByTestId('practice-room')).toHaveProperty('textContent', 'practice-1');
    expect(mocks.meetingId).toBe('practice-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/practice', { method: 'POST' });
  });

  it('passes the sign-in state so a signed-in practice can keep its minutes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { meetingId: 'practice-1', signedIn: true })));

    render(<PracticePage />);

    expect(await screen.findByTestId('practice-signed-in')).toHaveProperty('textContent', 'signed-in');
  });

  it('opens a fresh practice from the room once the old one has ended, without a page load', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { meetingId: 'practice-1' }))
      .mockResolvedValueOnce(reply(200, { meetingId: 'practice-2' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PracticePage />);

    expect(await screen.findByTestId('practice-room')).toHaveProperty('textContent', 'practice-1');
    fireEvent.click(screen.getByRole('button', { name: 'Start a new practice' }));

    await waitFor(() =>
      expect(screen.getByTestId('practice-room')).toHaveProperty('textContent', 'practice-2'),
    );
    expect(mocks.meetingId).toBe('practice-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/practice', { method: 'POST' });
  });

  it('shows the plain practice-full sentence with a Retry that asks again', async () => {
    const message = 'All practice rooms are in use right now. Please try again in a few minutes.';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(503, { error: 'practice-full', message }))
      .mockResolvedValueOnce(reply(200, { meetingId: 'practice-2' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PracticePage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveProperty('textContent', message);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('practice-room')).toHaveProperty('textContent', 'practice-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the plain rate-limit sentence with a Retry that asks again', async () => {
    const message = 'Too many practice rooms were opened from here. Try again in a minute.';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, { error: message }))
      .mockResolvedValueOnce(reply(200, { meetingId: 'practice-3' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<PracticePage />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', message);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('practice-room')).toHaveProperty('textContent', 'practice-3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never shows a raw error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(503, { error: 'practice-full' })),
    );

    render(<PracticePage />);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'All practice rooms are in use right now. Please try again in a few minutes.',
    );
  });
});
