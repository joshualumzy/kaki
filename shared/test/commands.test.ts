import { describe, expect, it } from 'vitest';
import { isKakiCommand } from '../src/commands';
import { testScenario } from './fixtures';

describe('isKakiCommand', () => {
  it('accepts every command for the scenario', () => {
    expect(isKakiCommand({ type: 'DISPATCH_TASK', taskId: 't1', assignee: 'chef' }, testScenario)).toBe(true);
    expect(isKakiCommand({ type: 'DISMISS_TASK', taskId: 't1' }, testScenario)).toBe(true);
    expect(isKakiCommand({ type: 'CLAIM_TASK', taskId: 't1', mode: 'ACTION_AGENT' }, testScenario)).toBe(true);
    expect(isKakiCommand({ type: 'CLAIM_TASK', taskId: 't1', mode: 'MANUAL' }, testScenario)).toBe(true);
    expect(
      isKakiCommand(
        { type: 'APPROVE_ACTION', taskId: 't1', draft: { target: 'x', subject: 'y', body: 'z' } },
        testScenario,
      ),
    ).toBe(true);
    expect(isKakiCommand({ type: 'RETRY_ACTION', taskId: 't1' }, testScenario)).toBe(true);
    expect(isKakiCommand({ type: 'MARK_DONE', taskId: 't1' }, testScenario)).toBe(true);
    expect(isKakiCommand({ type: 'SYNC_TASK', taskId: 't1' }, testScenario)).toBe(true);
  });

  it('rejects an unknown command or role', () => {
    expect(isKakiCommand({ type: 'DELETE_EVERYTHING', taskId: 't1' }, testScenario)).toBe(false);
    expect(isKakiCommand({ type: 'DISPATCH_TASK', taskId: 't1', assignee: 'waiter' }, testScenario)).toBe(false);
    expect(isKakiCommand({ type: 'DISPATCH_TASK', taskId: 't1' }, testScenario)).toBe(false);
  });

  it('rejects a bad claim mode', () => {
    expect(isKakiCommand({ type: 'CLAIM_TASK', taskId: 't1', mode: 'AUTO' }, testScenario)).toBe(false);
    expect(isKakiCommand({ type: 'CLAIM_TASK', taskId: 't1' }, testScenario)).toBe(false);
  });

  it('rejects a malformed approve draft', () => {
    expect(
      isKakiCommand({ type: 'APPROVE_ACTION', taskId: 't1', draft: { target: 'x', subject: 'y' } }, testScenario),
    ).toBe(false);
    expect(isKakiCommand({ type: 'APPROVE_ACTION', taskId: 't1' }, testScenario)).toBe(false);
  });

  it('rejects non-objects and missing ids', () => {
    expect(isKakiCommand(null, testScenario)).toBe(false);
    expect(isKakiCommand({ type: 'SYNC_TASK' }, testScenario)).toBe(false);
  });
});
