/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario, Task } from '@kaki/shared';

const mocks = vi.hoisted(() => ({
  useKaki: vi.fn(),
  useScenario: vi.fn(),
  useMe: vi.fn(),
}));

vi.mock('../kaki', () => ({
  useKaki: mocks.useKaki,
  useScenario: mocks.useScenario,
}));

vi.mock('../auth/useMe', () => ({
  useMe: mocks.useMe,
}));

import { ActiveRoleCards, PhonePage } from './PhonePage';

const scenario: Scenario = {
  id: 'test-cafe',
  organisation: 'Test Cafe',
  meetingTitle: 'Morning huddle',
  roles: [{ id: 'producer', label: 'Operations Director' }],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [],
};

const decision = 'We will move the cash box away from the food prep area and count the float every night.';

const task: Task = {
  id: 'task-1',
  title: 'Post the cash box decision in the team channel',
  context: 'Announce the cash box move.',
  decisionSource: decision,
  suggestedAssignee: 'producer',
  assignee: 'producer',
  actionKind: 'mattermost_post',
  status: 'DRAFT_READY',
  draft: {
    target: '#launch',
    subject: 'Post the cash box decision in the team channel',
    body: 'We are moving the cash box and counting the float nightly.',
  },
  updatedAt: '2026-11-08T10:00:00Z',
};

function mockTasks(tasks: Task[]): void {
  mocks.useScenario.mockReturnValue(scenario);
  mocks.useKaki.mockReturnValue({
    events: [],
    tasks: new Map(tasks.map((item) => [item.id, item])),
    connected: true,
    rejections: [],
    rejection: null,
    send: vi.fn(),
  });
}

/** The role socket carries tasks; topic changes arrive only on the shared screen socket, as on the server. */
function mockSockets({ screenEvents, tasks }: { screenEvents: KakiEvent[]; tasks: Map<string, Task> } & Record<string, unknown>): void {
  mocks.useKaki.mockImplementation((audience: string) => ({
    events: audience === 'screen' || audience === 'participant' ? screenEvents : [],
    tasks: audience === 'screen' || audience === 'participant' ? new Map() : tasks,
    connected: true,
    rejections: [],
    rejection: null,
    send: vi.fn(),
  }));
}

beforeEach(() => {
  mockTasks([task]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('task review card', () => {
  it('shows the accepted decision beside the draft the person is reviewing', () => {
    render(<ActiveRoleCards role="producer" viewer={{ name: 'Joshua' }} />);

    expect(screen.getByText('Accepted decision')).toBeTruthy();
    expect(screen.getByText(decision)).toBeTruthy();
    expect(screen.getByText(task.draft!.body)).toBeTruthy();
  });

  it('shows no decision block when the task has no established source', () => {
    const withoutSource: Task = { ...task, id: 'task-2', decisionSource: undefined };
    mockTasks([withoutSource]);

    render(<ActiveRoleCards role="producer" viewer={{ name: 'Joshua' }} />);

    expect(screen.queryByText('Accepted decision')).toBeNull();
  });
});

describe('earlier topic cards', () => {
  it('collapses a settled earlier topic to one line and opens its draft on Review', () => {
    const withAgenda: Scenario = {
      ...scenario,
      agenda: [
        { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'producer' },
        { title: 'Stock', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'producer' },
      ],
    };
    mocks.useScenario.mockReturnValue(withAgenda);
    mockSockets({
      screenEvents: [{
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'screen' },
        payload: {
          agendaIndex: 1, openQuestions: [], elapsedSeconds: 0, speakerTalkSeconds: {},
          notetakerStatus: 'ok', quietRoles: [],
        },
      }],
      tasks: new Map([[task.id, { ...task, agendaItemTitle: 'Prep' }]]),
      connected: true,
      rejections: [],
      rejection: null,
      send: vi.fn(),
    });

    render(<ActiveRoleCards role="producer" viewer={{ name: 'Joshua' }} />);

    expect(screen.queryByText(task.draft!.body)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    expect(screen.getByText(task.draft!.body)).toBeTruthy();
  });

  it('keeps a card for the current topic fully open', () => {
    const withAgenda: Scenario = {
      ...scenario,
      agenda: [
        { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'producer' },
        { title: 'Stock', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'producer' },
      ],
    };
    mocks.useScenario.mockReturnValue(withAgenda);
    mockSockets({
      screenEvents: [{
        type: 'MEETING_RECORD_UPDATED',
        audience: { kind: 'screen' },
        payload: {
          agendaIndex: 1, openQuestions: [], elapsedSeconds: 0, speakerTalkSeconds: {},
          notetakerStatus: 'ok', quietRoles: [],
        },
      }],
      tasks: new Map([[task.id, { ...task, agendaItemTitle: 'Stock' }]]),
      connected: true,
      rejections: [],
      rejection: null,
      send: vi.fn(),
    });

    render(<ActiveRoleCards role="producer" viewer={{ name: 'Joshua' }} />);

    expect(screen.getByText(task.draft!.body)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review/ })).toBeNull();
  });
});

const phoneScenario: Scenario = {
  ...scenario,
  roles: [...scenario.roles, { id: 'manager', label: 'Manager' }],
  attendees: [...scenario.attendees, { name: 'Cy', role: 'manager', zoomDisplayName: 'Cy' }],
  npcs: [
    {
      attendee: 'Cy',
      voice: 'test-voice',
      personality: 'Quiet until asked.',
      agenda: 'Keep the cafe running.',
      concerns: [],
    },
  ],
};

function renderPhone(role: string) {
  mocks.useScenario.mockReturnValue(phoneScenario);
  mocks.useMe.mockReturnValue({ status: 'ready', me: { authEnabled: false } });
  mocks.useKaki.mockReturnValue({
    events: [],
    tasks: new Map(),
    connected: true,
    rejections: [],
    rejection: null,
    send: vi.fn(),
  });
  render(
    <MemoryRouter initialEntries={[`/phone?role=${role}`]}>
      <PhonePage />
    </MemoryRouter>,
  );
}

describe('phone seat access without auth', () => {
  it('opens the Kopitiam human seat feed exactly as before', () => {
    renderPhone('producer');

    expect(mocks.useKaki).toHaveBeenCalledWith('producer');
    expect(screen.getByText('Kaki · Operations Director')).toBeTruthy();
  });

  it('refuses a URL role that only an AI stand-in plays', () => {
    renderPhone('manager');

    expect(mocks.useKaki).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not a human seat/);
  });
});
