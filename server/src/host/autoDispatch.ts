import { roleLabel, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import type { Hub } from '../hub';
import type { TaskStore } from '../tasks';

/** First name of whoever sits in a role in this scenario, else the role's label. */
function addressee(scenario: Scenario, task: Task): string {
  const attendee = scenario.attendees.find((candidate) => candidate.role === task.suggestedAssignee);
  return attendee?.name ?? roleLabel(scenario, task.suggestedAssignee);
}

/** Lowercases a leading verb/capital letter unless the title starts with an acronym or a proper noun. */
function inlineTitle(title: string): string {
  const trimmed = title.trim().replace(/\.$/, '');
  if (trimmed.length < 2) return trimmed;
  const [first, second] = trimmed.split(/\s+/);
  const looksProper =
    /^[A-Z]{2,}\b/.test(trimmed) ||
    (first !== undefined && (/[a-z][A-Z]/.test(first) || (second !== undefined && /^[A-Z]/.test(second)))) ||
    /^(?:Friday|Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday)\b/.test(trimmed);
  if (looksProper) return trimmed;
  return `${trimmed[0]!.toLowerCase()}${trimmed.slice(1)}`;
}

/** The first word of a task title that reads as the instruction itself ("Draft the poster"). */
const IMPERATIVE_TITLE_START_RE =
  /^(?:add|announce|book|brief|call|check|clean|collect|confirm|contact|cover|create|draft|email|file|find|fix|follow|handle|hold|install|launch|make|move|order|organi[sz]e|plan|post|prepare|print|promote|publish|recruit|remove|replace|reply|resolve|review|ring|run|schedule|send|set|share|sort|take|test|text|train|update|visit|write)\b/i;

/** Sam's dispatch line; it changes a little from one task to the next so it does not sound canned. */
export function dispatchLine(name: string, title: string, count: number): string {
  const lines = [
    `${name}, I've sent you a task: ${title}. Accept or decline it on your phone.`,
    `${name}, this one is yours: ${title}. Have a look on your phone and accept or decline.`,
    `${name}, can you take on "${inlineTitle(title)}"? It's on your phone.`,
  ];
  return lines[count % lines.length]!;
}

/**
 * How the host asks a colleague who is in the room with everyone else (an AI attendee has no phone to mention).
 * An imperative task title goes inline as the request itself; a noun-phrase title is something to take care of.
 */
export function colleagueLine(name: string, title: string, count: number): string {
  const trimmed = title.trim().replace(/[.!?]+$/, '');
  const request = IMPERATIVE_TITLE_START_RE.test(trimmed)
    ? inlineTitle(trimmed)
    : `take care of the ${inlineTitle(trimmed)}`;
  const lines = [
    `${name}, could you ${request}?`,
    `${name}, can you ${request}?`,
    `${name}, would you be able to ${request}?`,
  ];
  return lines[count % lines.length]!;
}

/** What Sam should say when a task goes to a colleague in the room; no line means the colleague speaks for themselves. */
export interface ColleagueCue {
  line?: string;
  /** Set when Sam stays quiet because the colleague already has it. */
  quietBecause?: 'volunteered' | 'was asked';
}

/**
 * Sam asks the colleague only while nobody has put the task to them yet. If they just volunteered, or the visitor
 * already gave it to them, he says nothing and the colleague answers in their own words.
 */
export function colleagueCue(
  name: string,
  title: string,
  count: number,
  already: { volunteered: boolean; assignedByGuest: boolean },
): ColleagueCue {
  if (already.volunteered) return { quietBecause: 'volunteered' };
  if (already.assignedByGuest) return { quietBecause: 'was asked' };
  return { line: colleagueLine(name, title, count) };
}

/**
 * True while a queued request to a colleague is still worth saying: the task has not moved on from DISPATCHED,
 * and the topic it came from is still the one the meeting is on. With neither status nor topic known, keep it.
 */
export function shouldStillAskColleague(
  status: string | undefined,
  topic: string | undefined,
  onCurrentAgenda: (title: string | undefined) => boolean,
): boolean {
  if (status !== undefined && status !== 'DISPATCHED') return false;
  return topic === undefined || onCurrentAgenda(topic);
}

/**
 * Sam (the host) hands each newly suggested task straight to the role the notetaker named, and says so aloud.
 * The recipient is the human step: they accept it (claim) or decline it, which puts it back on the shared screen.
 * In the live NPC meeting, suggestions wait until the Director locks or closes their topic.
 * A task is left for a person to dispatch from the screen when nobody present can own it: the facilitator's role
 * (Sam himself) or a role nobody in this meeting plays. A role played by an AI attendee has no phone: the NPC process
 * (`npc/taskResponder.ts`) answers for them, aloud, and sends their Accept or Decline.
 */
export function installAutoDispatch({
  hub,
  tasks,
  scenario,
  hostIsHuman = () => false,
  holdUntilSettled = false,
}: {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
  /** True while a person plays the host: then every task stays SUGGESTED for them to dispatch or dismiss. */
  hostIsHuman?: () => boolean;
  holdUntilSettled?: boolean;
}): () => void {
  let sent = 0;
  let active = true;
  const settledTopics = new Set<string>();
  const held = new Map<string, Task>();
  const dispatch = (task: Task): void => {
    if (!active || task.status !== 'SUGGESTED' || hostIsHuman()) return;
    const role = scenario.roles.find((candidate) => candidate.id === task.suggestedAssignee);
    const present = scenario.attendees.some((attendee) => attendee.role === task.suggestedAssignee);
    if (role === undefined || role.facilitator === true || !present) return;
    tasks.transition(task.id, 'DISPATCHED', { assignee: task.suggestedAssignee });
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED', audience: { kind: 'screen' },
      payload: { kind: 'DISPATCH', text: dispatchLine(addressee(scenario, task), task.title, sent),
        assignee: addressee(scenario, task), title: task.title },
    };
    hub.publish(cue);
    sent += 1;
  };
  const release = (title?: string, priorityId?: string): void => {
    const candidates = [...held.values()].filter((task) => title === undefined || task.agendaItemTitle === title);
    candidates.sort((left, right) => Number(right.id === priorityId) - Number(left.id === priorityId));
    const released: Task[] = [];
    for (const task of candidates) {
      held.delete(task.id);
      const current = tasks.get(task.id);
      if (current?.status !== 'SUGGESTED') continue;
      if (released.some((earlier) => earlier.agendaItemTitle === task.agendaItemTitle &&
          earlier.suggestedAssignee === current.suggestedAssignee && earlier.actionKind === current.actionKind &&
          earlier.title.trim().toLowerCase() === current.title.trim().toLowerCase())) {
        tasks.transition(task.id, 'DISMISSED');
        continue;
      }
      dispatch(current);
      released.push(current);
    }
  };
  const unsubscribeReset = hub.subscribe((event) => {
    if (event.type === 'MEETING_RESET') {
      sent = 0;
      settledTopics.clear();
      held.clear();
    } else if (event.type === 'TOPIC_SETTLED') {
      settledTopics.add(event.payload.title);
      release(event.payload.title, event.payload.taskId);
    }
  });
  hub.onCommand((command, sender) => {
    if (!active || sender !== 'screen') return;
    if (command.type === 'NEXT_AGENDA_ITEM' || command.type === 'END_MEETING') release();
  });
  const unsubscribeTasks = tasks.onChange((task, previous) => {
    if (!active || previous !== undefined || task.status !== 'SUGGESTED' || hostIsHuman()) return;
    if (holdUntilSettled && task.agendaItemTitle !== undefined && !settledTopics.has(task.agendaItemTitle)) {
      held.set(task.id, task);
      return;
    }
    dispatch(task);
  });
  return () => {
    active = false;
    unsubscribeReset();
    unsubscribeTasks();
  };
}
