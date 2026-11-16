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

/** Joins spoken list items the way people say them: "A, B, and C". */
function spokenList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** Name the colleagues once without reading their job titles aloud. */
function colleagueIntroductions(scenario: Scenario, hostName: string | undefined, visitor?: Visitor): string {
  const npcNames = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
  const colleagues = scenario.attendees.filter((attendee) =>
    attendee.name !== hostName &&
    attendee.name !== visitor?.seat &&
    (npcNames.size === 0 || npcNames.has(attendee.name)));
  return spokenList(colleagues.map((attendee) => attendee.name));
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

function findAgendaItem(scenario: Scenario, title: string) {
  const wanted = cleanSpokenTopic(title).toLowerCase();
  return scenario.agenda.find((candidate) =>
    candidate.title === title ||
    cleanSpokenTopic(candidate.title).toLowerCase() === wanted ||
    (candidate.spoken !== undefined && candidate.spoken.toLowerCase() === title.trim().toLowerCase()),
  );
}

/**
 * The short name for an agenda item when the host says it aloud mid-sentence: the scenario's `spoken` name when
 * set, otherwise the cleaned-up title.
 */
export function spokenAgendaName(scenario: Scenario, title: string): string {
  return findAgendaItem(scenario, title)?.spoken ?? cleanSpokenTopic(title);
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
  const hostIntro = hostAttendee === undefined ? '' : ` I'm ${hostAttendee.name}`;
  const first = scenario.agenda[0];
  const colleagues = colleagueIntroductions(scenario, hostAttendee?.name, visitor);
  const role = visitor !== undefined && seat !== undefined ? `, our ${roleLabel(scenario, seat.role)}` : '';
  const lead = `${OPENING_PREFIX}${scenario.organisation}${visitor === undefined ? '' : `, ${visitor.name}${role}`}`;
  const welcome = hostIntro !== ''
    ? `${lead};${hostIntro}${colleagues === '' ? '' : `, with ${colleagues} here`}.`
    : `${lead}${colleagues === '' ? '' : `; ${colleagues} are here`}.`;
  // The guest must hear that the decisions are theirs, or they wait for Sam to lead.
  const visitorLead = scenario.hostBrief?.goal.match(/\bvisitor as ([^.]+)/i)?.[1]?.trim();
  const decisionLead = visitor === undefined || visitorLead === undefined ? '' : ` You're ${visitorLead}, so the calls are yours.`;

  const situationLead = scenario.situation
    ?.split(/\n/)[0]
    ?.split(/(?<=[.!?])\s+/)[0]
    ?.trim()
    .replace(new RegExp(`\\s*${scenario.organisation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*and the team needs your call.*$/i, '')
    .replace(/\.$/, '');

  const handoff = first === undefined ? '' : ` First, ${spokenAgendaName(scenario, first.title)}.`;

  if (situationLead !== undefined && situationLead.length > 0 && situationLead.length <= 200) {
    const situationSentence = /[.!?]$/.test(situationLead) ? situationLead : `${situationLead}.`;
    const shortSituation = situationSentence.replace(/ on opening day at our refurbished /i, ' at our ');
    return `${welcome}${decisionLead} ${shortSituation}${handoff}`.replace(/\s+/g, ' ').trim();
  }

  return `${welcome}${decisionLead}${handoff}`.replace(/\s+/g, ' ').trim();
}

const NEXT_ITEM_LINES: ReadonlyArray<(topic: string) => string> = [
  (topic) => `Next up, ${topic}.`,
  (topic) => `Right, let's move on to ${topic}.`,
  (topic) => `Okay, on to ${topic}.`,
  (topic) => `Let's move to ${topic} now.`,
];

const WRAP_UP_LINES: ReadonlyArray<(topic: string) => string> = [
  (topic) => `Let's leave ${topic} there.`,
  (topic) => `Good, that's ${topic} sorted.`,
  (topic) => `Okay, ${topic} is done.`,
  (topic) => `Right, that settles ${topic}.`,
];

function agendaLine(lines: ReadonlyArray<(topic: string) => string>, scenario: Scenario, title: string): string {
  const index = scenario.agenda.findIndex((item) => item.title === findAgendaItem(scenario, title)?.title);
  return lines[Math.max(0, index) % lines.length]!(spokenAgendaName(scenario, title));
}

/**
 * A natural spoken transition when the AI host moves the room to the next agenda item (`main.ts`),
 * handing over by name to the colleague who owns it when that lead is known.
 */
export function liveNextItemLine(
  scenario: Scenario,
  title: string,
  visitor?: Visitor,
  briefFollows = false,
): string {
  const item = findAgendaItem(scenario, title);
  const owner = item === undefined ? undefined : scenario.attendees.find((attendee) => attendee.role === item.ownerRole);
  const ownerIsHost = item !== undefined && scenario.roles.find((role) => role.id === item.ownerRole)?.facilitator === true;
  const lead = owner === undefined || ownerIsHost
    ? undefined
    : visitor !== undefined && visitor.seat === owner.name
      ? visitor.name
      : owner.name;
  const handoff = lead === undefined || briefFollows ? '' : ` ${lead}, over to you.`;
  return `${agendaLine(NEXT_ITEM_LINES, scenario, title)}${handoff}`;
}

/** The host's spoken wrap-up when a topic is left, picked by that topic's place in the agenda. */
export function liveWrapUpLine(scenario: Scenario, title: string): string {
  return agendaLine(WRAP_UP_LINES, scenario, title);
}
