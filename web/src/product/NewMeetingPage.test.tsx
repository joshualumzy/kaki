/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { NewMeetingPage } from './NewMeetingPage';

const DRAFT_KEY = 'kaki.new-meeting-draft.v1';

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

function baseRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/workspaces': () =>
      reply([
        { id: 'ws-1', name: 'My workspace', kind: 'personal', role: 'admin' },
        { id: 'sample-nanyang-kopi', name: 'Nanyang Kopi (sample)', kind: 'sample', role: 'member' },
      ]),
    'GET /api/workspaces/ws-1': () =>
      reply({
        id: 'ws-1',
        name: 'My workspace',
        kind: 'personal',
        readOnly: false,
        people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
        tools: [],
        meetings: [],
        counts: { meetings: 0, todos: 0, records: 0 },
      }),
    'GET /api/workspaces/sample-nanyang-kopi': () =>
      reply({
        id: 'sample-nanyang-kopi',
        name: 'Nanyang Kopi (sample)',
        kind: 'sample',
        readOnly: true,
        people: [],
        tools: [],
        meetings: [],
        counts: { meetings: 0, todos: 0, records: 0 },
      }),
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/new']}>
      <Routes>
        <Route path="/new" element={<NewMeetingPage />} />
        <Route path="/signin" element={<p>sign in</p>} />
        <Route path="/practice" element={<p>practice</p>} />
        <Route path="/m/:id/room" element={<p>meeting room</p>} />
        <Route path="/m/:id" element={<p>meeting lobby</p>} />
        <Route path="/workspaces/:id" element={<p>workspace</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function meetingBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === '/api/meetings' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  mocks.state = {
    status: 'ready',
    me: {
      authEnabled: true,
      kind: 'user',
      user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    },
  };
});

describe('NewMeetingPage', () => {
  it('starts now by going straight into the room', async () => {
    const fetchMock = installFetch(
      baseRoutes({
        'POST /api/meetings': () => reply({ id: 'mtg-1', link: '/m/mtg-1' }),
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText('Meeting title'), {
      target: { value: 'Weekly sync' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));

    expect(await screen.findByText('meeting room')).toBeTruthy();
    const bodies = meetingBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      workspaceId: 'ws-1',
      title: 'Weekly sync',
      pace: { quietCheckAfter: 120, comingUpBefore: 60 },
    });
    expect(bodies[0]).not.toHaveProperty('scheduledFor');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('explains what a workspace is beside the picker', async () => {
    installFetch(baseRoutes());
    renderPage();

    expect(
      await screen.findByText(
        /A workspace holds your meetings, minutes and connected tools/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Nanyang Kopi\s+sample is read-only and has its tools ready/)).toBeTruthy();
  });

  it('sends agenda owners by id and the chosen pace', async () => {
    const fetchMock = installFetch(
      baseRoutes({
        'POST /api/meetings': () => reply({ id: 'mtg-3', link: '/m/mtg-3' }),
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText('Meeting title'), {
      target: { value: 'Planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Type it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Agenda item 1'), {
      target: { value: 'Budget' },
    });
    fireEvent.change(await screen.findByLabelText('Owner for item 1'), {
      target: { value: 'user-1' },
    });
    fireEvent.change(screen.getByLabelText('Check quiet people after (seconds into an item)'), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));

    await waitFor(() => expect(meetingBodies(fetchMock)).toHaveLength(1));
    expect(meetingBodies(fetchMock)[0]).toMatchObject({
      agenda: [{ title: 'Budget', ownerUserId: 'user-1' }],
      pace: { quietCheckAfter: 90, comingUpBefore: 60 },
    });
  });

  it('schedules for later with the browser time sent as UTC', async () => {
    const fetchMock = installFetch(
      baseRoutes({
        'POST /api/meetings': () => reply({ id: 'mtg-2', link: '/m/mtg-2' }),
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText('Meeting title'), {
      target: { value: 'Planning' },
    });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2999-01-01' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule for later' }));

    await waitFor(() => expect(meetingBodies(fetchMock)).toHaveLength(1));
    expect(meetingBodies(fetchMock)[0]?.scheduledFor).toBe(
      new Date('2999-01-01T10:00').toISOString(),
    );
  });

  it('refuses a time in the past with a plain sentence', async () => {
    const fetchMock = installFetch(baseRoutes());
    renderPage();

    fireEvent.change(await screen.findByLabelText('Meeting title'), {
      target: { value: 'Planning' },
    });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2000-01-01' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule for later' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Choose a time in the future.');
    expect(meetingBodies(fetchMock)).toHaveLength(0);
  });

  it('keeps what was typed when Tell Kaki fails', async () => {
    installFetch(
      baseRoutes({
        'POST /api/tell-kaki': () => reply({ error: 'Kaki is busy right now.' }, 503),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.click(screen.getByRole('button', { name: 'Tell Kaki' }));
    const tell = screen.getByLabelText('Describe the meeting in a sentence');
    fireEvent.change(tell, { target: { value: 'Sync with Lucie about the demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask Kaki to draft it' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Kaki is busy right now.');
    expect((tell as HTMLTextAreaElement).value).toBe('Sync with Lucie about the demo');
  });

  it('keeps the form when the sample workspace is picked, with a link to practice', async () => {
    installFetch(
      baseRoutes({
        'POST /api/meetings': () => reply({ id: 'mtg-sample', link: '/m/mtg-sample' }),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'sample-nanyang-kopi' },
    });

    expect(
      screen.getByText('The sample workspace can hold this meeting; practice is one click away.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Try a practice meeting' }).getAttribute('href')).toBe(
      '/practice',
    );
    fireEvent.change(screen.getByLabelText('Meeting title'), {
      target: { value: 'Nanyang sync' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
    expect(await screen.findByText('meeting room')).toBeTruthy();
  });

  it('shows the form when the saved draft chose the sample workspace', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        workspaceId: 'sample-nanyang-kopi',
        title: 'Saved sample meeting',
        agenda: [{ id: 'agenda-1', title: 'Opening', minutes: '5' }],
      }),
    );
    installFetch(baseRoutes());
    renderPage();

    const title = (await screen.findByLabelText('Meeting title')) as HTMLInputElement;
    expect(title.value).toBe('Saved sample meeting');
    expect(screen.getByLabelText('Workspace')).toHaveProperty('value', 'sample-nanyang-kopi');
    expect(
      screen.getByText('The sample workspace can hold this meeting; practice is one click away.'),
    ).toBeTruthy();
  });
});
