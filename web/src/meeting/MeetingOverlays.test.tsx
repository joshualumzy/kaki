/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { OwnerLobby, WaitingOverlay } from './MeetingOverlays';

const scenario: Scenario = {
  id: 'lobby-test',
  organisation: 'Test',
  meetingTitle: 'Launch',
  roles: [
    { id: 'producer', label: 'Producer' },
    { id: 'marketing_lead', label: 'Marketing Lead' },
  ],
  attendees: [],
  agenda: [],
};

vi.mock('../kaki', () => ({ useScenario: () => scenario }));

vi.mock('qrcode', () => ({ toString: vi.fn(async () => '<svg />') }));

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(routes: Record<string, () => unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const handler = routes[url];
    if (handler === undefined) throw new Error(`Unexpected fetch: ${url}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WaitingOverlay', () => {
  it('waits without offering a Start button or the story', () => {
    render(<WaitingOverlay />);
    expect(screen.getByText('Waiting for the meeting owner to start')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
    expect(screen.queryByText(/How to play/)).toBeNull();
    expect(screen.queryByText(/Kopitiam/)).toBeNull();
  });

  it("shows the owner's meeting title while the participant waits", () => {
    render(<WaitingOverlay meetingTitle="Team playtest meeting" />);
    expect(screen.getByText('Team playtest meeting')).toBeTruthy();
  });
});

describe('OwnerLobby', () => {
  it('shows the invite link, code, who joined, copy and the one Start button', async () => {
    const onStarted = vi.fn();
    installFetch({
      '/api/meeting-code': () => reply({ code: 'K7QX' }),
      '/api/meeting/state': () => reply({ started: false }),
      '/api/meeting/participants': () => reply({ participants: [{ name: 'Ada', seat: 'producer' }] }),
      '/api/meeting/start': () => reply({ started: true }),
    });
    render(<OwnerLobby initialCode="K7QX" onStarted={onStarted} />);

    const link = await screen.findByRole('link', { name: /\/join\?code=K7QX/ });
    expect(link.getAttribute('href')).toMatch(/\/join\?code=K7QX$/);
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('Meeting code:')).toBeTruthy();
    const qr = await screen.findByAltText('QR code for the meeting');
    expect(qr.getAttribute('src')).toContain('data:image/svg+xml');

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link.getAttribute('href')));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });

  it('still shows who joined when the meeting-code read fails', async () => {
    installFetch({
      '/api/meeting-code': () => reply({ error: 'Not found' }, 404),
      '/api/meeting/state': () => reply({ started: false }),
      '/api/meeting/participants': () => reply({ participants: [{ name: 'Ada', seat: 'producer' }] }),
    });
    render(<OwnerLobby initialCode="K7QX" onStarted={vi.fn()} />);

    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByRole('link', { name: /\/join\?code=K7QX/ })).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows a plain error and retries the lobby read', async () => {
    let attempts = 0;
    installFetch({
      '/api/meeting-code': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Could not reach the server.');
        return reply({ code: 'K7QX' });
      },
      '/api/meeting/state': () => reply({ started: false }),
      '/api/meeting/participants': () => reply({ participants: [] }),
    });
    render(<OwnerLobby initialCode="K7QX" onStarted={vi.fn()} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /\/join\?code=K7QX/ })).toBeTruthy();
    expect(attempts).toBe(2);
  });
});
