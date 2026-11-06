import { roleLabel, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import type { Hub } from '../hub';
import type { TaskStore } from '../tasks';

/** First name of whoever sits in a role in this scenario, else the role's label. */
function addressee(scenario: Scenario, task: Task): string {
  const attendee = scenario.attendees.find((candidate) => candidate.role === task.suggestedAssignee);
  return attendee?.name ?? roleLabel(scenario, task.suggestedAssignee);
}

/** Lowercases a leading verb/capital letter unless the title starts with an acronym or known proper noun. */
function inlineTitle(title: string): string {
  const trimmed = title.trim().replace(/\.$/, '');
  if (trimmed.length < 2) return trimmed;
  if (/^[A-Z]{2,}\b/.test(trimmed) || /^(?:Gitea|Mattermost|Starfruit|Hawker|Nanyang|Kopi|TikTok|Jewel|Raffles|Friday|Monday|Tuesday|Wednesday|Thursday)\b/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed[0]!.toLowerCase()}${trimmed.slice(1)}`;
}

/** Sam's dispatch line; it changes a little from one task to the next so it does not sound canned. */
export function dispatchLine(name: string, title: string, count: number): string {
  const lines = [
    `${name}, I've sent you a task: ${title}. Accept or decline it on your phone.`,
    `${name}, this one is yours: ${title}. Have a look on your phone and accept or decline.`,
    `${name}, can you take on "${inlineTitle(title)}"? It's on your phone.`,
  ];
  return lines[count % lines.length]!;
}

/** How the host asks a colleague who is in the room with everyone else (an AI attendee has no phone to mention). */
export function colleagueLine(name: string, title: string, count: number): string {
  const phrased = inlineTitle(title);
  const lines = [
    `${name}, I'm assigning this follow-up to you: ${phrased}. Can you take that on?`,
    `${name}, let's put that on your list: ${phrased}. Are you good to take it?`,
    `${name}, can you take the lead on this one: ${phrased}?`,
  ];
  return lines[count % lines.length]!;
}

/** How long after a task is dispatched to a role before another task of the same actionKind for the same role is allowed. */
const SAME_ROLE_ACTION_COOLDOWN_MS = 45_000;

/**
 * Sam (the host) hands each newly suggested task straight to the role the notetaker named, and says so aloud.
 * The recipient is the human step: they accept it (claim) or decline it, which puts it back on the shared screen.
 * If the notetaker suggests a duplicate task for the same role and action kind right after one was already dispatched
 * (e.g. from two halves of the same discussion turn), Sam silently dismisses the duplicate so the room is not interrupted twice.
 * A task is left for a person to dispatch from the screen when nobody present can own it: the facilitator's role
 * (Sam himself) or a role nobody in this meeting plays. A role played by an AI attendee has no phone: the NPC process
 * (`npc/taskResponder.ts`) answers for them, aloud, and sends their Accept or Decline.
 */
export function installAutoDispatch({
  hub,
  tasks,
  scenario,
  hostIsHuman = () => false,
}: {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
  /** True while a person plays the host: then every task stays SUGGESTED for them to dispatch or dismiss. */
  hostIsHuman?: () => boolean;
}): () => void {
  let sent = 0;
  const lastDispatchedAt = new Map<string, number>();
  return tasks.onChange((task, previous) => {
    if (previous !== undefined || task.status !== 'SUGGESTED' || hostIsHuman()) return;
    const role = scenario.roles.find((candidate) => candidate.id === task.suggestedAssignee);
    const present = scenario.attendees.some((attendee) => attendee.role === task.suggestedAssignee);
    if (role === undefined || role.facilitator === true || !present) return;

    const dedupeKey = `${task.suggestedAssignee}:${task.actionKind ?? 'manual'}`;
    const lastAt = lastDispatchedAt.get(dedupeKey);
    const now = Date.now();
    if (lastAt !== undefined && now - lastAt < SAME_ROLE_ACTION_COOLDOWN_MS) {
      tasks.transition(task.id, 'DISMISSED');
      return;
    }
    lastDispatchedAt.set(dedupeKey, now);

    tasks.transition(task.id, 'DISPATCHED', { assignee: task.suggestedAssignee });
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: {
        kind: 'DISPATCH',
        // The same words for everyone: nobody in the room can tell which attendees are AI.
        text: dispatchLine(addressee(scenario, task), task.title, sent),
        assignee: addressee(scenario, task),
        title: task.title,
      },
    };
    hub.publish(cue);
    sent += 1;
  });
}
