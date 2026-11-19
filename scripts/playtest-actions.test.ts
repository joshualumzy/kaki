import { describe, expect, it } from 'vitest';
import {
  draftOnlyRefusal,
  judgeArtifactReachability,
  judgeCardCompletion,
  nextRobotTaskAction,
  wingmanFactVerdicts,
  type ActableTask,
} from './playtest-actions';

const task = (id: string, status: string, assignee = 'producer'): ActableTask => ({
  id, title: `Card ${id}`, status, assignee,
});

describe('draft-only refusal', () => {
  it('allows an unset, empty or zero value and refuses every other value', () => {
    expect(draftOnlyRefusal({})).toBeUndefined();
    expect(draftOnlyRefusal({ KAKI_DRAFT_ONLY: '' })).toBeUndefined();
    expect(draftOnlyRefusal({ KAKI_DRAFT_ONLY: '0' })).toBeUndefined();
    expect(draftOnlyRefusal({ KAKI_DRAFT_ONLY: ' 0 ' })).toBeUndefined();
    expect(draftOnlyRefusal({ KAKI_DRAFT_ONLY: '1' })).toMatch(/without KAKI_DRAFT_ONLY/);
    expect(draftOnlyRefusal({ KAKI_DRAFT_ONLY: 'true' })).toMatch(/local mock tools only/);
  });
});

describe('next robot task action', () => {
  it('claims a dispatched card assigned to the robot role, ignoring other roles and cards', () => {
    const tasks = [task('s', 'SUGGESTED'), task('d', 'DISPATCHED'), task('o', 'DISPATCHED', 'designer')];
    expect(nextRobotTaskAction(tasks, 'producer', new Set(), new Set())).toMatchObject({
      step: 'claim', task: { id: 'd' },
    });
    expect(nextRobotTaskAction(tasks, 'producer', new Set(['d']), new Set())).toBeUndefined();
    expect(nextRobotTaskAction(tasks, 'designer', new Set(), new Set())).toMatchObject({
      step: 'claim', task: { id: 'o' },
    });
  });

  it('approves a drafted card that was claimed and not yet approved', () => {
    const tasks = [task('d', 'DRAFT_READY')];
    expect(nextRobotTaskAction(tasks, 'producer', new Set(['d']), new Set())).toMatchObject({
      step: 'approve', task: { id: 'd' },
    });
    expect(nextRobotTaskAction(tasks, 'producer', new Set(['d']), new Set(['d']))).toBeUndefined();
  });

  it('claims before approving when both are pending', () => {
    const tasks = [task('ready', 'DRAFT_READY'), task('fresh', 'DISPATCHED')];
    expect(nextRobotTaskAction(tasks, 'producer', new Set(['ready']), new Set())).toMatchObject({
      step: 'claim', task: { id: 'fresh' },
    });
  });
});

describe('card completion verdict', () => {
  it('passes a completed or synced card with an artifact URL', () => {
    expect(judgeCardCompletion({ status: 'COMPLETED', artifactUrl: 'http://localhost:3000/x' }, false).ok).toBe(true);
    expect(judgeCardCompletion({ status: 'SYNCED', artifactUrl: 'http://localhost:3000/x' }, false).ok).toBe(true);
    expect(judgeCardCompletion({ status: 'COMPLETED', artifactUrl: '   ' }, false).ok).toBe(false);
    expect(judgeCardCompletion({ status: 'SYNCED', artifactUrl: '   ' }, false).ok).toBe(false);
    expect(judgeCardCompletion({ status: 'SYNCED' }, false).detail).toMatch(/without an artifactUrl/);
  });

  it('fails a failed card with its reason, and a timeout with the last status', () => {
    const failed = judgeCardCompletion({ status: 'FAILED', error: 'tool is not configured' }, false);
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/tool is not configured/);
    expect(judgeCardCompletion({ status: 'DRAFT_READY' }, true).detail).toMatch(/Still DRAFT_READY after 60 s/);
    expect(judgeCardCompletion(undefined, true).detail).toMatch(/No task update within 60 s/);
  });
});

describe('artifact reachability', () => {
  it('accepts 2xx and 3xx, and fails errors or 4xx/5xx', () => {
    expect(judgeArtifactReachability('http://x', 200).ok).toBe(true);
    expect(judgeArtifactReachability('http://x', 302).ok).toBe(true);
    expect(judgeArtifactReachability('http://x', 404).ok).toBe(false);
    expect(judgeArtifactReachability('http://x', undefined, 'ECONNREFUSED').detail).toMatch(/ECONNREFUSED/);
    expect(judgeArtifactReachability('http://x', undefined).ok).toBe(false);
  });
});

describe('wingman fact verdicts', () => {
  it('lists each played topic once, in order, marking the ones with a fact', () => {
    expect(wingmanFactVerdicts([1, 0, 1], new Set([0]))).toEqual([
      { topic: 0, ok: true },
      { topic: 1, ok: false },
    ]);
    expect(wingmanFactVerdicts([], new Set([0]))).toEqual([]);
  });
});
