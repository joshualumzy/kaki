/** The scenario facts a guest seat can see, shared by the AI visitor and the scripted robot. */
import type { Scenario } from '@kaki/shared';
import type { Line } from './live-playtest';

/** Who the guest is, in the words of their own seat card. */
export function guestIdentity(scenario: Scenario, role: string): string {
  const seat = scenario.roles.find((candidate) => candidate.id === role);
  const attendee = scenario.attendees.find((person) => person.role === role);
  return `You are ${attendee?.name ?? 'the guest'}, ${seat?.label ?? role}, the opening-day lead at ${scenario.organisation}. ${seat?.card?.youAre ?? ''} ${seat?.card?.responsibility ?? ''}`
    .replace(/\s+/g, ' ')
    .trim();
}

interface TopicContext {
  briefing: string;
  decision: string;
  seatFact: string;
}

/** The briefing, decision and the seat's own fact for one topic, exactly as the visitor prompt shows them. */
export function topicContext(scenario: Scenario, role: string, topicTitle: string): TopicContext {
  const topic = scenario.agenda.find((item) => item.title === topicTitle);
  return {
    briefing: (topic?.briefing ?? []).map((fact) => fact.text).join(' '),
    decision: topic?.decision ?? '',
    seatFact: topic?.seatFacts?.[role] ?? '',
  };
}

/** Every line the room has heard, labelled with its topic and speaker. */
export function transcriptText(lines: readonly Line[]): string {
  return lines.map((line) => `[topic ${line.agendaIndex + 1}] ${line.speaker}: ${line.text}`).join('\n') || '(no lines yet)';
}
