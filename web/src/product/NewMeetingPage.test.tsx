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
        <Route path="/m/:id" element={<p>meeting room</p>} />
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
  it('creates a meeting with just a title and shows the link', async () => {
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

    expect(await screen.findByRole('link', { name: /\/m\/mtg-1/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open meeting' }).getAttribute('href')).toBe(
      '/m/mtg-1',
    );
    const bodies = meetingBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ workspaceId: 'ws-1', title: 'Weekly sync' });
    expect(bodies[0]).not.toHaveProperty('scheduledFor');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
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

  it('replaces the form with a practice note when the sample workspace is picked', async () => {
    installFetch(baseRoutes());
    renderPage();

    await screen.findByLabelText('Meeting title');
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'sample-nanyang-kopi' },
    });

    expect(screen.getByText('The sample workspace is for practice')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Try a practice meeting' }).getAttribute('href')).toBe(
      '/practice',
    );
    expect(screen.queryByLabelText('Meeting title')).toBeNull();
  });
});
