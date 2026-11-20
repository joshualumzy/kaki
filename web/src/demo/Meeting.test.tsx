/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

const mocks = vi.hoisted(() => ({
  useScenario: vi.fn(),
  refreshScenario: vi.fn(),
  events: [] as unknown[],
  lifecycleStarted: undefined as boolean | undefined,
}));

vi.mock('../kaki', () => ({
  useScenario: mocks.useScenario,
  useRefreshScenario: () => mocks.refreshScenario,
  useKaki: () => ({ events: mocks.events, started: mocks.lifecycleStarted }),
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRoomContext: () => ({
    disconnect: vi.fn().mockResolvedValue(undefined),
    localParticipant: { identity: 'visitor-1', publishData: vi.fn() },
    state: 'connected',
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

vi.mock('./JoinForm', () => ({
  JoinForm: ({ roles, onJoin, error, errorAction }: {
    roles: Array<{ id: string; label: string }>;
    error?: string;
    errorAction?: ReactNode;
    onJoin(name: string, role: string, media: { microphone: boolean; camera: boolean }): void;
  }) => (
    <>
      <output data-testid="join-roles">{roles.map((role) => role.label).join(',')}</output>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {errorAction}
      <button
        type="button"
        onClick={() => onJoin('Josh', 'producer', { microphone: false, camera: false })}
      >
        Join now
      </button>
    </>
  ),
}));

vi.mock('../meeting/TeamJoinForm', () => ({
  TeamJoinForm: ({ onJoin }: {
    onJoin(name: string, role: string, media: { microphone: boolean; camera: boolean }): void;
  }) => (
    <button
      type="button"
      onClick={() => onJoin('Josh', 'producer', { microphone: false, camera: false })}
    >
      Join team
    </button>
  ),
}));

vi.mock('./MeetingGrid', () => ({ MeetingGrid: () => null }));
vi.mock('./Dock', () => ({ Dock: () => null }));

let Meeting: typeof import('./Meeting').default;

const scenario: Scenario = {
  id: 'meeting-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [{ id: 'producer', label: 'Producer' }],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [],
  npcs: [
    { attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [], role: 'host', playable: true },
  ],
};

function replyWith(meeting: { resumed?: boolean; started?: boolean }): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: 'token', url: 'ws://localhost:7880', meetingCode: 'ABCD', ...meeting }),
  })));
}

