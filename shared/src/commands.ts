import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';
import { isActionDraft, type ActionDraft } from './task';

/** Everything a client may send back to the server over the meeting socket. */
export type KakiCommand =
  | { type: 'DISPATCH_TASK'; taskId: string; assignee: Role }
  | { type: 'DISMISS_TASK'; taskId: string }
  | { type: 'CLAIM_TASK'; taskId: string; mode: 'ACTION_AGENT' | 'MANUAL' }
  | { type: 'APPROVE_ACTION'; taskId: string; draft: ActionDraft }
  | { type: 'RETRY_ACTION'; taskId: string }
  | { type: 'MARK_DONE'; taskId: string }
  | { type: 'SYNC_TASK'; taskId: string };

const COMMAND_TYPES: readonly KakiCommand['type'][] = [
  'DISPATCH_TASK',
  'DISMISS_TASK',
  'CLAIM_TASK',
  'APPROVE_ACTION',
  'RETRY_ACTION',
  'MARK_DONE',
  'SYNC_TASK',
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
  if (!isObject(value) || !isCommandType(value.type) || !isString(value.taskId)) return false;

  switch (value.type) {
    case 'DISPATCH_TASK':
      return isRoleIn(scenario, value.assignee);
    case 'DISMISS_TASK':
    case 'RETRY_ACTION':
    case 'MARK_DONE':
    case 'SYNC_TASK':
      return true;
    case 'CLAIM_TASK':
      return value.mode === 'ACTION_AGENT' || value.mode === 'MANUAL';
    case 'APPROVE_ACTION':
      return isActionDraft(value.draft);
  }
}
