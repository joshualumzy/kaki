import type { KakiEvent } from '@kaki/shared';
import type { ClientAudience } from './audience';

/**
 * The commands the AI runner may send on its authenticated command sockets. It acts for the screen
 * to advance/end and for its own roles to accept or approve a task, and nothing else. Pause is not
 * here: a person's Stop/Resume goes straight from their browser to the server, never via the runner.
 */
const RUNNER_SCREEN_COMMANDS = new Set(['NEXT_AGENDA_ITEM', 'END_MEETING', 'SET_HOST_MODE']);
/**
 * The screen commands a practice visitor may send for their own practice meeting. The practice
 * credential is a lower-trust capability than the owner's screen, so it still cannot dispatch,
 * dismiss, reset or pause the room; it may only move its own agenda, end its own practice, and
 * use its own private Wingman.
 */
export const PRACTICE_SCREEN_COMMANDS = new Set([
  'NEXT_AGENDA_ITEM',
  'END_MEETING',
  'ASK_WINGMAN',
  'DISMISS_WINGMAN_NOTE',
]);
const RUNNER_ROLE_COMMANDS = new Set([
  'CLAIM_TASK',
  'DECLINE_TASK',
  'RETURN_TASK_UNDECIDED',
  'APPROVE_ACTION',
  'RETRY_ACTION',
]);

/** True when the runner's connection for this audience may send the command. */
export function runnerMaySend(audience: ClientAudience, commandType: string): boolean {
  if (audience.kind === 'screen') return RUNNER_SCREEN_COMMANDS.has(commandType);
  if (audience.kind !== 'role') return false;
  return RUNNER_ROLE_COMMANDS.has(commandType);
}

/** The rejection event for a command this audience may not send, aimed back at that audience. */
export function rejectionFor(
  audience: ClientAudience,
  commandType: string,
  reason: string,
  seat?: string,
): KakiEvent {
  return {
    type: 'COMMAND_REJECTED',
    audience:
      audience.kind === 'screen'
        ? { kind: 'screen' }
        : audience.kind === 'participant'
          ? seat === undefined
            ? { kind: 'screen' }
            : { kind: 'role', role: seat }
          : audience.kind === 'role'
            ? audience
            : { kind: 'screen' },
    payload: { commandType, reason },
  };
}
