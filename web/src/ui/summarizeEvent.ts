import type { KakiEvent } from '@kaki/shared';

/** One short line describing an event, used by both page shells. */
export function summarizeEvent(event: KakiEvent): string {
  switch (event.type) {
    case 'TRANSCRIPT_CHUNK':
      return `${event.payload.speaker}: ${event.payload.text}`;
    case 'MEETING_RECORD_UPDATED': {
      const { agendaIndex, openQuestions, elapsedSeconds } = event.payload;
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = String(Math.floor(elapsedSeconds % 60)).padStart(2, '0');
      return `Agenda item ${agendaIndex + 1} · ${openQuestions.length} open questions · ${minutes}:${seconds} elapsed`;
    }
    case 'HOST_SPEECH_TRIGGERED': {
      const label = event.payload.kind === 'TIMEOUT' ? "time's up" : event.payload.kind.toLowerCase();
      return `${label}: ${event.payload.text}`;
    }
    case 'NUDGE':
      return event.payload.text;
    case 'FACT_FOUND': {
      const count = event.payload.facts.length;
      return `${count} fact${count === 1 ? '' : 's'} on “${event.payload.question}”`;
    }
    case 'TASK_UPDATED':
      return `${event.payload.task.title} — ${event.payload.task.status.toLowerCase()}`;
    case 'TOPIC_SETTLED':
      return `Decision locked on “${event.payload.title}”`;
    case 'MEETING_RESET':
      return 'A new meeting started';
    case 'COMMAND_REJECTED':
      return `Command ${event.payload.commandType} rejected: ${event.payload.reason}`;
  }
}
