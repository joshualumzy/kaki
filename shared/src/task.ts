import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';

/** The kind of background action a task can run for its assignee. */
export type ActionKind = 'gitea_issue' | 'mattermost_post' | 'email' | 'wiki_page' | 'calendar_event';

/** Why the server created a task itself, when it is a meeting milestone rather than a follow-up. */
export type TaskPurpose = 'meeting_minutes';

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
  | 'SYNCED'
  | 'SUPERSEDED';

/**
 * The exact task the speaker committed to, captured when the commitment was recorded. Any later change to the work
 * (title, context or action) is a different task, so the old commitment cannot authorise it.
 */
export interface AssignmentScope {
  title: string;
  context: string;
  actionKind?: ActionKind;
}

/**
 * The grounded transcript line where the assignee volunteered for the task. It is recorded by the trusted notetaker
 * from the actual transcript speaker, never chosen by the model, so the responder can hold them to their own words.
 */
export interface AssignmentEvidence {
  /** The speaker exactly as they appear in the transcript. */
  speaker: string;
  /** The verbatim transcript line that states the commitment. */
  quote: string;
  /** The complete task snapshot at the moment the commitment was recorded. */
  scope: AssignmentScope;
}

/** The one task record the server owns, from suggestion to meeting sync. */
export interface Task {
  id: string;
  title: string;
  context: string;
  suggestedAssignee: Role;
  assignee?: Role;
  /** Roles that were offered this task and turned it down; the task is back to SUGGESTED. */
  declinedBy?: Role[];
  actionKind?: ActionKind;
  /** The server-owned milestone this task serves, if it was not created from a person's follow-up. */
  purpose?: TaskPurpose;
  /**
   * The accepted decision this task announces, copied verbatim from the transcript. The notetaker only keeps a
   * model-selected quote when it matches a line on the current agenda item, so this is grounded, not proof that the
   * model picked the right decision.
   */
  decisionSource?: string;
  /** The agenda item this task came from, stamped by the notetaker so later callbacks stay on their own topic. */
  agendaItemTitle?: string;
  /**
   * Seconds since the meeting started at which the source transcript line was spoken, stamped by trusted server code
   * when the card is created. Artifacts use it to say where in the meeting they came from.
   */
  sourceSeconds?: number;
  /** The assignee's own grounded commitment this task came from, if they volunteered for it directly. */
  assignmentEvidence?: AssignmentEvidence;
  mode?: 'ACTION_AGENT' | 'MANUAL';
  draft?: ActionDraft;
  artifactUrl?: string;
  error?: string;
  /**
   * True when the server restarted while this task was being worked on. It is set by the restore and cleared by the
   * next transition, so nothing retries it automatically: only the assignee tapping Retry does.
   */
  interrupted?: boolean;
  status: TaskStatus;
  updatedAt: string;
}

/** The input for suggesting a new task. */
export interface SuggestInput {
  title: string;
  context: string;
  suggestedAssignee: Role;
  actionKind?: ActionKind;
  /** The server-owned milestone this task serves, if it is not a person's follow-up. */
  purpose?: TaskPurpose;
  /** The accepted decision this task announces, verbatim from the transcript. */
  decisionSource?: string;
  /** The agenda item this task came from, stamped by the notetaker; never chosen by the model. */
  agendaItemTitle?: string;
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
  'SUPERSEDED',
];

/** Every action kind Kaki knows how to draft. */
export const ACTION_KINDS: readonly ActionKind[] = [
  'gitea_issue',
  'mattermost_post',
  'email',
  'wiki_page',
  'calendar_event',
];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  SUGGESTED: ['DISPATCHED', 'DISMISSED', 'SUPERSEDED'],
  DISMISSED: [],
  DISPATCHED: ['CLAIMED', 'SUGGESTED', 'DISMISSED', 'SUPERSEDED'],
  CLAIMED: ['DRAFT_READY', 'COMPLETED', 'FAILED', 'SUPERSEDED'],
  DRAFT_READY: ['RUNNING', 'SUPERSEDED'],
  RUNNING: ['COMPLETED', 'FAILED', 'SUPERSEDED'],
  COMPLETED: ['SYNCED', 'SUPERSEDED'],
  FAILED: ['RUNNING', 'CLAIMED', 'SUPERSEDED'],
  SYNCED: ['SUPERSEDED'],
  SUPERSEDED: [],
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

/** True when a value is a known task purpose. */
export function isTaskPurpose(value: unknown): value is TaskPurpose {
  return value === 'meeting_minutes';
}

/** True when a value is a complete action draft. */
export function isActionDraft(value: unknown): value is ActionDraft {
  return (
    isObject(value) && isString(value.target) && isString(value.subject) && isString(value.body)
  );
}

/** True when a value is a complete snapshot of the task a speaker volunteered for. */
export function isAssignmentScope(value: unknown): value is AssignmentScope {
  return (
    isObject(value) &&
    isNonEmptyString(value.title) &&
    isString(value.context) &&
    (value.actionKind === undefined || isActionKind(value.actionKind))
  );
}

/** True when a value is a grounded assignment evidence object recorded from the transcript. */
export function isAssignmentEvidence(value: unknown): value is AssignmentEvidence {
  return (
    isObject(value) &&
    isNonEmptyString(value.speaker) &&
    isNonEmptyString(value.quote) &&
    isAssignmentScope(value.scope)
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
    (value.declinedBy === undefined ||
      (Array.isArray(value.declinedBy) && value.declinedBy.every((role) => isRoleIn(scenario, role)))) &&
    (value.actionKind === undefined || isActionKind(value.actionKind)) &&
    (value.purpose === undefined || isTaskPurpose(value.purpose)) &&
    (value.decisionSource === undefined || isNonEmptyString(value.decisionSource)) &&
    (value.agendaItemTitle === undefined || isNonEmptyString(value.agendaItemTitle)) &&
    (value.sourceSeconds === undefined ||
      (typeof value.sourceSeconds === 'number' && Number.isFinite(value.sourceSeconds) && value.sourceSeconds >= 0)) &&
    (value.assignmentEvidence === undefined || isAssignmentEvidence(value.assignmentEvidence)) &&
    (value.mode === undefined || value.mode === 'ACTION_AGENT' || value.mode === 'MANUAL') &&
    (value.draft === undefined || isActionDraft(value.draft)) &&
    (value.artifactUrl === undefined || isString(value.artifactUrl)) &&
    (value.error === undefined || isString(value.error)) &&
    (value.interrupted === undefined || typeof value.interrupted === 'boolean') &&
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
    (value.actionKind === undefined || isActionKind(value.actionKind)) &&
    (value.purpose === undefined || isTaskPurpose(value.purpose)) &&
    (value.decisionSource === undefined || isNonEmptyString(value.decisionSource)) &&
    (value.agendaItemTitle === undefined || isNonEmptyString(value.agendaItemTitle))
  );
}
