/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingSetup, Scenario } from '@kaki/shared';
import { ScenarioProvider } from '../kaki';
import { SetupPage } from './SetupPage';

const scenario: Scenario = {
  id: 'setup-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [
    { id: 'producer', label: 'Producer' },
    { id: 'game_designer', label: 'Menu Lead' },
    { id: 'host', label: 'Host', facilitator: true },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' },
    { name: 'Mei', role: 'game_designer', zoomDisplayName: 'Mei' },
    { name: 'Cy', role: 'host', zoomDisplayName: 'Cy' },
  ],
  agenda: [
    { title: 'Service handover', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'producer' },
  ],
  npcs: [
    {
      attendee: 'Wei Ling',
      voice: 'en-SG-LunaNeural',
      personality: 'Direct',
      agenda: 'Keep the floor running',
      role: 'participant',
      concerns: [],
    },
    {
      attendee: 'Mei',
      voice: 'zh-CN-XiaoxiaoNeural',
      personality: 'Warm',
      agenda: 'Protect the menu',
      role: 'participant',
      concerns: [],
    },
    {
      attendee: 'Cy',
      voice: 'en-SG-WayneNeural',
      personality: 'Calm',
      agenda: 'Keep time',
      role: 'host',
      concerns: [],
    },
  ],
};

const draft: MeetingSetup = {
  title: 'Morning huddle',
  agenda: [
    { id: 'agenda-1', title: 'Service handover', minutes: 5, ownerRoleId: 'producer' },
    { id: 'agenda-2', title: 'Opening plan', minutes: 10, ownerRoleId: 'host' },
  ],
  roles: [
    { id: 'producer', label: 'Producer', facilitator: false },
    { id: 'host', label: 'Host', facilitator: true },
  ],
  seats: [
    { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
    { displayName: 'Cy', roleId: 'host', kind: 'ai', npcProfileId: 'Cy' },
  ],
  pace: { ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 },
  source: {
    title: 'demo pack',
    agenda: 'calendar invite',
    roles: 'demo pack',
    seats: 'demo pack',
    pace: 'typed',
  },
};

const importedDraft: MeetingSetup = {
  ...draft,
  title: 'Kopitiam launch',
  agenda: [{ id: 'agenda-1', title: 'Launch checklist', minutes: 8, ownerRoleId: 'host' }],
  source: {
    title: 'calendar invite',
    agenda: 'calendar invite',
    roles: 'demo pack',
    seats: 'demo pack',
    pace: 'demo pack',
  },
};

const twoPeopleOneAi: MeetingSetup = {
  ...draft,
  roles: [...draft.roles, { id: 'game_designer', label: 'Menu Lead', facilitator: false }],
  seats: [
    { displayName: 'Wei Ling', roleId: 'producer', kind: 'person' },
    { displayName: 'Mei', roleId: 'game_designer', kind: 'person' },
    { displayName: 'Cy', roleId: 'host', kind: 'ai', npcProfileId: 'Cy' },
  ],
};

const typedSeatDraft: MeetingSetup = {
  ...draft,
  roles: [...draft.roles, { id: 'visitor', label: 'Visitor', facilitator: false }],
  seats: [...draft.seats, { displayName: 'Alex', roleId: 'visitor', kind: 'person' }],
};

function reply(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Handler = () => unknown;

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

function baseRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => reply({ authEnabled: false }),
    'GET /api/scenario': () => reply(scenario),
    'GET /api/setup': () => reply({ setup: draft, started: false }),
    'GET /api/setup/tools': () => reply({ tools: [] }),
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <ScenarioProvider>
        <SetupPage />
      </ScenarioProvider>
    </MemoryRouter>,
  );
}

