/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { formatMeetingTime } from '../ui';
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
        <Route path="/signin" element={<SignInProbe />} />
        <Route path="/practice" element={<p>practice</p>} />
        <Route path="/m/:id/room" element={<p>meeting room</p>} />
        <Route path="/m/:id" element={<p>meeting lobby</p>} />
        <Route path="/workspaces/:id" element={<p>workspace</p>} />
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

  it('sends a signed-out visitor to sign in without asking for protected data', async () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
    const fetchMock = installFetch({});
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/signin?next=%2Fnew'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    const when = formatMeetingTime(new Date('2999-01-01T10:00').toISOString());
    expect((await screen.findByText(/^Scheduled for /)).textContent).toBe(
      `Scheduled for ${when}.`,
    );
  });

  it('confirms a workspace created from the form', async () => {
    installFetch(
      baseRoutes({
        'POST /api/workspaces': () =>
          reply({ id: 'ws-new', name: 'Research', kind: 'team', role: 'admin' }),
        'GET /api/workspaces/ws-new': () =>
          reply({
            id: 'ws-new',
            name: 'Research',
            kind: 'team',
            readOnly: false,
            people: [{ id: 'user-1', name: 'Ada Lovelace', role: 'admin' }],
            tools: [],
            meetings: [],
            counts: { meetings: 0, todos: 0, records: 0 },
          }),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: '__create_workspace__' },
    });
    fireEvent.change(screen.getByLabelText('New workspace name'), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Workspace Research created.')).toBeTruthy();
    expect(screen.getByLabelText('Workspace')).toHaveProperty('value', 'ws-new');
  });

  it('puts Add an item below the agenda rows', async () => {
    installFetch(baseRoutes());
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.click(screen.getByRole('button', { name: 'Type it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));

    const row = screen.getByLabelText('Agenda item 1');
    const add = screen.getByRole('button', { name: 'Add an item' });
    expect(
      row.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  it('picks an upcoming workspace calendar event and fills title, time and agenda', async () => {
    installFetch(
      baseRoutes({
        'GET /api/workspaces/ws-1/calendar/events': () =>
          reply({
            connected: true,
            events: [
              {
                uid: 'planning@example.test',
                title: 'Quarterly planning',
                date: '2999-11-13',
                time: '09:30',
                endTime: '10:30',
                description: '- Budget\n- Hiring\n- Launch date',
                people: ['Ada'],
              },
            ],
          }),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.click(screen.getByRole('button', { name: 'From calendar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly planning/ }));

    expect((screen.getByLabelText('Meeting title') as HTMLInputElement).value).toBe(
      'Quarterly planning',
    );
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2999-11-13');
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('09:30');
    expect((screen.getByLabelText('Agenda item 1') as HTMLInputElement).value).toBe('Budget');
    expect((screen.getByLabelText('Agenda item 3') as HTMLInputElement).value).toBe('Launch date');
  });

  it('shows a plain hint when the workspace has no connected calendar', async () => {
    installFetch(
      baseRoutes({
        'GET /api/workspaces/ws-1/calendar/events': () =>
          reply({ connected: false, events: [] }),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.click(screen.getByRole('button', { name: 'From calendar' }));

    expect(await screen.findByText(/This workspace has no connected calendar/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect one in its tools' })).toBeTruthy();
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

  it('keeps a picked event’s instant and binding, and labels the local time zone', async () => {
    const fetchMock = installFetch(
      baseRoutes({
        'GET /api/workspaces/ws-1/calendar/events': () =>
          reply({
            connected: true,
            events: [
              {
                uid: 'planning@example.test',
                title: 'Quarterly planning',
                date: '2999-11-13',
                time: '10:00',
                endTime: '11:00',
                start: '2999-11-13T10:00:00.000Z',
                timeZone: 'UTC',
                fileId: 'planning',
                description: '- Budget',
                people: [],
              },
            ],
          }),
        'POST /api/meetings': () => reply({ id: 'mtg-9', link: '/m/mtg-9' }),
      }),
    );
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.click(screen.getByRole('button', { name: 'From calendar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Quarterly planning/ }));

    expect(await screen.findByText(/Times are shown in your time zone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule for later' }));

    await waitFor(() => expect(meetingBodies(fetchMock)).toHaveLength(1));
    expect(meetingBodies(fetchMock)[0]).toMatchObject({
      scheduledFor: '2999-11-13T10:00:00.000Z',
      calendarEvent: { uid: 'planning@example.test', fileId: 'planning' },
    });
  });

});
