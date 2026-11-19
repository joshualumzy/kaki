/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingSetup } from '@kaki/shared';
import { SetupPage } from './SetupPage';

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
    { displayName: 'Cy', roleId: 'host', kind: 'ai', npcProfileId: 'cy' },
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
    'GET /api/setup': () => reply({ setup: draft, started: false }),
    'GET /api/setup/tools': () => reply({ tools: [] }),
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <SetupPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetupPage', () => {
  it('renders the saved draft with a source label for every section', async () => {
    installFetch(baseRoutes());
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

    await screen.findByText('Morning huddle');
    const load = screen.getByRole('button', { name: 'Load Kopitiam demo' }) as HTMLButtonElement;
    fireEvent.click(load);

    expect(load.disabled).toBe(true);
    expect(load.textContent).toBe('Loading demo…');

    resolveImport(reply({ setup: importedDraft, started: false }));

    expect(await screen.findByText('Kopitiam launch')).toBeTruthy();
    expect(screen.queryByText('Morning huddle')).toBeNull();
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

    await screen.findByText('Morning huddle');
    fireEvent.click(screen.getByRole('button', { name: 'Load Kopitiam demo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The calendar invite does not match the demo pack.');
    expect(alert.textContent).toContain('agenda[0].owner');
    expect(alert.textContent).toContain('"Nobody" is not a seat or role in the demo pack.');
    expect(screen.getByText('Morning huddle')).toBeTruthy();
  });

  it('shows the server message when the calendar cannot be read', async () => {
    installFetch(
      baseRoutes({
        'POST /api/setup/import-calendar': () => reply({ error: 'The calendar could not be read.' }, 502),
      }),
    );
    renderPage();

    await screen.findByText('Morning huddle');
    fireEvent.click(screen.getByRole('button', { name: 'Load Kopitiam demo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The calendar could not be read.');
    expect(screen.getByText('Morning huddle')).toBeTruthy();
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
    expect(link.getAttribute('href')).toBe('/demo');
    expect((screen.getByRole('button', { name: 'Load Kopitiam demo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      ((await screen.findByRole('button', { name: 'Test connection' })) as HTMLButtonElement).disabled,
    ).toBe(true);
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
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(screen.queryByRole('button', { name: 'Load Kopitiam demo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });
});
