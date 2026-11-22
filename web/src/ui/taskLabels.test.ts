import type { Task } from '@kaki/shared';
import { describe, expect, it } from 'vitest';
import { artifactLinkText, taskStatusText } from './taskLabels';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Fix the oven',
    context: 'The oven trips the fuse.',
    suggestedAssignee: 'chef',
    status: 'DRAFT_READY',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('taskStatusText', () => {
  it('uses the friendly text for the active states', () => {
    expect(taskStatusText(task({ status: 'CLAIMED', mode: 'ACTION_AGENT' }))).toBe('drafting…');
    expect(taskStatusText(task({ status: 'CLAIMED' }))).toBe('accepted');
    expect(taskStatusText(task({ status: 'DRAFT_READY' }))).toBe('reviewing draft…');
    expect(taskStatusText(task({ status: 'RUNNING' }))).toBe('publishing…');
  });

  it('falls back to the lowercased status', () => {
    expect(taskStatusText(task({ status: 'DRAFT_READY' }))).toBe('reviewing draft…');
    expect(taskStatusText(task({ status: 'SYNCED' }))).toBe('synced');
  });

  it('only names an unresolved decision when the caller asks for it', () => {
    expect(taskStatusText(task({ status: 'SUGGESTED', error: 'No owner' }))).toBe('suggested');
    expect(taskStatusText(task({ status: 'SUGGESTED', error: 'No owner' }), { unresolvedSuggested: true })).toBe(
      'Decision unresolved',
    );
    expect(taskStatusText(task({ status: 'SUGGESTED' }), { unresolvedSuggested: true })).toBe('suggested');
  });
});

describe('artifactLinkText', () => {
  it('names the tool that holds the artifact', () => {
    expect(artifactLinkText(task({ actionKind: 'gitea_issue' }))).toBe('Open live in Gitea ↗');
    expect(artifactLinkText(task({ actionKind: 'mattermost_post' }))).toBe('Open live in Mattermost ↗');
    expect(artifactLinkText(task({ actionKind: 'wiki_page' }))).toBe('Open live in Wiki ↗');
    expect(artifactLinkText(task({ actionKind: 'email' }))).toBe('Open live in Mailpit ↗');
    expect(artifactLinkText(task({ actionKind: 'calendar_event' }))).toBe('Open live in Calendar ↗');
  });

  it('falls back to a generic artifact label', () => {
    expect(artifactLinkText(task())).toBe('Open live artifact ↗');
  });
});
