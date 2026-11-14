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

const SMALL_COUNTS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small counts are spoken as words, because a host reading "2 quick issues" aloud sounds like a form. */
function spokenCount(count: number): string {
  return SMALL_COUNTS[count] ?? String(count);
}

export function cleanSpokenTopic(title: string): string {
  return title
    .replace(/^@/, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+vs\.?\s+/gi, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Converts written headline agenda titles into natural spoken phrases for a live team huddle. */
export function spokenTopicLead(title: string): string {
  return cleanSpokenTopic(title);
}

/**
 * The short name for an agenda item when the host says it aloud mid-sentence: the scenario's `spoken` name when
 * set, otherwise the cleaned-up title.
 */
export function spokenAgendaName(scenario: Scenario, title: string): string {
  const wanted = cleanSpokenTopic(title).toLowerCase();
  const item = scenario.agenda.find((candidate) =>
    candidate.title === title ||
    cleanSpokenTopic(candidate.title).toLowerCase() === wanted ||
    (candidate.spoken !== undefined && candidate.spoken.toLowerCase() === title.trim().toLowerCase()),
  );
  return item?.spoken ?? cleanSpokenTopic(title);
}

/**
 * A warm, natural spoken welcome for the live AI host (`runner.ts`), combining clauses so TTS
 * flows like a real human colleague kicking off a quick team huddle rather than reading bullet points.
 * Pulls the first sentence of `scenario.situation` when available so any scenario is introduced in plain words.
 */
export function liveOpeningLine(scenario: Scenario, visitor?: Visitor): string {
  const seat = visitor === undefined ? undefined : scenario.attendees.find((attendee) => attendee.name === visitor.seat);
  const hostRole = scenario.roles.find((role) => role.facilitator === true);
  const hostAttendee = hostRole === undefined ? undefined : scenario.attendees.find((attendee) => attendee.role === hostRole.id);
  const hostIntro =
    hostAttendee !== undefined && hostRole !== undefined
      ? ` I'm ${hostAttendee.name}, your ${hostRole.label}`
      : '';
  const first = scenario.agenda[0];
  const who =
    visitor !== undefined && seat !== undefined
      ? `, ${visitor.name}.${hostIntro ? `${hostIntro}, and we're` : " We're"} glad you're here as ${roleLabel(scenario, seat.role)}`
      : hostIntro
        ? `.${hostIntro}`
        : '';

  const situationLead = scenario.situation
    ?.split(/\n/)[0]
    ?.split(/(?<=[.!?])\s+/)[0]
    ?.trim()
    .replace(new RegExp(`\\s*${scenario.organisation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*and the team needs your call.*$/i, '')
    .replace(/\.$/, '');

  const lead = scenario.hostBrief?.goal.match(/\bvisitor as ([^.]+)/i)?.[1]?.trim();
  const decisionLead = visitor === undefined || lead === undefined ? '' : ` You're ${lead}, so the calls are yours.`;
  const handoff = first === undefined ? '' : ` Let's start with ${spokenAgendaName(scenario, first.title)}.`;

  if (situationLead !== undefined && situationLead.length > 0 && situationLead.length <= 200) {
    const situationSentence = /[.!?]$/.test(situationLead) ? situationLead : `${situationLead}.`;
    return `${OPENING_PREFIX}our ${scenario.organisation} huddle${who}.${decisionLead} ${situationSentence} We've got ${spokenCount(scenario.agenda.length)} quick issues to settle today.${handoff}`;
  }

  if (first === undefined) return `${OPENING_PREFIX}our ${scenario.organisation} huddle on ${scenario.meetingTitle}${who}.${decisionLead}`;
  return `${OPENING_PREFIX}our ${scenario.organisation} huddle on ${scenario.meetingTitle}${who}.${decisionLead} We've got ${spokenCount(scenario.agenda.length)} quick things to sort out today.${handoff}`;
}

/**
 * A natural spoken transition when the AI host moves the room to the next agenda item (`main.ts`).
 */
export function liveNextItemLine(scenario: Scenario, title: string, _visitor?: Visitor): string {
  return `Next up, ${spokenAgendaName(scenario, title)}.`;
}
