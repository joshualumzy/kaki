import { roleLabel, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import { speakerLabel, type TranscriptViewer } from './captions';

/** One line of the meeting timeline: something said, a host cue, a nudge, a fact or a change to a task. */
export interface TimelineEntry {
  /** Stable across reconnects, so a replayed event is not listed twice. */
  key: string;
  kind: 'said' | 'host' | 'suggest' | 'nudge' | 'fact' | 'task';
  /** Who said it, when someone did. */
  who?: string;
  text: string;
}

/** The name the host cues are voiced under: the scenario's host character, else "Host". */
export function hostName(scenario: Scenario): string {
  return (scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee ?? 'Host';
}

/** The timeline line for an event, or undefined for the ones that belong elsewhere (the record, tasks). */
export function entryForEvent(
  event: KakiEvent,
  scenario: Scenario,
  viewer: TranscriptViewer | undefined,
  /** True when a person hosts: the host's cues are not spoken, they are lines for that person to say. */
  hostIsViewer = false,
): TimelineEntry | undefined {
  switch (event.type) {
    case 'TRANSCRIPT_CHUNK': {
      const { speaker, text, timestamp } = event.payload;
      return { key: `said|${timestamp}|${speaker}|${text}`, kind: 'said', who: speakerLabel(speaker, viewer), text };
    }
    case 'HOST_SPEECH_TRIGGERED': {
      const { kind, text } = event.payload;
      if (hostIsViewer) return { key: `host|${kind}|${text}`, kind: 'suggest', who: 'You could say', text };
      // The AI host says the cue later, when the room is quiet, and that spoken line arrives as a transcript line.
      // Showing the cue as well would list it before it is heard, and twice.
      return undefined;
    }
    case 'NUDGE':
      return { key: `nudge|${event.payload.text}`, kind: 'nudge', text: event.payload.text };
    case 'FACT_FOUND': {
      const count = event.payload.facts.length;
      const text = `Found ${count} fact${count === 1 ? '' : 's'} on “${event.payload.question}”`;
      return { key: `fact|${event.payload.questionId}|${count}`, kind: 'fact', text };
    }
    default:
      return undefined;
  }
}

const STATUS_WORDS: Record<Task['status'], string> = {
  SUGGESTED: 'suggested',
  DISMISSED: 'dismissed',
  DISPATCHED: 'sent to',
  CLAIMED: 'accepted by',
  DRAFT_READY: 'draft ready for',
  RUNNING: 'running for',
  COMPLETED: 'done for',
  FAILED: 'failed for',
  SYNCED: 'synced for',
};

/** The timeline line for a task that is new or changed status, or undefined when nothing changed. */
export function entryForTask(
  task: Task,
  previousStatus: Task['status'] | undefined,
  scenario: Scenario,
): TimelineEntry | undefined {
  if (task.status === previousStatus) return undefined;
  const owner = task.assignee ?? task.suggestedAssignee;
  const word = STATUS_WORDS[task.status];
  const text =
    task.status === 'SUGGESTED' || task.status === 'DISMISSED'
      ? `Task ${word}: ${task.title}`
      : `Task ${word} ${roleLabel(scenario, owner)}: ${task.title}`;
  return { key: `task|${task.id}|${task.status}`, kind: 'task', text };
}
