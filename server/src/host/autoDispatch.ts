import { roleLabel, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import type { Hub } from '../hub';
import type { TaskStore } from '../tasks';

/** First name of whoever sits in a role in this scenario, else the role's label. */
function addressee(scenario: Scenario, task: Task): string {
  const attendee = scenario.attendees.find((candidate) => candidate.role === task.suggestedAssignee);
  return attendee?.name ?? roleLabel(scenario, task.suggestedAssignee);
}

/**
 * Sam (the host) hands each newly suggested task straight to the role the notetaker named, and says so aloud.
 * The recipient is the human step: they accept it (claim) or decline it, which puts it back on the shared screen.
 * A task is left for a person to dispatch from the screen when nobody present can own it: the facilitator's role
 * (Sam himself) or a role nobody in this meeting plays. A role played by an AI attendee has no phone: the NPC process
 * (`npc/taskResponder.ts`) answers for them, aloud, and sends their Accept or Decline.
 */
export function installAutoDispatch({
  hub,
  tasks,
  scenario,
}: {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
}): () => void {
  return tasks.onChange((task, previous) => {
    if (previous !== undefined || task.status !== 'SUGGESTED') return;
    const role = scenario.roles.find((candidate) => candidate.id === task.suggestedAssignee);
    const present = scenario.attendees.some((attendee) => attendee.role === task.suggestedAssignee);
    if (role === undefined || role.facilitator === true || !present) return;

    tasks.transition(task.id, 'DISPATCHED', { assignee: task.suggestedAssignee });
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: {
        kind: 'DISPATCH',
        // The same words for everyone: nobody in the room can tell which attendees are AI.
        text: `${addressee(scenario, task)}, I've sent you a task: ${task.title}. Accept or decline it on your phone.`,
      },
    };
    hub.publish(cue);
  });
}
