import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';
import { isActionDraft, type ActionDraft } from './task';

/** Everything a client may send back to the server over the meeting socket. */
export type KakiCommand =
  | { type: 'DISPATCH_TASK'; taskId: string; assignee: Role }
  | { type: 'DISMISS_TASK'; taskId: string }
  | { type: 'DECLINE_TASK'; taskId: string }
  | { type: 'CLAIM_TASK'; taskId: string; mode: 'ACTION_AGENT' | 'MANUAL' }
  | { type: 'APPROVE_ACTION'; taskId: string; draft: ActionDraft }
  | { type: 'RETRY_ACTION'; taskId: string; draft?: ActionDraft }
  | { type: 'MARK_DONE'; taskId: string }
  | { type: 'SYNC_TASK'; taskId: string }
  /** Screen only. Ends the meeting; `silent` skips the spoken closing line (nobody is left to hear it). */
  | { type: 'END_MEETING'; silent?: boolean }
  /** Screen only. The host moves the meeting on to the next agenda item. */
  | { type: 'NEXT_AGENDA_ITEM' };

const COMMAND_TYPES: readonly KakiCommand['type'][] = [
  'DISPATCH_TASK',
  'DISMISS_TASK',
  'DECLINE_TASK',
  'CLAIM_TASK',
  'APPROVE_ACTION',
  'RETRY_ACTION',
  'MARK_DONE',
  'SYNC_TASK',
  'END_MEETING',
  'NEXT_AGENDA_ITEM',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCommandType(value: unknown): value is KakiCommand['type'] {
  return typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value);
}

/** Validate unknown data (such as JSON from a socket) as a command for the scenario. */
export function isKakiCommand(value: unknown, scenario: Scenario): value is KakiCommand {
  if (!isObject(value) || !isCommandType(value.type)) return false;
  if (value.type === 'NEXT_AGENDA_ITEM') return true;
  if (value.type === 'END_MEETING') return value.silent === undefined || typeof value.silent === 'boolean';
  if (!isString(value.taskId)) return false;

  switch (value.type) {
    case 'DISPATCH_TASK':
      return isRoleIn(scenario, value.assignee);
    case 'DISMISS_TASK':
    case 'DECLINE_TASK':
    case 'MARK_DONE':
    case 'SYNC_TASK':
      return true;
    case 'CLAIM_TASK':
      return value.mode === 'ACTION_AGENT' || value.mode === 'MANUAL';
    case 'APPROVE_ACTION':
      return isActionDraft(value.draft);
    case 'RETRY_ACTION':
      return value.draft === undefined || isActionDraft(value.draft);
  }
}
