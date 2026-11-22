import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, canTransition, isSuggestInput, isTask, type TaskStatus } from '../src/task';
import { testScenario } from './fixtures';

const LEGAL_MOVES: ReadonlyArray<[TaskStatus, TaskStatus]> = [
  ['SUGGESTED', 'DISPATCHED'],
  ['SUGGESTED', 'DISMISSED'],
  ['DISPATCHED', 'CLAIMED'],
  ['DISPATCHED', 'SUGGESTED'],
  ['DISPATCHED', 'DISMISSED'],
  ['CLAIMED', 'DRAFT_READY'],
  ['CLAIMED', 'COMPLETED'],
  ['CLAIMED', 'FAILED'],
  ['DRAFT_READY', 'RUNNING'],
  ['RUNNING', 'COMPLETED'],
  ['RUNNING', 'FAILED'],
  ['FAILED', 'RUNNING'],
  ['FAILED', 'CLAIMED'],
  ['COMPLETED', 'SYNCED'],
  ...(['SUGGESTED', 'DISPATCHED', 'CLAIMED', 'DRAFT_READY', 'RUNNING', 'COMPLETED', 'FAILED', 'SYNCED'] as const)
    .map((from): [TaskStatus, TaskStatus] => [from, 'SUPERSEDED']),
];

const LEGAL = new Set(LEGAL_MOVES.map(([from, to]) => `${from}>${to}`));

describe('canTransition', () => {
  it('accepts every legal move', () => {
    for (const [from, to] of LEGAL_MOVES) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects every move outside the lifecycle', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(LEGAL.has(`${from}>${to}`));
      }
    }
  });

  it('rejects shortcuts and dead ends', () => {
    expect(canTransition('SUGGESTED', 'CLAIMED')).toBe(false);
    expect(canTransition('SUGGESTED', 'RUNNING')).toBe(false);
    expect(canTransition('DISPATCHED', 'DRAFT_READY')).toBe(false);
    expect(canTransition('DRAFT_READY', 'DRAFT_READY')).toBe(false);
    expect(canTransition('DRAFT_READY', 'COMPLETED')).toBe(false);
    expect(canTransition('CLAIMED', 'SYNCED')).toBe(false);
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('SYNCED', 'COMPLETED')).toBe(false);
    expect(canTransition('DISMISSED', 'DISPATCHED')).toBe(false);
  });
});

describe('assignment evidence', () => {
  const base = {
    id: 'task-1',
    title: 'Fix the oven',
    context: 'Trips the fuse.',
    suggestedAssignee: 'chef',
    status: 'SUGGESTED',
    updatedAt: '2026-11-08T00:00:00.000Z',
  } as const;

  const evidence = {
    speaker: 'Ada',
    quote: 'I will fix the oven this afternoon.',
    scope: { title: 'Fix the oven', context: 'Trips the fuse.', actionKind: 'mattermost_post' },
  };

  it('accepts a grounded assignment evidence object with a full task snapshot', () => {
    expect(isTask({ ...base, assignmentEvidence: evidence }, testScenario)).toBe(true);
  });

  it('accepts a snapshot without an action kind', () => {
    expect(
      isTask(
        { ...base, assignmentEvidence: { ...evidence, scope: { title: 'Fix the oven', context: 'Trips the fuse.' } } },
        testScenario,
      ),
    ).toBe(true);
  });

  it('keeps tasks without evidence backward compatible', () => {
    expect(isTask(base, testScenario)).toBe(true);
  });

  it('rejects blank speaker, quote or scope fields', () => {
    for (const assignmentEvidence of [
      { speaker: '  ', quote: 'I will fix it.', scope: { title: 'Fix it', context: 'c' } },
      { speaker: 'Ada', quote: '  ', scope: { title: 'Fix it', context: 'c' } },
      { speaker: 'Ada', quote: 'I will fix it.', scope: { title: '  ', context: 'c' } },
    ]) {
      expect(isTask({ ...base, assignmentEvidence }, testScenario), JSON.stringify(assignmentEvidence)).toBe(false);
    }
  });

  it('rejects a legacy title-only scope and an unknown action kind', () => {
    expect(isTask({ ...base, assignmentEvidence: { ...evidence, scope: 'Fix the oven' } }, testScenario)).toBe(false);
    expect(
      isTask(
        { ...base, assignmentEvidence: { ...evidence, scope: { ...evidence.scope, actionKind: 'telepathy' } } },
        testScenario,
      ),
    ).toBe(false);
  });
});

describe('agenda origin', () => {
  it('accepts an optional originating agenda item on suggestions and tasks', () => {
    expect(
      isSuggestInput(
        { title: 'Post the plan', context: 'c', suggestedAssignee: 'chef', agendaItemTitle: 'Prep' },
        testScenario,
      ),
    ).toBe(true);
    expect(
      isTask(
        {
          id: 'task-1',
          title: 'Post the plan',
          context: 'c',
          suggestedAssignee: 'chef',
          agendaItemTitle: 'Prep',
          status: 'SUGGESTED',
          updatedAt: '2026-11-08T00:00:00.000Z',
        },
        testScenario,
      ),
    ).toBe(true);
  });

  it('rejects a blank originating agenda item', () => {
    expect(
      isSuggestInput(
        { title: 'Post the plan', context: 'c', suggestedAssignee: 'chef', agendaItemTitle: '   ' },
        testScenario,
      ),
    ).toBe(false);
    expect(
      isTask(
        {
          id: 'task-1',
          title: 'Post the plan',
          context: 'c',
          suggestedAssignee: 'chef',
          agendaItemTitle: '   ',
          status: 'SUGGESTED',
          updatedAt: '2026-11-08T00:00:00.000Z',
        },
        testScenario,
      ),
    ).toBe(false);
  });
});

describe('task purpose', () => {
  it('is accepted on a stored task but rejected on a public suggestion', () => {
    const base = {
      id: 'task-1',
      title: 'Publish meeting minutes',
      context: 'The minutes.',
      suggestedAssignee: 'chef' as const,
      status: 'SUGGESTED' as const,
      updatedAt: '2026-11-08T00:00:00.000Z',
    };
    expect(isTask({ ...base, purpose: 'meeting_minutes' }, testScenario)).toBe(true);
    expect(
      isSuggestInput(
        { title: 'Publish meeting minutes', context: 'The minutes.', suggestedAssignee: 'chef', purpose: 'meeting_minutes' },
        testScenario,
      ),
    ).toBe(false);
  });
});