function renderPageWithMeeting(): void {
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <ScenarioProvider>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/meeting" element={<p>owner meeting room</p>} />
        </Routes>
      </ScenarioProvider>
    </MemoryRouter>,
  );
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input) === '/api/setup' && init?.method === 'PUT',
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetupPage', () => {
  it('renders the saved draft read-only with a source label for every section', async () => {
    installFetch(
      baseRoutes({
        'GET /api/auth/me': () => reply({ authEnabled: true, kind: 'participant', role: 'producer' }),
      }),
    );
    renderPage();

    expect(await screen.findByText('Morning huddle')).toBeTruthy();
    expect(screen.getByText('From calendar invite')).toBeTruthy();
    expect(screen.getAllByText('From demo pack')).toHaveLength(3);
    expect(screen.getByText('Typed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Roles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Seats' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Nudge timings' })).toBeTruthy();
    expect(screen.getByText('Service handover')).toBeTruthy();
    expect(screen.getByText('5 minutes · Owner: Producer')).toBeTruthy();
    expect(screen.getAllByText('Producer').length).toBeGreaterThan(0);
    expect(screen.getByText('Wei Ling')).toBeTruthy();
    expect(screen.getByText('Host · AI stand-in')).toBeTruthy();
    expect(screen.getByText(/Kaki checks 2 minutes into each item/)).toBeTruthy();
    expect(screen.getByText(/Kaki tells the next item’s owner 1 minute before/)).toBeTruthy();
  });

  it('replaces the draft with the demo import and disables the button while it loads', async () => {
    let resolveImport!: (value: unknown) => void;
    const importResult = new Promise<unknown>((resolve) => {
      resolveImport = resolve;
    });
    const fetchMock = installFetch(
      baseRoutes({
        'POST /api/setup/import-calendar': () => importResult,
      }),
    );
    renderPage();

    await screen.findByDisplayValue('Morning huddle');
    const load = screen.getByRole('button', { name: 'Load Kopitiam demo' }) as HTMLButtonElement;
    fireEvent.click(load);

    expect(load.disabled).toBe(true);
    expect(load.textContent).toBe('Loading demo…');

    resolveImport(reply({ setup: importedDraft, started: false }));

    expect(await screen.findByDisplayValue('Kopitiam launch')).toBeTruthy();
    expect(screen.queryByDisplayValue('Morning huddle')).toBeNull();
    expect((screen.getByRole('button', { name: 'Load Kopitiam demo' }) as HTMLButtonElement).disabled).toBe(false);
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === '/api/setup/import-calendar' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('shows 422 field errors in an alert and keeps the previous draft', async () => {
    installFetch(
      baseRoutes({
        'POST /api/setup/import-calendar': () =>
          reply(
            {
              error: 'The calendar invite does not match the demo pack.',
              errors: [
                {
                  field: 'agenda[0].owner',
                  message: '"Nobody" is not a seat or role in the demo pack.',
                },
              ],
            },
            422,
          ),
      }),
    );
    renderPage();

    await screen.findByDisplayValue('Morning huddle');
    fireEvent.click(screen.getByRole('button', { name: 'Load Kopitiam demo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The calendar invite does not match the demo pack.');
    expect(alert.textContent).toContain('agenda[0].owner');
    expect(alert.textContent).toContain('"Nobody" is not a seat or role in the demo pack.');
    expect(screen.getByDisplayValue('Morning huddle')).toBeTruthy();
  });

  it('shows the server message when the calendar cannot be read', async () => {
    installFetch(
      baseRoutes({
        'POST /api/setup/import-calendar': () => reply({ error: 'The calendar could not be read.' }, 502),
      }),
    );
    renderPage();

    await screen.findByDisplayValue('Morning huddle');
    fireEvent.click(screen.getByRole('button', { name: 'Load Kopitiam demo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The calendar could not be read.');
    expect(screen.getByDisplayValue('Morning huddle')).toBeTruthy();
  });

  it('lists tools with their connection state and missing settings, then tests with retry', async () => {
    let attempts = 0;
    installFetch(
      baseRoutes({
        'GET /api/setup/tools': () =>
          reply({
            tools: [
              { kind: 'calendar_event', label: 'Team calendar', configured: true, missing: [] },
              {
                kind: 'email',
                label: 'Email',
                configured: false,
                missing: ['MAILPIT_SMTP_HOST', 'EMAIL_FROM'],
              },
            ],
          }),
        'POST /api/setup/tools/email/test': () => {
          attempts += 1;
          return attempts === 1
            ? reply({
                kind: 'email',
                ok: false,
                problem: 'unreachable',
                message: 'Email did not answer.',
              })
            : reply({ kind: 'email', ok: true, detail: 'The mail server answered.' });
        },
      }),
    );
    renderPage();

    await screen.findByText('Email');
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/MAILPIT_SMTP_HOST, EMAIL_FROM/)).toBeTruthy();
    expect(screen.getByText(/Tools are set up in the server's settings/)).toBeTruthy();

    const buttons = screen.getAllByRole('button', { name: 'Test connection' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLButtonElement);

    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toBe('Email did not answer.');

    fireEvent.click(screen.getAllByRole('button', { name: 'Test connection' })[1] as HTMLButtonElement);
    expect(await screen.findByText('Connection OK: The mail server answered.')).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('locks the setup and links to the meeting after it has started', async () => {
    installFetch(
      baseRoutes({
        'GET /api/setup': () => reply({ setup: draft, started: true }),
        'GET /api/setup/tools': () =>
          reply({ tools: [{ kind: 'email', label: 'Email', configured: true, missing: [] }] }),
      }),
    );
    renderPage();

    expect(await screen.findByText(/The meeting has started; setup is locked\./)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Go to the meeting' });
    expect(link.getAttribute('href')).toBe('/meeting');
    expect((screen.getByRole('button', { name: 'Load Kopitiam demo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      ((await screen.findByRole('button', { name: 'Test connection' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByLabelText('Meeting title field')).toBeNull();
  });

  it('gives a participant the read-only draft and no action buttons', async () => {
    installFetch(
      baseRoutes({
        'GET /api/auth/me': () => reply({ authEnabled: true, kind: 'participant', role: 'producer' }),
      }),
    );
    renderPage();

    expect(await screen.findByText('Morning huddle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load Kopitiam demo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.queryByLabelText('Meeting title field')).toBeNull();
  });

  it('shows a 403 message with a sign-in link and no actions', async () => {
    installFetch(
      baseRoutes({
        'GET /api/setup': () =>
          reply({ error: 'Only the meeting owner can change the setup.' }, 403),
      }),
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Only the meeting owner can change the setup.');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?return=/setup');
    expect(screen.queryByRole('button', { name: 'Load Kopitiam demo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });

  it('rejects 0 minutes on the form and sends no PUT', async () => {
    const fetchMock = installFetch(baseRoutes());
    renderPage();

    const minutes = (await screen.findByLabelText('Agenda item 1 minutes')) as HTMLInputElement;
    fireEvent.change(minutes, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect(
      (await screen.findAllByText('Minutes must be a number greater than 0 and no more than 240.'))
        .length,
    ).toBeGreaterThan(0);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('rejects an agenda item with no owner and sends no PUT', async () => {
    const fetchMock = installFetch(baseRoutes());
    renderPage();

    const owner = (await screen.findByLabelText('Agenda item 1 owner')) as HTMLSelectElement;
    fireEvent.change(owner, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect(
      (await screen.findAllByText('Choose an owner role that exists in this meeting.')).length,
    ).toBeGreaterThan(0);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('rejects duplicate role names and sends no PUT', async () => {
    const fetchMock = installFetch(baseRoutes());
    renderPage();

    const secondRole = (await screen.findByLabelText('Role 2 name')) as HTMLInputElement;
    fireEvent.change(secondRole, { target: { value: 'Producer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect((await screen.findAllByText('Role names must be unique.')).length).toBeGreaterThan(0);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('blocks removing a role that an agenda item or seat still uses', async () => {
    installFetch(baseRoutes());
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove role 1' }));

    expect(
      await screen.findByText(
        '"Producer" is still used by an agenda item and a seat. Change or remove those first.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Role 1 name')).toBeTruthy();
  });

  it('shows the AI stand-in room limit when a second person joins', async () => {
    const fetchMock = installFetch(
      baseRoutes({
        'GET /api/setup': () => reply({ setup: twoPeopleOneAi, started: false }),
      }),
    );
    renderPage();

    expect(await screen.findByLabelText('Seat 3 AI stand-in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect(
      (await screen.findAllByText('A meeting with AI stand-ins has room for one person.')).length,
    ).toBeGreaterThan(0);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('shows server 400 field errors next to the field', async () => {
    installFetch(
      baseRoutes({
        'PUT /api/setup': () =>
          reply(
            {
              errors: [
                {
                  field: 'agenda[0].minutes',
                  message: 'Minutes must be a number greater than 0 and no more than 240.',
                },
              ],
            },
            400,
          ),
      }),
    );
    renderPage();

    const title = (await screen.findByLabelText('Meeting title field')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Changed title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect(
      (await screen.findAllByText('Minutes must be a number greater than 0 and no more than 240.'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('Could not save the setup');
  });

  it('saves and re-renders the server draft with Typed labels', async () => {
    const savedDraft: MeetingSetup = {
      ...draft,
      title: 'Saved morning huddle',
      source: {
        title: 'typed',
        agenda: 'typed',
        roles: 'typed',
        seats: 'typed',
        pace: 'typed',
      },
    };
    const fetchMock = installFetch(
      baseRoutes({
        'PUT /api/setup': () => reply({ setup: savedDraft, started: false }),
      }),
    );
    renderPage();

    const title = (await screen.findByLabelText('Meeting title field')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Draft title' } });
    expect(screen.getByText('You have unsaved changes.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    expect(await screen.findByDisplayValue('Saved morning huddle')).toBeTruthy();
    expect(screen.getAllByText('Typed')).toHaveLength(5);
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();
    expect(putCalls(fetchMock)).toHaveLength(1);
  });

  it('reverts unsaved edits with Cancel', async () => {
    installFetch(baseRoutes());
    renderPage();

    const title = (await screen.findByLabelText('Meeting title field')) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Not saved' } });
    expect(title.value).toBe('Not saved');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(title.value).toBe('Morning huddle');
  });

  it('shows no AI switch for a typed seat', async () => {
    installFetch(
      baseRoutes({
        'GET /api/setup': () => reply({ setup: typedSeatDraft, started: false }),
      }),
    );
    renderPage();

    expect(await screen.findByLabelText('Seat 3 name')).toBeTruthy();
    expect(screen.getByLabelText('Seat 2 AI stand-in')).toBeTruthy();
    expect(screen.queryByLabelText('Seat 3 AI stand-in')).toBeNull();
    expect(screen.getByText('Person only')).toBeTruthy();
  });
  it('handles a practice meeting in progress when opening the room', async () => {
    let opens = 0;
    installFetch(
      baseRoutes({
        'POST /api/meeting/open': () => {
          opens += 1;
          return opens === 1
            ? reply(
                {
                  error: 'A practice meeting is in progress right now. End it before opening the team meeting.',
                  practiceInProgress: true,
                },
                409,
              )
            : reply({ kind: 'real', phase: 'lobby' });
        },
        'POST /api/meeting/end-practice': () => reply({ ok: true, phase: 'lobby' }),
      }),
    );
    renderPageWithMeeting();

    fireEvent.click(await screen.findByRole('button', { name: 'Open the meeting room' }));

    expect(await screen.findByText('A practice meeting is running right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End the practice meeting' }));

    expect(await screen.findByText('owner meeting room')).toBeTruthy();
    expect(opens).toBe(2);
  });

});
