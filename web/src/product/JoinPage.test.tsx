/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { JoinPage } from './JoinPage';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', me: { authEnabled: true, kind: null } } as MeState,
}));

vi.mock('../auth/useMe', () => ({ useMe: () => mocks.state }));

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function installFetch(routes: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const handler = routes[`${init?.method ?? 'GET'} ${url}`];
    if (handler === undefined) throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPage(id = 'mtg-1'): void {
  render(
    <MemoryRouter initialEntries={[`/m/${id}`]}>
      <Routes>
        <Route path="/m/:id/room" element={<LocationProbe />} />
        <Route path="/m/:id" element={<JoinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function scheduledInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Weekly sync',
    workspaceName: 'Nanyang Kopi (sample)',
    scheduledFor: '2999-01-01T02:00:00.000Z',
    status: 'scheduled',
    ownerName: 'Ada Lovelace',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
});

describe('JoinPage', () => {
  it('shows the planned time and the recording notice before the join button', async () => {
    installFetch({
      'GET /api/meetings/mtg-1/info': () => reply(scheduledInfo()),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly sync' })).toBeTruthy();
    expect(
      screen.getByText(/This meeting is planned for .*\. You can join early\./),
    ).toBeTruthy();

    const notice = screen.getByText('Kaki transcribes this meeting');
    const joinButton = screen.getByRole('button', { name: 'Join meeting' });
    expect(
      notice.compareDocumentPosition(joinButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('joins a visitor by name and goes on to the room', async () => {
    const fetchMock = installFetch({
      'GET /api/meetings/mtg-1/info': () => reply(scheduledInfo()),
      'POST /api/meetings/mtg-1/join': () => reply({ ok: true, name: 'Sam' }),
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join meeting' }));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/m/mtg-1/room'),
    );
    const joinCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/meetings/mtg-1/join' && init?.method === 'POST',
    );
    expect(JSON.parse(String(joinCall?.[1]?.body))).toEqual({ name: 'Sam' });
  });

  it('joins a signed-in person under their Google name without a form', async () => {
    mocks.state = {
      status: 'ready',
      me: {
        authEnabled: true,
        kind: 'user',
        user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
      },
    };
    installFetch({
      'GET /api/meetings/mtg-1/info': () => reply(scheduledInfo()),
      'POST /api/meetings/mtg-1/join': () => reply({ ok: true, name: 'Ada Lovelace' }),
    });
    renderPage();

    expect(await screen.findByText('You will join as Ada Lovelace.')).toBeTruthy();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Join meeting' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/m/mtg-1/room'),
    );
  });

  it('remembers the invite code from the link for the room', async () => {
    installFetch({
      'GET /api/meetings/mtg-1/info': () => reply(scheduledInfo()),
    });
    render(
      <MemoryRouter initialEntries={['/m/mtg-1?code=K7QX']}>
        <Routes>
          <Route path="/m/:id" element={<JoinPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Weekly sync' });
    expect(JSON.parse(String(window.sessionStorage.getItem('kaki.real.mtg-1')))).toMatchObject({
      code: 'K7QX',
    });
  });

  it('shows a plain page for an unknown link', async () => {
    installFetch({
      'GET /api/meetings/nope/info': () => reply({ error: 'meeting-not-found' }, 404),
    });
    renderPage('nope');

    expect(await screen.findByRole('heading', { name: "This meeting link isn't valid" })).toBeTruthy();
    expect(screen.queryByText('Loading this meeting…')).toBeNull();
  });

  it('says an ended meeting is over instead of inviting a guest to join', async () => {
    installFetch({
      'GET /api/meetings/mtg-1/info': () =>
        reply(
          scheduledInfo({
            scheduledFor: null,
            status: 'ended',
            historyWorkspaceId: null,
          }),
        ),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'This meeting has ended' })).toBeTruthy();
    expect(screen.getByText('Ask the meeting owner for the minutes.')).toBeTruthy();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join meeting' })).toBeNull();
  });

  it('gives a member a link to the notes of an ended meeting', async () => {
    installFetch({
      'GET /api/meetings/mtg-1/info': () =>
        reply(
          scheduledInfo({
            scheduledFor: null,
            status: 'ended',
            historyWorkspaceId: 'ws-1',
          }),
        ),
    });
    renderPage();

    const link = await screen.findByRole('link', { name: 'Read the meeting notes' });
    expect(link.getAttribute('href')).toBe('/workspaces/ws-1/meetings/mtg-1');
    expect(screen.queryByLabelText('Your name')).toBeNull();
  });

  it('does not show a planned time for a meeting that is open now', async () => {
    installFetch({
      'GET /api/meetings/mtg-1/info': () =>
        reply(scheduledInfo({ scheduledFor: null, status: 'open' })),
    });
    renderPage();

    await screen.findByRole('heading', { name: 'Weekly sync' });
    expect(screen.queryByText(/This meeting is planned for/)).toBeNull();
    expect(screen.getByText('Kaki transcribes this meeting')).toBeTruthy();
  });
});
