/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { MeetingHistoryPage } from './MeetingHistoryPage';

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

const workspaces = [{ id: 'ws-1', name: 'Team workspace', kind: 'team', role: 'admin' }];

const workspace = {
  id: 'ws-1',
  name: 'Team workspace',
  readOnly: false,
  people: [],
  tools: [{ kind: 'mattermost', connected: false, settings: {}, lastOkAt: null }],
  meetings: [],
  counts: { meetings: 1, todos: 1, records: 0 },
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/workspaces/ws-1/meetings/mtg-1']}>
      <Routes>
        <Route path="/workspaces/:id/meetings/:meetingId" element={<MeetingHistoryPage />} />
        <Route path="/workspaces/:id" element={<p>workspace</p>} />
        <Route path="/signin" element={<SignInProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function SignInProbe() {
  const location = useLocation();
  return (
    <>
      <p>sign in</p>
      <p data-testid="location">{`${location.pathname}${location.search}`}</p>
    </>
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

describe('MeetingHistoryPage', () => {
  it('sends a signed-out visitor to sign in without asking for protected data', async () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
    const fetchMock = installFetch({});
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/signin?next=%2Fworkspaces%2Fws-1%2Fmeetings%2Fmtg-1',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('centres the meeting not found card with its way back', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({ error: 'Not found' }, 404),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Meeting not found' })).toBeTruthy();
    expect(document.querySelector('main')?.classList.contains('product-not-found')).toBe(true);
    expect(
      screen.getByRole('link', { name: 'Back to the workspace' }).getAttribute('href'),
    ).toBe('/workspaces/ws-1');
  });

  it('shows Kaki’s own minutes and to-dos, and lets the owner tick one done', async () => {
    const toggles: Array<{ url: string; body: unknown }> = [];
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Decisions\n\n**We agreed** the rota.',
          todos: [{ id: 'task-1', title: 'Update the rota', owner: 'Chef', status: 'SUGGESTED', done: false }],
          canEdit: true,
        }),
      'POST /api/workspaces/ws-1/meetings/mtg-1/todos/task-1': (init) => {
        toggles.push({ url: 'task-1', body: JSON.parse(String(init?.body)) });
        return reply({
          todos: [{ id: 'task-1', title: 'Update the rota', owner: 'Chef', status: 'SUGGESTED', done: true }],
        });
      },
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Decisions' }).tagName).toBe('H2');
    expect(screen.getByText('We agreed').tagName).toBe('STRONG');
    expect(screen.queryByText(/^##/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download markdown' })).toBeTruthy();
    expect(screen.getByText(/No tool is connected here/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(toggles).toEqual([{ url: 'task-1', body: { done: true } }]));
  });

  it('shows the minutes read-only when the viewer is not the owner or an admin', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Notes',
          todos: [{ id: 'task-1', title: 'Update the rota', owner: 'Chef', status: 'SUGGESTED', done: false }],
          canEdit: false,
        }),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Only the meeting owner or a workspace admin/)).toBeTruthy();
  });

  it('says plainly that the minutes are still being prepared', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: null,
          todos: [],
          canEdit: true,
        }),
    });
    renderPage();

    expect(await screen.findByText(/minutes are still being prepared/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('lets the owner approve and publish the minutes, then shows the published link', async () => {
    const publishes: string[] = [];
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Decisions\n\n**We agreed** the rota.',
          todos: [],
          canEdit: true,
          wikiConnected: true,
          publish: null,
        }),
      'POST /api/workspaces/ws-1/meetings/mtg-1/minutes/publish': () => {
        publishes.push('publish');
        return reply({
          publish: { status: 'published', artifactUrl: 'https://wiki.example/en/meetings/2026-11-20-weekly-planning' },
        });
      },
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & publish' }));

    await waitFor(() => expect(publishes).toEqual(['publish']));
    const link = await screen.findByRole('link', { name: /Open in Wiki/ });
    expect(link.getAttribute('href')).toBe(
      'https://wiki.example/en/meetings/2026-11-20-weekly-planning',
    );
    expect(screen.queryByRole('button', { name: 'Approve & publish' })).toBeNull();
  });

  it('keeps the published state and link from the server after a reload', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Decisions',
          todos: [],
          canEdit: true,
          wikiConnected: true,
          publish: {
            status: 'published',
            artifactUrl: 'https://wiki.example/en/meetings/2026-11-20-weekly-planning',
          },
        }),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Wiki/ }).getAttribute('href')).toBe(
      'https://wiki.example/en/meetings/2026-11-20-weekly-planning',
    );
    expect(screen.queryByRole('button', { name: 'Approve & publish' })).toBeNull();
  });

  it('says plainly when no wiki is connected instead of offering to publish', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Decisions',
          todos: [],
          canEdit: true,
          wikiConnected: false,
          publish: null,
        }),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    expect(screen.getByText(/No wiki is connected in this workspace/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve & publish' })).toBeNull();
  });

  it('shows why publishing failed and offers a retry', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () => reply(workspace),
      'GET /api/workspaces/ws-1/meetings/mtg-1/minutes': () =>
        reply({
          id: 'mtg-1',
          title: 'Weekly planning',
          date: '2026-11-20T10:00:00.000Z',
          minutes: '## Decisions',
          todos: [],
          canEdit: true,
          wikiConnected: true,
          publish: { status: 'failed', error: 'The wiki rejected the login.' },
        }),
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('The wiki rejected the login.');
    expect(screen.getByRole('button', { name: 'Retry publishing' })).toBeTruthy();
  });
});
