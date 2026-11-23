/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { DisconnectReason } from 'livekit-client';

const mocks = vi.hoisted(() => ({
  useScenario: vi.fn(),
  refreshScenario: vi.fn(),
  events: [] as unknown[],
  lifecycleStarted: undefined as boolean | undefined,
  onDisconnected: undefined as ((reason: unknown) => void) | undefined,
  auth: { status: 'ready', me: { authEnabled: false } } as unknown,
}));

vi.mock('../../kaki', () => ({
  useScenario: mocks.useScenario,
  useRefreshScenario: () => mocks.refreshScenario,
  useKaki: () => ({ events: mocks.events, started: mocks.lifecycleStarted }),
  KakiConnectionProvider: ({ children }: { children: ReactNode }) => children,
  meetingApiPath: (id: string | undefined, path: string) =>
    id === undefined ? path : `/api/meetings/${id}${path.slice(4)}`,
}));

vi.mock('../../auth/useMe', () => ({ useMe: () => mocks.auth }));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({
    children,
    onDisconnected,
  }: {
    children: ReactNode;
    onDisconnected?: (reason: unknown) => void;
  }) => {
    mocks.onDisconnected = onDisconnected;
    return <>{children}</>;
  },
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
  JoinForm: ({ roles, onJoin, error, errorAction, meetingTitle }: {
    roles: Array<{ id: string; label: string }>;
    meetingTitle: string;
    error?: string;
    errorAction?: ReactNode;
    onJoin(name: string, role: string, media: { microphone: boolean; camera: boolean }): void;
  }) => (
    <>
      <output data-testid="join-title">{meetingTitle}</output>
      <output data-testid="join-roles">{roles.map((role) => role.label).join(',')}</output>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {errorAction}
      <button
        type="button"
        onClick={() => onJoin('Josh', 'operations_director', { microphone: false, camera: false })}
      >
        Join now
      </button>
    </>
  ),
}));

vi.mock('./MeetingGrid', () => ({ MeetingGrid: () => null }));
vi.mock('./Dock', () => ({ Dock: () => null }));

let Meeting: typeof import('./Meeting').default;

const scenario: Scenario = {
  id: 'meeting-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Morning huddle',
  roles: [{ id: 'operations_director', label: 'Producer' }],
  attendees: [{ name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' }],
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
  mocks.onDisconnected = undefined;
  mocks.auth = { status: 'ready', me: { authEnabled: false } };
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
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Before the meeting starts' })).toBeNull();
    expect(document.querySelector('[data-needs-start="true"]')).toBeNull();
  });

  it('still shows the Start tutorial for a fresh meeting', async () => {
    replyWith({ started: false });
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    expect(await screen.findByRole('region', { name: 'Before the meeting starts' })).toBeTruthy();
    expect(document.querySelector('[data-needs-start="true"]')).toBeTruthy();
  });

  it('goes straight in when the server says the meeting has already started', async () => {
    replyWith({ resumed: false, started: true });
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Before the meeting starts' })).toBeNull();
    expect(document.querySelector('[data-needs-start="true"]')).toBeNull();
  });

  it('re-fetches the scenario after a successful join', async () => {
    replyWith({ started: false });
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(mocks.refreshScenario).toHaveBeenCalledTimes(1));
  });

  it('offers every setup person seat, including a role added in setup', async () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      roles: [
        ...scenario.roles,
        { id: 'ghost', label: 'Ghost Seat' },
        { id: 'general_manager', label: 'General Manager', facilitator: true },
      ],
      joinSeats: ['operations_director', 'ghost', 'general_manager'],
    });
    render(<Meeting practiceMeetingId="practice-1" />);

    expect(screen.getByTestId('join-roles').textContent).toBe('Producer,Ghost Seat,General Manager');
  });

  it('offers the setup person seats when the meeting has no AI attendees', () => {
    mocks.useScenario.mockReturnValue({
      ...scenario,
      npcs: [],
      roles: [
        ...scenario.roles,
        { id: 'tech_pos_lead', label: 'Tech & POS Lead' },
      ],
      attendees: [
        ...scenario.attendees,
        { name: 'Arjun', role: 'tech_pos_lead', displayName: 'Arjun' },
      ],
      joinSeats: ['operations_director', 'tech_pos_lead'],
    });
    render(<Meeting practiceMeetingId="practice-1" />);

    expect(screen.getByTestId('join-roles').textContent).toBe('Producer,Tech & POS Lead');
  });

  it('still shows no join seats for a scenario with no AI and no setup seats', () => {
    mocks.useScenario.mockReturnValue({ ...scenario, npcs: [] });
    render(<Meeting practiceMeetingId="practice-1" />);

    expect(screen.getByTestId('join-roles').textContent).toBe('');
  });

  it('shows the Start prompt again when the server says the meeting was reset', async () => {
    replyWith({ started: true });
    const { rerender } = render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
    await waitFor(() => expect(document.querySelector('[data-needs-start="true"]')).toBeNull());

    mocks.lifecycleStarted = false;
    rerender(<Meeting practiceMeetingId="practice-1" />);

    expect(await screen.findByRole('region', { name: 'Before the meeting starts' })).toBeTruthy();
    expect(document.querySelector('[data-needs-start="true"]')).toBeTruthy();
  });
  it('joins this visitor’s own practice meeting under its prefixed path', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'token', url: 'ws://localhost:7880', meetingCode: 'ABCD', started: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Meeting practiceMeetingId="practice-1" />);
    expect(screen.getByTestId('join-title').textContent).toBe('Nanyang Kopi (sample workspace)');
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/meetings/practice-1/livekit/token');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: 'practice' });
  });
});

