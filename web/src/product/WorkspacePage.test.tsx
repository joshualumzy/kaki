/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('shows an overdue meeting that never started as Didn\'t start, still editable and cancellable', async () => {
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
          meetings: [
            {
              id: 'mtg-overdue',
              title: 'Yesterday planning',
              status: 'scheduled',
              scheduledFor: '2020-01-01T02:00:00.000Z',
              createdAt: '2019-12-01T02:00:00.000Z',
              endedAt: null,
              agenda: [],
              pace: null,
              todoCount: 0,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByText("Didn't start")).toBeTruthy();
    expect(screen.getByText(/^Didn't start · was scheduled for /)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('edits a scheduled meeting with member owners and pace', async () => {
    const fetchMock = installFetch({
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
          meetings: [
            {
              id: 'mtg-1',
              title: 'Scheduled sync',
              status: 'scheduled',
              scheduledFor: '2999-01-01T02:00:00.000Z',
              createdAt: '2026-11-01T02:00:00.000Z',
              endedAt: null,
              agenda: [{ title: 'Budget', minutes: 15, ownerUserId: 'user-1' }],
              pace: { quietCheckAfter: 120, comingUpBefore: 60 },
              todoCount: 1,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 1, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
      'PATCH /api/meetings/mtg-1': () => reply({ ok: true }),
    });
    renderPage('ws-1');

    expect(await screen.findByText(/^Scheduled for /)).toBeTruthy();
    expect(screen.getByText('1 to-do · Owner Ada Lovelace')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const title = await screen.findByDisplayValue('Scheduled sync');
    fireEvent.change(title, { target: { value: 'Scheduled sync v2' } });
    fireEvent.change(screen.getByLabelText('Owner for item 1'), {
      target: { value: 'user-2' },
    });
    fireEvent.change(screen.getByLabelText('Check quiet people after (seconds)'), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/meetings/mtg-1' && init?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/api/meetings/mtg-1' && init?.method === 'PATCH',
    )?.[1];
    expect(JSON.parse(String(patch?.body))).toMatchObject({
      title: 'Scheduled sync v2',
      agenda: [{ title: 'Budget', minutes: 15, ownerUserId: 'user-2' }],
      pace: { quietCheckAfter: 90, comingUpBefore: 60 },
    });
  });

  it('reschedules and cancels a scheduled meeting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
          tools: [],
          meetings: [
            {
              id: 'mtg-1',
              title: 'Scheduled sync',
              status: 'scheduled',
              scheduledFor: '2999-01-01T02:00:00.000Z',
              createdAt: '2026-11-01T02:00:00.000Z',
              endedAt: null,
              agenda: [],
              pace: null,
              todoCount: 0,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
      'PATCH /api/meetings/mtg-1': () => reply({ ok: true }),
      'DELETE /api/meetings/mtg-1': () => reply({ ok: true }),
    });
    renderPage('ws-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-02-02' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/meetings/mtg-1' && init?.method === 'PATCH')).toBe(true),
    );

    cleanup();
    renderPage('ws-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/meetings/mtg-1' && init?.method === 'DELETE')).toBe(true),
    );
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('ends an open meeting from the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
          tools: [],
          meetings: [
            {
              id: 'mtg-1',
              title: 'Open sync',
              status: 'open',
              scheduledFor: null,
              createdAt: '2026-11-01T02:00:00.000Z',
              endedAt: null,
              agenda: [],
              pace: null,
              todoCount: 0,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
      'POST /api/meetings/mtg-1/end': () => reply({ ok: true }),
    });
    renderPage('ws-1');

    expect(await screen.findByText(/^Open now · created /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/meetings/mtg-1/end' && init?.method === 'POST')).toBe(true),
    );
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps a member read-only on meetings they do not own', async () => {
    mocks.state = {
      status: 'ready',
      me: {
        authEnabled: true,
        kind: 'user',
        user: { id: 'user-2', name: 'Ben Bitdiddle', email: 'ben@example.com' },
      },
    };
    installFetch({
      'GET /api/workspaces': () =>
        reply([{ id: 'ws-1', name: 'Team workspace', kind: 'team', role: 'member' }]),
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
          meetings: [
            {
              id: 'mtg-1',
              title: 'Open sync',
              status: 'open',
              scheduledFor: null,
              createdAt: '2026-11-01T02:00:00.000Z',
              endedAt: null,
              agenda: [],
              pace: null,
              todoCount: 0,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
            },
          ],
          counts: { meetings: 1, todos: 0, records: 0 },
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByText('Open sync')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('retries a meeting whose workspace calendar write failed', async () => {
    const fetchMock = installFetch({
      'GET /api/workspaces': () => reply(workspaces),
      'GET /api/workspaces/ws-1': () =>
        reply({
          id: 'ws-1',
          name: 'Team workspace',
          kind: 'team',
          readOnly: false,
          people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
          tools: [{ kind: 'calendar', connected: true, settings: {}, lastOkAt: null }],
          meetings: [
            {
              id: 'mtg-1',
              title: 'Scheduled sync',
              status: 'scheduled',
              scheduledFor: '2999-01-01T02:00:00.000Z',
              createdAt: '2026-11-01T02:00:00.000Z',
              endedAt: null,
              agenda: [],
              pace: null,
              todoCount: 0,
              ownerUserId: 'user-1',
              ownerName: 'Ada Lovelace',
              calendar: {
                uid: 'kaki-meeting-mtg-1@kaki.local',
                sequence: 0,
                state: 'error',
                error: 'The calendar returned HTTP 500',
                syncedAt: null,
              },
            },
          ],
          counts: { meetings: 1, todos: 0, records: 0 },
        }),
      'GET /api/workspaces/ws-1/invite': () =>
        reply({
          token: 'invite-token',
          path: '/join-workspace/invite-token',
          workspace: { id: 'ws-1', name: 'Team workspace' },
        }),
      'POST /api/meetings/mtg-1/calendar-sync': () =>
        reply({
          calendar: {
            uid: 'kaki-meeting-mtg-1@kaki.local',
            sequence: 0,
            state: 'synced',
            error: null,
            syncedAt: '2026-11-01T03:00:00.000Z',
          },
          warning: null,
        }),
    });
    renderPage('ws-1');

    expect(await screen.findByText('The calendar returned HTTP 500')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calendar' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/meetings/mtg-1/calendar-sync' && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText('The calendar returned HTTP 500')).toBeNull(),
    );
    expect(screen.getByRole('link', { name: 'Add to calendar' })).toBeTruthy();
  });

  it('deletes a team workspace only when the typed name matches', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const fetchMock = installFetch({
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
      'DELETE /api/workspaces/ws-1': () => reply({ ok: true, calendarWarnings: [] }),
    });
    renderPage('ws-1');

    expect(await screen.findByText('Get this workspace started')).toBeTruthy();
    const confirm = screen.getByLabelText('Type the workspace name to confirm');
    const button = screen.getByRole('button', { name: 'Delete workspace' });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.change(confirm, { target: { value: 'Team workspace' } });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);

    expect(await screen.findByText('new meeting')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/workspaces/ws-1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('offers Delete anyway when the calendar cannot be reached', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    let deletes = 0;
    const fetchMock = installFetch({
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
      'DELETE /api/workspaces/ws-1': () => {
        deletes += 1;
        return deletes === 1
          ? reply(
              {
                error:
                  "The team calendar can't be reached, so the workspace wasn't deleted. Try again.",
                canDeleteAnyway: true,
              },
              502,
            )
          : reply({ ok: true, calendarEventsMayRemain: true });
      },
    });
    renderPage('ws-1');

    expect(await screen.findByText('Get this workspace started')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type the workspace name to confirm'), {
      target: { value: 'Team workspace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));

    expect(
      await screen.findByText(
        "The team calendar can't be reached, so the workspace wasn't deleted. Try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Delete anyway? The calendar events for upcoming meetings may remain.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));

    expect(await screen.findByText('new meeting')).toBeTruthy();
    const deleteCall = fetchMock.mock.calls
      .filter(
        ([url, init]) => String(url) === '/api/workspaces/ws-1' && init?.method === 'DELETE',
      )
      .at(-1);
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toMatchObject({ deleteAnyway: true });
    expect(alert).toHaveBeenCalledWith(
      'The workspace was deleted. The calendar events for upcoming meetings may remain.',
    );
    alert.mockRestore();
  });
});
