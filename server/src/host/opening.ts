import { roleLabel, type Scenario } from '@kaki/shared';

/** Every opening line starts with this, so the AI attendees can tell it from the other host cues. */
export const OPENING_PREFIX = 'Welcome to ';

/** A person who joined the meeting: the name they typed and the attendee seat they took. */
export interface Visitor {
  name: string;
  /** The `name` of the scenario attendee whose seat they took. */
  seat: string;
}

/**
 * The host's welcome: who and what the meeting is, who is in the room, the agenda and the first item.
 * With a visitor it names them instead of the seat's scripted attendee and tells them which role they have.
 */
export function openingLine(scenario: Scenario, visitor?: Visitor): string {
  const seat = visitor === undefined ? undefined : scenario.attendees.find((attendee) => attendee.name === visitor.seat);
  const parts = [`${OPENING_PREFIX}${scenario.meetingTitle} at ${scenario.organisation}.`];
  if (visitor !== undefined && seat !== undefined) {
    parts.push(`${visitor.name}, you are joining as ${roleLabel(scenario, seat.role)}.`);
  }
  const situation = scenario.situation?.trim();
  if (situation) parts.push(/[.!?]$/.test(situation) ? situation : `${situation}.`);
  if (scenario.attendees.length > 0) {
    const people = scenario.attendees.map((attendee) => {
      const name = visitor !== undefined && attendee.name === visitor.seat ? visitor.name : attendee.name;
      return `${name}, ${roleLabel(scenario, attendee.role)}`;
    });
    parts.push(`In the room: ${people.join('; ')}.`);
  }
  const first = scenario.agenda[0];
  if (first !== undefined) {
    const titles = scenario.agenda.map((item) => item.title);
    parts.push(`We have ${titles.length} items today: ${titles.join(', ')}.`);
    parts.push(`Let's start with ${first.title}, ${first.minutes} minutes.`);
  }
  return parts.join(' ');
}
