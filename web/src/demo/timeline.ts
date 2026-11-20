import type { KakiEvent, Scenario, Task } from '@kaki/shared';
import { cutLineText, speakerLabel, type TranscriptViewer } from './captions';

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
  viewer: TranscriptViewer | undefined,
  /** True when a person hosts: the host's cues are not spoken, they are lines for that person to say. */
  hostIsViewer = false,
  scenario?: Scenario,
): TimelineEntry | undefined {
  switch (event.type) {
    case 'TRANSCRIPT_CHUNK': {
      const { speaker, text, timestamp, lineId } = event.payload;
      return {
        // A later cut or restore carries the same line id, so it replaces the line instead of listing it twice.
        key: lineId === undefined ? `said|${timestamp}|${speaker}|${text}` : `said|${lineId}`,
        kind: 'said',
        who: speakerLabel(speaker, viewer, scenario),
        text,
      };
    }
    case 'TRANSCRIPT_LINE_UPDATED': {
      const { speaker, lineId, text, cut } = event.payload;
      return {
        key: `said|${lineId}`,
        kind: 'said',
        who: speakerLabel(speaker, viewer, scenario),
        text: cut ? cutLineText(text) : text,
      };
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

/**
 * The one timeline line a task gets: when Kaki first notices it. The feed is for what people said; the task list shows where
 * a task is and why it failed, and five status lines per task (sent, accepted, draft ready, running, done) buried the talk.
 */
export function entryForTask(
  task: Task,
  previousStatus: Task['status'] | undefined,
): TimelineEntry | undefined {
  if (task.status === previousStatus || task.status !== 'SUGGESTED') return undefined;
  return { key: `task|${task.id}|${task.status}`, kind: 'task', text: `Kaki noticed a task: ${task.title}` };
}
