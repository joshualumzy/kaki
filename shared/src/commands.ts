import { isNonEmptyString, isObject, isString } from './guards';
import type { Role } from './roles';
import { isRoleIn } from './scenario';
import type { Scenario } from './scenarioTypes';
import { isActionDraft, type ActionDraft } from './task';

/** Everything a client may send back to the server over the meeting socket. */
export type KakiCommand =
  | { type: 'DISPATCH_TASK'; taskId: string; assignee: Role }
  | { type: 'DISMISS_TASK'; taskId: string }
  | { type: 'DECLINE_TASK'; taskId: string }
  /**
   * The assignee could not understand the task well enough to accept or decline it. The card goes back to the
   * shared screen unresolved, without counting as a decline, so a host can re-dispatch or dismiss it.
   */
  | { type: 'RETURN_TASK_UNDECIDED'; taskId: string }
  | { type: 'CLAIM_TASK'; taskId: string; mode: 'ACTION_AGENT' | 'MANUAL' }
  | { type: 'APPROVE_ACTION'; taskId: string; draft: ActionDraft }
  | { type: 'RETRY_ACTION'; taskId: string; draft?: ActionDraft }
  | { type: 'MARK_DONE'; taskId: string }
  | { type: 'SYNC_TASK'; taskId: string }
  /** A person in a seat asks their private Wingman; the role comes from the sending socket's seat. */
  | { type: 'ASK_WINGMAN'; question: string }
  /** A person closes one of their own private Wingman notes. */
  | { type: 'DISMISS_WINGMAN_NOTE'; id: string }
  /** Screen only. Ends the meeting; `silent` skips the spoken closing line (nobody is left to hear it). */
  | { type: 'END_MEETING'; silent?: boolean }
  /** Screen only. Throws away the meeting, restored or not, and its saved copy, so the next line starts fresh. */
  | { type: 'NEW_MEETING' }
  /** Screen only. The host moves the meeting on to the next agenda item. */
  | { type: 'NEXT_AGENDA_ITEM' }
  /** Screen only. Whether a person (not the AI) is in the host's seat: while one is, Sam does not dispatch tasks by himself. */
  | { type: 'SET_HOST_MODE'; human: boolean }
  /**
   * The shared screen (host) or a person seated in this meeting. Pauses or resumes the agenda
   * clock when the visitor clicks Pause / Play. Sent straight to the server, never via the runner.
   */
  | { type: 'SET_PAUSED'; paused: boolean }
  /**
   * A person in a real meeting takes the room off the record, or brings it back on. While off the
   * record nothing is transcribed, analysed or stored; anyone in the meeting may resume.
   */
  | { type: 'SET_OFF_THE_RECORD'; on: boolean }
  /**
   * A person's finalized speech or typed line, sent straight to the server so the transcript is
   * written even when no AI runner is present. The speaker comes from the sending socket's seat;
   * `clientLineId` lets a retry be recognised as the same line. `meetingId` (and, for a seat, the
   * `seat` it was typed in) binds a line held across a reconnect to the meeting it belongs to; the
   * server refuses a line whose meeting is no longer current.
   */
  | {
      type: 'HUMAN_LINE';
      text: string;
      source: 'speech' | 'typed';
      clientLineId: string;
      meetingId?: string;
      seat?: Role;
    };

const COMMAND_TYPES: readonly KakiCommand['type'][] = [
  'DISPATCH_TASK',
  'DISMISS_TASK',
  'DECLINE_TASK',
  'RETURN_TASK_UNDECIDED',
  'CLAIM_TASK',
  'APPROVE_ACTION',
  'RETRY_ACTION',
  'MARK_DONE',
  'SYNC_TASK',
  'ASK_WINGMAN',
  'DISMISS_WINGMAN_NOTE',
  'END_MEETING',
  'NEW_MEETING',
  'NEXT_AGENDA_ITEM',
  'SET_HOST_MODE',
  'SET_PAUSED',
  'SET_OFF_THE_RECORD',
  'HUMAN_LINE',
];

function isCommandType(value: unknown): value is KakiCommand['type'] {
  return typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value);
}

/** Validate unknown data (such as JSON from a socket) as a command for the scenario. */
export function isKakiCommand(value: unknown, scenario: Scenario): value is KakiCommand {
  if (!isObject(value) || !isCommandType(value.type)) return false;
  if (value.type === 'NEXT_AGENDA_ITEM' || value.type === 'NEW_MEETING') return true;
  if (value.type === 'SET_HOST_MODE') return typeof value.human === 'boolean';
  if (value.type === 'SET_PAUSED') return typeof value.paused === 'boolean';
  if (value.type === 'SET_OFF_THE_RECORD') return typeof value.on === 'boolean';
  if (value.type === 'HUMAN_LINE') {
    return (
      isString(value.text) &&
      value.text.trim() !== '' &&
      (value.source === 'speech' || value.source === 'typed') &&
      isString(value.clientLineId) &&
      value.clientLineId.trim() !== '' &&
      (value.meetingId === undefined || isNonEmptyString(value.meetingId)) &&
      (value.seat === undefined || isRoleIn(scenario, value.seat))
    );
  }
  if (value.type === 'END_MEETING') return value.silent === undefined || typeof value.silent === 'boolean';
  if (value.type === 'ASK_WINGMAN') return isString(value.question) && value.question.trim() !== '';
  if (value.type === 'DISMISS_WINGMAN_NOTE') return isNonEmptyString(value.id);
  if (!isString(value.taskId)) return false;

  switch (value.type) {
    case 'DISPATCH_TASK':
      return isRoleIn(scenario, value.assignee);
    case 'DISMISS_TASK':
    case 'DECLINE_TASK':
    case 'RETURN_TASK_UNDECIDED':
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