beforeEach(async () => {
  vi.resetModules();
  window.sessionStorage.clear();
  mocks.events = [];
  mocks.lifecycleStarted = undefined;
  mocks.refreshScenario.mockReset();
  mocks.refreshScenario.mockImplementation(async () => mocks.useScenario());
  Meeting = (await import('./Meeting')).default;
  mocks.useScenario.mockReturnValue(scenario);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Meeting join', () => {
  it('skips the Start tutorial when the join resumes a meeting that is already talking', async () => {
    replyWith({ resumed: true });
    render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Before the meeting starts' })).toBeNull();
    expect(document.querySelector('[data-needs-start="true"]')).toBeNull();
  });

  it('still shows the Start tutorial for a fresh meeting', async () => {
    replyWith({ started: false });
    render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    expect(await screen.findByRole('region', { name: 'Before the meeting starts' })).toBeTruthy();
    expect(document.querySelector('[data-needs-start="true"]')).toBeTruthy();
  });

  it('goes straight in when the server says the meeting has already started', async () => {
    replyWith({ resumed: false, started: true });
    render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Before the meeting starts' })).toBeNull();
    expect(document.querySelector('[data-needs-start="true"]')).toBeNull();
  });

  it('re-fetches the scenario after a successful join', async () => {
    replyWith({ started: false });
    render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(mocks.refreshScenario).toHaveBeenCalledTimes(1));
  });

  it('offers every setup person seat, including a role added in setup', async () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      roles: [
        ...scenario.roles,
        { id: 'ghost', label: 'Ghost Seat' },
        { id: 'studio_manager', label: 'General Manager', facilitator: true },
      ],
      joinSeats: ['producer', 'ghost', 'studio_manager'],
    });
    render(<Meeting />);

    expect(screen.getByTestId('join-roles').textContent).toBe('Producer,Ghost Seat,General Manager');
  });

  it('offers the setup person seats when the meeting has no AI attendees', () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      npcs: [],
      roles: [
        ...scenario.roles,
        { id: 'lead_programmer', label: 'Tech & POS Lead' },
      ],
      attendees: [
        ...scenario.attendees,
        { name: 'Arjun', role: 'lead_programmer', zoomDisplayName: 'Arjun' },
      ],
      joinSeats: ['producer', 'lead_programmer'],
    });
    render(<Meeting />);

    expect(screen.getByTestId('join-roles').textContent).toBe('Producer,Tech & POS Lead');
  });

  it('still shows no join seats for a scenario with no AI and no setup seats', () => {
    mocks.useScenario.mockReturnValue({ ...scenario, npcs: [] });
    render(<Meeting />);

    expect(screen.getByTestId('join-roles').textContent).toBe('');
  });

  it('shows the Start prompt again when the server says the meeting was reset', async () => {
    replyWith({ started: true });
    const { rerender } = render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
    await waitFor(() => expect(document.querySelector('[data-needs-start="true"]')).toBeNull());

    mocks.lifecycleStarted = false;
    rerender(<Meeting />);

    expect(await screen.findByRole('region', { name: 'Before the meeting starts' })).toBeTruthy();
    expect(document.querySelector('[data-needs-start="true"]')).toBeTruthy();
  });
  it('joins a practice meeting with kind practice', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'token', url: 'ws://localhost:7880', meetingCode: 'ABCD', started: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Meeting />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: 'practice' });
  });

  it('shows the realMeeting refusal and the way back home', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'A team meeting is in progress right now. Try practice again later.',
        realInProgress: true,
      }),
    })));
    render(
      <MemoryRouter>
        <Meeting />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'A team meeting is in progress right now. Try practice again later.',
    );
    expect(screen.getByRole('link', { name: 'Back to Kaki' }).getAttribute('href')).toBe('/');
  });

  it('waits for the owner instead of showing the story in a team meeting', async () => {
    replyWith({ started: false });
    render(<Meeting variant="participant" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join team' }));

    expect(await screen.findByRole('region', { name: 'Waiting for the meeting to start' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the meeting' })).toBeNull();
    expect(screen.queryByText(/How to play/)).toBeNull();
  });

});


describe('Meeting rejoin', () => {
  const storedKey = 'kaki.join.participant';

  function rememberSeat(): void {
    window.sessionStorage.setItem(
      storedKey,
      JSON.stringify({
        name: 'Ana',
        role: 'producer',
        media: { microphone: false, camera: false },
        meetingCode: 'ABCD',
      }),
    );
  }

  it('restores the same name and seat automatically after a reload', async () => {
    rememberSeat();
    replyWith({ resumed: true });
    const fetchMock = vi.mocked(fetch);

    render(<Meeting variant="participant" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      participantName: 'Ana',
      participantRole: 'producer',
      meetingCode: 'ABCD',
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Reconnecting to the meeting' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull();
    expect(window.sessionStorage.getItem(storedKey)).not.toBeNull();
  });

  it('keeps a rejoin screen with the reason and a way back when the automatic rejoin is refused', async () => {
    rememberSeat();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'This meeting has ended; the meeting owner must start the next one.' }),
    })));

    render(<Meeting variant="participant" />);

    expect(await screen.findByRole('region', { name: 'Reconnecting to the meeting' })).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This meeting has ended; the meeting owner must start the next one.',
    );
    expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Leave and join as someone else' }));
    expect(await screen.findByRole('button', { name: 'Join team' })).toBeTruthy();
    expect(window.sessionStorage.getItem(storedKey)).toBeNull();
  });

  it('lets the person rejoin by hand after the automatic attempt fails', async () => {
    rememberSeat();
    let refuse = true;
    const fetchMock = vi.fn(async () => refuse
      ? { ok: false, status: 503, json: async () => ({ error: 'Could not check who is in the meeting right now.' }) }
      : { ok: true, status: 200, json: async () => ({ token: 'token', url: 'ws://localhost:7880', meetingCode: 'ABCD', resumed: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<Meeting variant="participant" />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not check who is in the meeting right now.',
    );
    expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull();

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Reconnecting to the meeting' })).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remembers the seat after a normal join so the next reload can restore it', async () => {
    replyWith({ started: true });
    render(<Meeting variant="participant" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join team' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull());
    expect(JSON.parse(String(window.sessionStorage.getItem(storedKey)))).toMatchObject({
      name: 'Josh',
      role: 'producer',
      media: { microphone: false, camera: false },
      meetingCode: 'ABCD',
    });
  });
});
