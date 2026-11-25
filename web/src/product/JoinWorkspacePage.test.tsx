/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { JoinWorkspacePage } from './JoinWorkspacePage';

const mocks = vi.hoisted(() => ({
  state: {
    status: 'ready',
    me: {
      authEnabled: true,
      kind: 'user',
      user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    },
  } as MeState,
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

function Probe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/join-workspace/invite-token']}>
      <Routes>
        <Route path="/join-workspace/:token" element={<JoinWorkspacePage />} />
        <Route path="/signin" element={<Probe />} />
        <Route path="/workspaces/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.state = {
    status: 'ready',
    me: {
      authEnabled: true,
      kind: 'user',
      user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    },
  };
});

describe('JoinWorkspacePage', () => {
  it('sends a signed-out visitor to sign in without asking for protected data', async () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
    const fetchMock = installFetch({});
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/signin?next=%2Fjoin-workspace%2Finvite-token',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins the workspace for a signed-in person', async () => {
    const fetchMock = installFetch({
      'POST /api/workspace-invites/invite-token': () =>
        reply({ id: 'ws-1', name: 'Team workspace', kind: 'team', role: 'member' }),
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/workspaces/ws-1'),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace-invites/invite-token',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
