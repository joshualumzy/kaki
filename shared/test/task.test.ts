import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, canTransition, type TaskStatus } from '../src/task';

const LEGAL_MOVES: ReadonlyArray<[TaskStatus, TaskStatus]> = [
  ['SUGGESTED', 'DISPATCHED'],
  ['SUGGESTED', 'DISMISSED'],
  ['DISPATCHED', 'CLAIMED'],
  ['CLAIMED', 'DRAFT_READY'],
  ['CLAIMED', 'COMPLETED'],
  ['CLAIMED', 'FAILED'],
  ['DRAFT_READY', 'RUNNING'],
  ['RUNNING', 'COMPLETED'],
  ['RUNNING', 'FAILED'],
  ['FAILED', 'RUNNING'],
  ['FAILED', 'CLAIMED'],
  ['COMPLETED', 'SYNCED'],
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
