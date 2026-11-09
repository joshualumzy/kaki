/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, Task } from '@kaki/shared';

const mocks = vi.hoisted(() => ({
  useKaki: vi.fn(),
  useScenario: vi.fn(),
}));

vi.mock('../kaki', () => ({
  useKaki: mocks.useKaki,
  useScenario: mocks.useScenario,
}));

import { ActiveRoleCards } from './PhonePage';

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
