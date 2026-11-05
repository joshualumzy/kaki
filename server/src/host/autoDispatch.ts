import { roleLabel, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import type { Hub } from '../hub';
import type { TaskStore } from '../tasks';

/** How long an AI attendee gets to answer aloud before the server accepts the task for them. */
const NPC_ACCEPT_DELAY_MS = 4000;

/** First name of whoever sits in a role in this scenario, else the role's label. */
function addressee(scenario: Scenario, task: Task): string {
  const attendee = scenario.attendees.find((candidate) => candidate.role === task.suggestedAssignee);
  return attendee?.name ?? roleLabel(scenario, task.suggestedAssignee);
}

/**
 * Sam (the host) hands each newly suggested task straight to the role the notetaker named, and says so aloud.
 * The recipient is the human step: they accept it (claim) or decline it, which puts it back on the shared screen.
 * A task is left for a person to dispatch from the screen when nobody present can own it: the facilitator's role
 * (Sam himself) or a role nobody in this meeting plays. A role played by an AI attendee has no phone, so the server
 * accepts for them (manual mode) a few seconds after Sam's cue; the shared screen then shows it as accepted.
 */
export function installAutoDispatch({
  hub,
  tasks,
  scenario,
  npcAcceptDelayMs = NPC_ACCEPT_DELAY_MS,
}: {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
  npcAcceptDelayMs?: number;
}): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stopListening = tasks.onChange((task, previous) => {
    if (previous !== undefined || task.status !== 'SUGGESTED') return;
    const role = scenario.roles.find((candidate) => candidate.id === task.suggestedAssignee);
    const present = scenario.attendees.some((attendee) => attendee.role === task.suggestedAssignee);
    if (role === undefined || role.facilitator === true || !present) return;

    const attendee = scenario.attendees.find((candidate) => candidate.role === task.suggestedAssignee);
    const isAi = attendee !== undefined && (scenario.npcs ?? []).some((npc) => npc.attendee === attendee.name);

    tasks.transition(task.id, 'DISPATCHED', { assignee: task.suggestedAssignee });
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: {
        kind: 'DISPATCH',
        text: isAi
          ? `${addressee(scenario, task)}, I've sent you a task: ${task.title}.`
          : `${addressee(scenario, task)}, I've sent you a task: ${task.title}. Accept or decline it on your phone.`,
      },
    };
    hub.publish(cue);

    if (isAi) {
      // An AI attendee has no phone, so the server taps Accept for them once they have had time to answer aloud.
      const timer = setTimeout(() => {
        timers.delete(timer);
        const current = tasks.get(task.id);
        if (current?.status === 'DISPATCHED' && current.assignee === task.suggestedAssignee) {
          tasks.transition(task.id, 'CLAIMED', { mode: 'MANUAL' });
        }
      }, npcAcceptDelayMs);
      timers.add(timer);
    }
  });
  return () => {
    stopListening();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
