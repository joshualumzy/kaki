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
 * The host's welcome, kept short because it is spoken aloud: the meeting, the visitor's role if there is a visitor,
 * the one thing they answer for (their role card's responsibility), the agenda's first item and a hand-over to whoever owns it.
 * The screen already shows who is in the room and the situation.
 * With a visitor it names them instead of the seat's scripted attendee.
 */
export function openingLine(scenario: Scenario, visitor?: Visitor): string {
  const seat = visitor === undefined ? undefined : scenario.attendees.find((attendee) => attendee.name === visitor.seat);
  const parts = [`${OPENING_PREFIX}${scenario.meetingTitle} at ${scenario.organisation}.`];
  if (visitor !== undefined && seat !== undefined) {
    const responsibility = scenario.roles.find((role) => role.id === seat.role)?.card?.responsibility;
    parts.push(`${visitor.name}, you are joining as ${roleLabel(scenario, seat.role)}.${responsibility === undefined ? '' : ` ${responsibility}`}`);
  }
  const first = scenario.agenda[0];
  if (first !== undefined) {
    parts.push(`We have ${scenario.agenda.length} items today. Let's start with ${first.title}, ${first.minutes} minutes.`);
    // Hand over by name, so the first voice a newcomer hears is one they were just told to expect.
    const owner = scenario.attendees.find((attendee) => attendee.role === first.ownerRole);
    const ownerIsHost = scenario.roles.find((role) => role.id === first.ownerRole)?.facilitator === true;
    if (owner !== undefined && !ownerIsHost) {
      parts.push(`${visitor?.seat === owner.name ? visitor.name : owner.name}, over to you.`);
    }
  }
  return parts.join(' ');
}
