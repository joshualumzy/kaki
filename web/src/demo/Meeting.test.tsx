/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

const mocks = vi.hoisted(() => ({ useScenario: vi.fn(), events: [] as unknown[] }));

vi.mock('../kaki', () => ({
  useScenario: mocks.useScenario,
  useRefreshScenario: () => async () => mocks.useScenario(),
  useKaki: () => ({ events: mocks.events }),
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRoomContext: () => ({
    disconnect: vi.fn().mockResolvedValue(undefined),
    localParticipant: { identity: 'visitor-1', publishData: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

vi.mock('./JoinForm', () => ({
  JoinForm: ({ onJoin }: {
    onJoin(name: string, role: string, media: { microphone: boolean; camera: boolean }): void;
  }) => (
    <button
      type="button"
      onClick={() => onJoin('Josh', 'Producer', { microphone: false, camera: false })}
    >
      Join now
    </button>
  ),
}));

vi.mock('./MeetingGrid', () => ({ MeetingGrid: () => null }));
vi.mock('./Dock', () => ({ Dock: () => null }));
vi.mock('./LocalSpeechSTT', () => ({ LocalSpeechSTT: () => null }));

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
  mocks.events = [];
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
});
