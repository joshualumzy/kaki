/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { WorkspacePage } from './WorkspacePage';

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

type Handler = () => Response | Promise<Response>;

function installFetch(routes: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const handler = routes[`${init?.method ?? 'GET'} ${url}`];
    if (handler === undefined) throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const workspaces = [
  { id: 'ws-1', name: 'Team workspace', kind: 'team', role: 'admin' },
  { id: 'sample-nanyang-kopi', name: 'Nanyang Kopi (sample)', kind: 'sample', role: 'member' },
];

function renderPage(id: string): void {
  render(
    <MemoryRouter initialEntries={[`/workspaces/${id}`]}>
      <Routes>
        <Route path="/workspaces/:id" element={<WorkspacePage />} />
        <Route path="/new" element={<p>new meeting</p>} />
        <Route path="/signin" element={<p>sign in</p>} />
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

describe('WorkspacePage', () => {
  it('lets an admin rename, see people, counts, meetings and connect a tool', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
          tools: [
            { kind: 'mattermost', connected: false, settings: {}, lastOkAt: null },
            { kind: 'gitea', connected: true, settings: { url: 'https://gitea.example.com' }, lastOkAt: null },
          ],
          meetings: [
            {
              id: 'mtg-1',
              title: 'Scheduled sync',
              status: 'scheduled',
              scheduledFor: '2999-01-01T02:00:00.000Z',
              ownerName: 'Ada Lovelace',
            },
            {
              id: 'mtg-0',
              title: 'Last week’s planning',
              status: 'ended',
              scheduledFor: '2026-11-10T02:00:00.000Z',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 2, records: 3 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByRole('heading', { name: 'Team workspace' })).toBeTruthy();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByText('Scheduled sync')).toBeTruthy();
    expect(screen.getByText(/^Scheduled for /)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /\/m\/mtg-1$/ }).getAttribute('href'),
    ).toBe('/m/mtg-1');
    expect(screen.getAllByRole('button', { name: 'Connect' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByText('Past meetings')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Last week’s planning' }).getAttribute('href')).toBe(
      '/workspaces/ws-1/meetings/mtg-0',
    );
    expect(screen.queryByRole('link', { name: 'Scheduled sync' })).toBeNull();
  });

  it('tells a new workspace owner how to start and share a meeting', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
          tools: [],
          meetings: [],
          counts: { meetings: 0, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByRole('heading', { name: 'Team workspace' })).toBeTruthy();
    expect(
      screen.getByText(/No meetings yet. Start one with/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'New meeting' }).getAttribute('href')).toBe('/new');
    expect(screen.getByText(/share its link or QR code so people can join/)).toBeTruthy();
  });

  it('shows members, their roles, and the reusable invite link to an admin', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [
            { id: 'user-1', name: 'Ada Lovelace', role: 'admin' },
            { id: 'user-2', name: 'Ben Bitdiddle', role: 'member' },
          ],
          tools: [],
          meetings: [],
          counts: { meetings: 0, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByText('Invite people')).toBeTruthy();
    expect(screen.getByText(/joins as a member, never as an admin/)).toBeTruthy();
    expect(
      await screen.findByRole('link', { name: /join-workspace\/invite-token/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make admin' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset link' })).toBeTruthy();
  });

  it('shows the sample workspace as read-only with built-in tools', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/sample-nanyang-kopi': () =>
        reply({
          id: 'sample-nanyang-kopi',
          name: 'Nanyang Kopi (sample)',
          readOnly: true,
          people: [],
          tools: [],
          meetings: [],
          counts: { meetings: 0, todos: 0, records: 0 },
        }),
    });
    renderPage('sample-nanyang-kopi');

    expect(await screen.findByRole('heading', { name: 'Nanyang Kopi (sample)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(
      screen.getByText('This is a sample workspace. It is read-only, and its tools are built in.'),
    ).toBeTruthy();
    expect(screen.getAllByText('Built in')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('shows a plain page when the workspace does not exist', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/missing': () => reply({ error: 'Workspace not found' }, 404),
    });
    renderPage('missing');

    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeTruthy();
  });

  it('shows a permission refusal without bouncing a signed-in person to sign-in', async () => {
    installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-2': () =>
        reply({ error: 'You are not a member of that workspace.', signInEnded: false }, 403),
    });
    renderPage('ws-2');

    expect(await screen.findByText('You are not a member of that workspace.')).toBeTruthy();
    expect(screen.queryByText('sign in')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Back to New meeting' }).getAttribute('href'),
    ).toBe('/new');
  });

  it('sends a signed-in person to sign in when their session has ended', async () => {
    installFetch({
      'GET /api/workspaces': () => reply({ error: 'Sign in required.', signInEnded: true }, 401),
      'GET /api/workspaces/ws-1': () =>
        reply({ error: 'Sign in required.', signInEnded: true }, 401),
    });
    renderPage('ws-1');

    expect(await screen.findByText('sign in')).toBeTruthy();
  });
});
