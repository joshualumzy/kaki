import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';

/** The kind of background action a task can run for its assignee. */
export type ActionKind = 'gitea_issue' | 'mattermost_post' | 'email';

/** A draft action the assignee must approve before anything is written. */
export interface ActionDraft {
  target: string;
  subject: string;
  body: string;
}

/** Lifecycle state of a task on the Shared Action Panel. */
export type TaskStatus =
  | 'SUGGESTED'
  | 'DISMISSED'
  | 'DISPATCHED'
  | 'CLAIMED'
  | 'DRAFT_READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SYNCED';

/** The one task record the server owns, from suggestion to meeting sync. */
export interface Task {
  id: string;
  title: string;
  context: string;
  suggestedAssignee: Role;
  assignee?: Role;
  actionKind?: ActionKind;
  mode?: 'ACTION_AGENT' | 'MANUAL';
  draft?: ActionDraft;
  artifactUrl?: string;
  error?: string;
  status: TaskStatus;
  updatedAt: string;
}

/** The input for suggesting a new task. */
export interface SuggestInput {
  title: string;
  context: string;
  suggestedAssignee: Role;
  actionKind?: ActionKind;
}

/** Every status, in lifecycle order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'SUGGESTED',
  'DISMISSED',
  'DISPATCHED',
  'CLAIMED',
  'DRAFT_READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SYNCED',
];

/** Every action kind Kaki knows how to draft. */
export const ACTION_KINDS: readonly ActionKind[] = ['gitea_issue', 'mattermost_post', 'email'];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  SUGGESTED: ['DISPATCHED', 'DISMISSED'],
  DISMISSED: [],
  DISPATCHED: ['CLAIMED'],
  CLAIMED: ['DRAFT_READY', 'COMPLETED', 'FAILED'],
  DRAFT_READY: ['RUNNING'],
  RUNNING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['SYNCED'],
  FAILED: ['RUNNING'],
  SYNCED: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/** True when a task may move from one status to another; nothing else is legal. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True when a value is a known task status. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** True when a value is a known action kind. */
export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value);
}

/** True when a value is a complete action draft. */
export function isActionDraft(value: unknown): value is ActionDraft {
  return (
    isObject(value) && isString(value.target) && isString(value.subject) && isString(value.body)
  );
}

/** True when a value is a complete task whose roles belong to the scenario. */
export function isTask(value: unknown, scenario: Scenario): value is Task {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isString(value.context) &&
    isRoleIn(scenario, value.suggestedAssignee) &&
    (value.assignee === undefined || isRoleIn(scenario, value.assignee)) &&
    (value.actionKind === undefined || isActionKind(value.actionKind)) &&
    (value.mode === undefined || value.mode === 'ACTION_AGENT' || value.mode === 'MANUAL') &&
    (value.draft === undefined || isActionDraft(value.draft)) &&
    (value.artifactUrl === undefined || isString(value.artifactUrl)) &&
    (value.error === undefined || isString(value.error)) &&
    isTaskStatus(value.status) &&
    isString(value.updatedAt)
  );
}

/** True when a value is a valid task suggestion for the scenario. */
export function isSuggestInput(value: unknown, scenario: Scenario): value is SuggestInput {
  return (
    isObject(value) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.context) &&
    isRoleIn(scenario, value.suggestedAssignee) &&
    (value.actionKind === undefined || isActionKind(value.actionKind))
  );
}
