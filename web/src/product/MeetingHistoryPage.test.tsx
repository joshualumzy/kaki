/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MeetingHistoryPage', () => {
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
          minutes: '# Weekly planning\n\nWe agreed the rota.',
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
    expect(screen.getByText(/We agreed the rota/)).toBeTruthy();
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
          minutes: '# Weekly planning',
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
});