describe('Meeting rejoin', () => {
  const storedKey = 'kaki.join.practice.practice-1';

  function rememberSeat(): void {
    window.sessionStorage.setItem(
      storedKey,
      JSON.stringify({
        name: 'Ana',
        role: 'operations_director',
        media: { microphone: false, camera: false },
      }),
    );
  }

  it('restores the same name and seat automatically after a reload', async () => {
    rememberSeat();
    replyWith({ resumed: true });
    const fetchMock = vi.mocked(fetch);

    render(<Meeting practiceMeetingId="practice-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      participantName: 'Ana',
      participantRole: 'operations_director',
      kind: 'practice',
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Reconnecting to the meeting' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
    expect(window.sessionStorage.getItem(storedKey)).not.toBeNull();
  });

  it('keeps a rejoin screen with the reason and a way back when the automatic rejoin is refused', async () => {
    rememberSeat();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'That seat is taken. Pick another role.' }),
    })));

    render(<Meeting practiceMeetingId="practice-1" />);

    expect(await screen.findByRole('region', { name: 'Reconnecting to the meeting' })).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That seat is taken. Pick another role.',
    );
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Leave and join as someone else' }));
    expect(await screen.findByRole('button', { name: 'Join now' })).toBeTruthy();
    expect(window.sessionStorage.getItem(storedKey)).toBeNull();
  });

  it('offers a new practice when a rejoin finds this visitor’s practice has ended', async () => {
    rememberSeat();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'practice-ended',
        message: 'This practice meeting has ended. Start a new practice.',
      }),
    })));
    const onNewPractice = vi.fn();

    render(<Meeting practiceMeetingId="practice-1" onNewPractice={onNewPractice} />);

    const button = await screen.findByRole('button', { name: 'Start a new practice' });
    expect(screen.queryByRole('region', { name: 'Reconnecting to the meeting' })).toBeNull();
    expect(window.sessionStorage.getItem(storedKey)).toBeNull();
    fireEvent.click(button);
    expect(onNewPractice).toHaveBeenCalledTimes(1);
  });

  it('offers a new practice when the practice meeting has been unloaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'meeting-not-found' }),
    })));
    const onNewPractice = vi.fn();

    render(<Meeting practiceMeetingId="practice-1" onNewPractice={onNewPractice} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    const button = await screen.findByRole('button', { name: 'Start a new practice' });
    fireEvent.click(button);
    expect(onNewPractice).toHaveBeenCalledTimes(1);
  });

  it('lets the person rejoin by hand after the automatic attempt fails', async () => {
    rememberSeat();
    let refuse = true;
    const fetchMock = vi.fn(async () => refuse
      ? { ok: false, status: 503, json: async () => ({ error: 'Could not check who is in the meeting right now.' }) }
      : { ok: true, status: 200, json: async () => ({ token: 'token', url: 'ws://localhost:7880', resumed: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<Meeting practiceMeetingId="practice-1" />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not check who is in the meeting right now.',
    );
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Reconnecting to the meeting' })).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the way back after a deliberate leave', async () => {
    replyWith({ started: true });
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());

    act(() => {
      mocks.onDisconnected?.(DisconnectReason.CLIENT_INITIATED);
    });

    expect(await screen.findByRole('heading', { name: 'You left the meeting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See the meeting minutes' }).getAttribute('href')).toBe(
      '#minutes',
    );
  });

  it('remembers the seat after a normal join so the next reload can restore it', async () => {
    replyWith({ started: true });
    render(<Meeting practiceMeetingId="practice-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join now' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull());
    expect(JSON.parse(String(window.sessionStorage.getItem(storedKey)))).toMatchObject({
      name: 'Josh',
      role: 'operations_director',
      media: { microphone: false, camera: false },
    });
  });
});


describe('Meeting real meeting', () => {
  it('joins by the meeting id with the Google name and no role picker', async () => {
    mocks.auth = {
      status: 'ready',
      me: {
        authEnabled: true,
        kind: 'user',
        user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const body =
        url === '/api/meetings/mtg-1/meeting-code'
          ? { code: 'K7QX' }
          : url === '/api/meetings/mtg-1/livekit/token'
            ? { token: 'token', url: 'ws://localhost:7880', started: true, meetingCode: 'K7QX' }
            : {};
      return { ok: url !== '/nope', status: url === '/nope' ? 404 : 200, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Meeting variant="real" meetingId="mtg-1" />);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === '/api/meetings/mtg-1/livekit/token' &&
            init?.method === 'POST',
        ),
      ).toBe(true),
    );
    const tokenCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/meetings/mtg-1/livekit/token',
    );
    expect(JSON.parse(String(tokenCall?.[1]?.body))).toMatchObject({
      participantName: 'Ada Lovelace',
      participantRole: 'operations_director',
      meetingCode: 'K7QX',
    });
    expect(screen.queryByLabelText('Your seat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
  });
});
