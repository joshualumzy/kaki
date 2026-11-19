import type { Role } from './roles';
import { ACTION_KINDS, type ActionKind } from './task';

/** One role the active scenario defines, with the label people see. */
export interface ScenarioRole {
  id: Role;
  label: string;
  /**
   * The role that runs the meeting (for example Sam, the studio manager). It is never counted as quiet or offered to a
   * participant. An AI plays it unless its attendee's npc is `playable`, which makes it the host mode seat.
   */
  facilitator?: boolean;
  /** What a person playing this role is told on their Wingman: facts, not a script. */
  card?: RoleCard;
}

/** A short, open-ended briefing for the person playing a role in the live demo meeting. */
export interface RoleCard {
  /** Who they are and what the meeting is for, in a sentence. */
  youAre: string;
  /** Things they know from their side of the company. */
  facts: string[];
  /** What they are answerable for. */
  responsibility: string;
}

/** A participant joining the meeting, with the name Zoom shows for them. */
export interface Attendee {
  name: string;
  role: Role;
  zoomDisplayName: string;
  /** A few plain words for their job, said after their name when the host introduces them, for example "on tills and tech". */
  spokenJob?: string;
}

/** One agenda item with its time limit and the role that owns it. */
export interface AgendaItem {
  title: string;
  minutes: number;
  /** Whether this item's decision can be deferred to a later slot, or has to be made now; required by validation. */
  canWait: boolean;
  /** When the decision has to be made, said aloud in plain words ("before doors open at 8"); required by validation. */
  deadline: string;
  ownerRole: Role;
  /** The call this item exists to get, as a question to the person who decides ("Do we ship as is, or hold the date?"); optional. */
  decision?: string;
  /** The characters disagree on this item, so the person is asked to settle it; optional. */
  contested?: boolean;
  /** Structured opening angles and trade-offs the AI colleagues can draw on; optional. */
  discussion?: AgendaDiscussion;
  /** What the room is told at the start, split into facts so only the colleagues who would know each one say it. */
  briefing?: BriefingFact[];
  /** Short name used when the host refers to the item aloud, e.g. "the food safety complaint". */
  spoken?: string;
  /** Artwork for this item, if the scenario provides it. */
  art?: string;
  /** Hidden possible directions for this topic: background for the AI, never a menu read aloud. */
  directions?: string[];
  /** Facts tied to this topic that every colleague may use, such as established facts. */
  background?: string[];
  /** A sensitive item calls for a serious, respectful tone. */
  sensitive?: boolean;
  /** A person outside the meeting who can answer once in this topic, when a colleague says they will ask. */
  offScreen?: AgendaOffScreen;
  /** Each seat's one fact for this topic, keyed by role id. */
  seatFacts?: Record<string, string>;
  /** Other topics this one links to, with one sentence on what carries across. */
  links?: AgendaLink[];
  /** Figures that may be spoken exactly; other numbers are spoken loosely. */
  sayExactly?: string[];
  /** Default follow-up when the Director does not suggest a valid one. */
  followUp?: { kind: ActionKind; hint: string };
}

/** Someone outside the meeting who answers at most once in their topic. */
export interface AgendaOffScreen {
  name: string;
  role: string;
  /** How they answer, and the one condition that shapes it. */
  howTheyAnswer: string;
}

/** A link from this agenda item to another one. */
export interface AgendaLink {
  /** The title of the other agenda item. */
  with: string;
  /** What carries from one topic to the other. */
  effect: string;
}

/**
 * What the AI colleagues bring to one agenda item: each speaker's opening angle and the distinct
 * trade-offs that keep the decision open. It is data, not a script: it names what is at stake and
 * the question still to answer, never the solution or a required number of turns.
 */
export interface AgendaDiscussion {
  /** What each colleague cares about at the start of the item, as an angle, never a line to read aloud. */
  openingViews: AgendaOpeningView[];
  /** The distinct tensions the person deciding must weigh. */
  tradeOffs: AgendaTradeOff[];
}

/** One colleague's opening angle on an agenda item. */
export interface AgendaOpeningView {
  /** The `name` of the attendee whose angle this is. */
  attendee: string;
  /** What that person cares about on this item, as a short phrase, never a line to read aloud. */
  angle: string;
}

/** One thing the room is told at the start of a topic, and the colleagues who would actually know it. */
export interface BriefingFact {
  /** What happened, as one short spoken fact. */
  text: string;
  /**
   * Who knows it, best-placed knower first. The first present colleague who is not the guest or the host tells it,
   * and their `why` is the reason Sam gives when handing over.
   */
  knownBy: BriefingFactKnower[];
}

/** A colleague who knows a briefing fact, and why it is theirs to tell. */
export interface BriefingFactKnower {
  /** The `name` of the attendee who knows it. */
  attendee: string;
  /** Why this person knows, said after their name, for example "you went through the fridge log". */
  why: string;
}

/** One distinct trade-off the room wants the person deciding to weigh. */
export interface AgendaTradeOff {
  /** The `name` of the attendee who raises this trade-off. */
  attendee: string;
  /** The role whose work or obligation makes this trade-off matter. */
  role: Role;
  /** The guest idea this catch reacts to, in a few plain words. */
  idea: string;
  /** What is at stake, grounded in the company records. */
  tradeOff: string;
  /** The open question the colleague should ask next. */
  question: string;
}

/**
 * An AI attendee in the live demo meeting: one of the scenario's attendees played by the NPC
 * director. The profile is what makes the character a person with their own aims, not a mouthpiece.
 */
export interface NpcProfile {
  /** The `name` of the attendee this character plays. */
  attendee: string;
  /** Text-to-speech voice, for example "en-US-DavisNeural". */
  voice: string;
  /** How they talk and act, in a sentence or two. */
  personality: string;
  /** What they want out of this meeting. */
  agenda: string;
  /** Things they worry about and will raise or push back on. */
  concerns: string[];
  /** Facts they know and can state; optional. */
  knows?: string[];
  /** Words speech recognition tends to hear instead of their name, for example "Archer" for "Arjun". */
  soundsLike?: string[];
  /**
   * A person may take this attendee's seat. The character is played by the AI only when nobody
   * picks it, so the AI attendees of a session are the profiles minus the person's seat.
   */
  playable?: boolean;
  /** How they treat a person in each role (keyed by role id), for example a boss or a peer. */
  withRoles?: Record<string, string>;
  /** Part they play in the meeting: the host runs it, observers only speak when addressed or relevant. */
  role?: NpcRole;
  /** How they sound: sentence length, verbal habits, how they hedge or push back. */
  speechStyle?: string;
  /** How they meet a cost or a push, such as giving way on people but not on untested systems. */
  temperament?: string;
  /** What they personally stand to lose or protect this morning. */
  stake?: string;
  /** What they want but would not say outright. */
  hiddenGoal?: string;
  /** Standing disagreements with other characters, which give them a reason to answer each other. */
  tensions?: NpcTension[];
}

export type NpcRole = 'host' | 'participant' | 'observer';

export const NPC_ROLES: readonly NpcRole[] = ['host', 'participant', 'observer'];

/** A standing disagreement between this character and another attendee. */
export interface NpcTension {
  /** The `name` of the other attendee. */
  with: string;
  /** What they disagree about, from this character's point of view. */
  about: string;
}

/** The meeting Kaki is set in: organisation, roles, people and agenda. */
export interface Scenario {
  id: string;
  organisation: string;
  meetingTitle: string;
  roles: ScenarioRole[];
  attendees: Attendee[];
  agenda: AgendaItem[];
  /** What is going on and what the meeting is for, told to the AI attendees; optional. */
  situation?: string;
  /** Shared background every colleague knows, usable for invented details; optional. */
  background?: string[];
  /** Agenda titles that must never be drawn together in one meeting; optional. */
  excludedPairs?: [string, string][];
  /** Words and names likely to come up, so the AI attendees can tell what a misheard word was meant to be; optional. */
  vocabulary?: string[];
  /** Plain meanings of the team's own terms, so the characters can explain them to someone new; optional. */
  glossary?: Record<string, string>;
  /** AI attendees for the live demo meeting; absent when the scenario has none. */
  npcs?: NpcProfile[];
  /** What a person hosting the meeting is told before they start; optional. */
  hostBrief?: HostBrief;
}

/** A short briefing for a person who runs the meeting. */
export interface HostBrief {
  /** What the meeting is for, in a sentence. */
  goal: string;
  /** The decision the meeting has to land by the end. */
  decision: string;
}

export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const RESERVED_ROLE_ID = 'screen';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function readOptionalStringArray(value: unknown, label: string, problems: string[]): void {
  if (value === undefined) return;
  if (!isStringArray(value)) problems.push(`${label} must be a non-empty array of non-empty strings when present`);
}

function readRoles(value: unknown, problems: string[]): Set<string> {
  const roleIds = new Set<string>();
  if (!Array.isArray(value)) {
    problems.push('roles must be an array');
    return roleIds;
  }
  if (value.length === 0) {
    problems.push('roles must contain at least one role');
    return roleIds;
  }

  value.forEach((role, index) => {
    if (!isObject(role)) {
      problems.push(`roles[${index}] must be an object`);
      return;
    }
    if (!isNonEmptyString(role.id)) {
      problems.push(`roles[${index}].id must be a non-empty string`);
    } else {
      if (role.id === RESERVED_ROLE_ID) {
        problems.push(`roles[${index}].id "${role.id}" is reserved`);
      } else if (!ROLE_ID_PATTERN.test(role.id)) {
        problems.push(`roles[${index}].id "${role.id}" must match ${ROLE_ID_PATTERN}`);
      }
      if (roleIds.has(role.id)) {
        problems.push(`roles[${index}].id "${role.id}" is duplicated`);
      } else {
        roleIds.add(role.id);
      }
    }
    if (!isNonEmptyString(role.label)) {
      problems.push(`roles[${index}].label must be a non-empty string`);
    }
    if (role.facilitator !== undefined && typeof role.facilitator !== 'boolean') {
      problems.push(`roles[${index}].facilitator must be true or false`);
    }
    if (role.card !== undefined) {
      const card = role.card;
      if (
        !isObject(card) ||
        !isNonEmptyString(card.youAre) ||
        !isNonEmptyString(card.responsibility) ||
        !Array.isArray(card.facts) ||
        !card.facts.every(isNonEmptyString)
      ) {
        problems.push(`roles[${index}].card must have non-empty "youAre", "responsibility" and a "facts" array of strings`);
      }
    }
  });

  return roleIds;
}

function readAttendees(value: unknown, roleIds: Set<string>, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push('attendees must be an array');
    return;
  }

  value.forEach((attendee, index) => {
    if (!isObject(attendee)) {
      problems.push(`attendees[${index}] must be an object`);
      return;
    }
    if (!isNonEmptyString(attendee.name)) {
      problems.push(`attendees[${index}].name must be a non-empty string`);
    }
    if (!isNonEmptyString(attendee.zoomDisplayName)) {
      problems.push(`attendees[${index}].zoomDisplayName must be a non-empty string`);
    }
    if (!isNonEmptyString(attendee.role)) {
      problems.push(`attendees[${index}].role must be a non-empty string`);
    } else if (!roleIds.has(attendee.role)) {
      problems.push(`attendees[${index}].role "${attendee.role}" is not a known role`);
    }
    if (attendee.spokenJob !== undefined && !isNonEmptyString(attendee.spokenJob)) {
      problems.push(`attendees[${index}].spokenJob must be a non-empty string when present`);
    }
  });
}

function readNpcs(value: unknown, attendees: unknown, roleIds: Set<string>, problems: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    problems.push('npcs must be an array');
    return;
  }

  const attendeeNames = new Set<string>(
    Array.isArray(attendees)
      ? attendees.flatMap((attendee) =>
          isObject(attendee) && isNonEmptyString(attendee.name) ? [attendee.name] : [],
        )
      : [],
  );
  const seen = new Set<string>();

  value.forEach((npc, index) => {
    if (!isObject(npc)) {
      problems.push(`npcs[${index}] must be an object`);
      return;
    }
    if (!isNonEmptyString(npc.attendee)) {
      problems.push(`npcs[${index}].attendee must be a non-empty string`);
    } else if (!attendeeNames.has(npc.attendee)) {
      problems.push(`npcs[${index}].attendee "${npc.attendee}" is not one of the attendees`);
    } else if (seen.has(npc.attendee)) {
      problems.push(`npcs[${index}].attendee "${npc.attendee}" is duplicated`);
    } else {
      seen.add(npc.attendee);
    }
    for (const field of ['voice', 'personality', 'agenda'] as const) {
      if (!isNonEmptyString(npc[field])) problems.push(`npcs[${index}].${field} must be a non-empty string`);
    }
    for (const field of ['speechStyle', 'hiddenGoal', 'temperament', 'stake'] as const) {
      if (npc[field] !== undefined && !isNonEmptyString(npc[field])) {
        problems.push(`npcs[${index}].${field} must be a non-empty string`);
      }
    }
    if (npc.playable !== undefined && typeof npc.playable !== 'boolean') {
      problems.push(`npcs[${index}].playable must be true or false`);
    }
    if (npc.withRoles !== undefined) {
      if (!isObject(npc.withRoles)) {
        problems.push(`npcs[${index}].withRoles must be an object keyed by role id`);
      } else {
        for (const [roleId, note] of Object.entries(npc.withRoles)) {
          if (!roleIds.has(roleId)) problems.push(`npcs[${index}].withRoles has unknown role "${roleId}"`);
          else if (!isNonEmptyString(note)) problems.push(`npcs[${index}].withRoles.${roleId} must be a non-empty string`);
        }
      }
    }
    if (npc.role !== undefined && !NPC_ROLES.includes(npc.role as NpcRole)) {
      problems.push(`npcs[${index}].role must be one of ${NPC_ROLES.join(', ')}`);
    }
    if (npc.tensions !== undefined) {
      if (!Array.isArray(npc.tensions)) {
        problems.push(`npcs[${index}].tensions must be an array`);
      } else {
        npc.tensions.forEach((tension, tensionIndex) => {
          const label = `npcs[${index}].tensions[${tensionIndex}]`;
          if (!isObject(tension) || !isNonEmptyString(tension.with) || !isNonEmptyString(tension.about)) {
            problems.push(`${label} must have a non-empty "with" and "about"`);
          } else if (!attendeeNames.has(tension.with)) {
            problems.push(`${label}.with "${tension.with}" is not one of the attendees`);
          } else if (tension.with === npc.attendee) {
            problems.push(`${label}.with cannot be the character themselves`);
          }
        });
      }
    }
    for (const field of ['concerns', 'knows', 'soundsLike'] as const) {
      const list = npc[field];
      if (field !== 'concerns' && list === undefined) continue;
      if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
        problems.push(`npcs[${index}].${field} must be an array of non-empty strings`);
      }
    }
  });
}

function readAgenda(
  value: unknown,
  roleIds: Set<string>,
  attendeeNames: Set<string>,
  hostNames: Set<string>,
  agendaTitles: Set<string>,
  problems: string[],
): void {
  if (!Array.isArray(value)) {
    problems.push('agenda must be an array');
    return;
  }
  if (value.length === 0) {
    problems.push('agenda must contain at least one agenda item');
    return;
  }

  value.forEach((item, index) => {
    if (!isObject(item)) {
      problems.push(`agenda[${index}] must be an object`);
      return;
    }
    if (!isNonEmptyString(item.title)) {
      problems.push(`agenda[${index}].title must be a non-empty string`);
    }
    if (typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes <= 0) {
      problems.push(`agenda[${index}].minutes must be a number greater than zero`);
    }
    if (typeof item.canWait !== 'boolean') {
      problems.push(`agenda[${index}].canWait must be true or false`);
    }
    if (!isNonEmptyString(item.deadline)) {
      problems.push(`agenda[${index}].deadline must be a non-empty string`);
    }
    if (item.contested !== undefined && typeof item.contested !== 'boolean') {
      problems.push(`agenda[${index}].contested must be true or false when present`);
    }
    if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') {
      problems.push(`agenda[${index}].sensitive must be true or false when present`);
    }
    if (item.decision !== undefined && !isNonEmptyString(item.decision)) {
      problems.push(`agenda[${index}].decision must be a non-empty string when present`);
    }
    if (isNonEmptyString(item.decision) && (item.decision.match(/\?/g) ?? []).length > 1) {
      problems.push(`agenda[${index}].decision must ask one question with a single "?"`);
    }
    if (item.briefing !== undefined) {
      if (!Array.isArray(item.briefing) || item.briefing.length === 0) {
        problems.push(`agenda[${index}].briefing must be a non-empty array when present`);
      } else {
        item.briefing.forEach((fact, factIndex) => {
          const where = `agenda[${index}].briefing[${factIndex}]`;
          if (!isObject(fact) || !isNonEmptyString(fact.text)) {
            problems.push(`${where} must have non-empty "text"`);
            return;
          }
          if (!Array.isArray(fact.knownBy) || fact.knownBy.length === 0) {
            problems.push(`${where}.knownBy must be a non-empty array`);
            return;
          }
          fact.knownBy.forEach((knower, knowerIndex) => {
            const who = `${where}.knownBy[${knowerIndex}]`;
            if (!isObject(knower) || !isNonEmptyString(knower.attendee) || !isNonEmptyString(knower.why)) {
              problems.push(`${who} must have a non-empty "attendee" and "why"`);
              return;
            }
            if (!attendeeNames.has(knower.attendee)) {
              problems.push(`${who}.attendee "${knower.attendee}" is not one of the attendees`);
            } else if (hostNames.has(knower.attendee)) {
              problems.push(`${who}.attendee "${knower.attendee}" is the host and cannot know a briefing fact`);
            }
          });
        });
      }
    }
    if (item.spoken !== undefined && !isNonEmptyString(item.spoken)) {
      problems.push(`agenda[${index}].spoken must be a non-empty string when present`);
    }
    if (item.art !== undefined && !isNonEmptyString(item.art)) {
      problems.push(`agenda[${index}].art must be a non-empty string when present`);
    }
    if (item.followUp !== undefined &&
        (!isObject(item.followUp) || !ACTION_KINDS.includes(item.followUp.kind as ActionKind) || !isNonEmptyString(item.followUp.hint))) {
      problems.push(`agenda[${index}].followUp must have a valid kind and non-empty hint`);
    }
    readOptionalStringArray(item.directions, `agenda[${index}].directions`, problems);
    readOptionalStringArray(item.background, `agenda[${index}].background`, problems);
    readOptionalStringArray(item.sayExactly, `agenda[${index}].sayExactly`, problems);
    if (item.offScreen !== undefined) {
      const offScreen = item.offScreen;
      if (
        !isObject(offScreen) ||
        !isNonEmptyString(offScreen.name) ||
        !isNonEmptyString(offScreen.role) ||
        !isNonEmptyString(offScreen.howTheyAnswer)
      ) {
        problems.push(`agenda[${index}].offScreen must have a non-empty "name", "role" and "howTheyAnswer"`);
      }
    }
    if (item.seatFacts !== undefined) {
      if (!isObject(item.seatFacts) || Object.keys(item.seatFacts).length === 0) {
        problems.push(`agenda[${index}].seatFacts must be a non-empty object keyed by role id`);
      } else {
        for (const [roleId, fact] of Object.entries(item.seatFacts)) {
          if (!roleIds.has(roleId)) problems.push(`agenda[${index}].seatFacts has unknown role "${roleId}"`);
          else if (!isNonEmptyString(fact)) problems.push(`agenda[${index}].seatFacts.${roleId} must be a non-empty string`);
        }
      }
    }
    if (item.links !== undefined) {
      if (!Array.isArray(item.links) || item.links.length === 0) {
        problems.push(`agenda[${index}].links must be a non-empty array when present`);
      } else {
        item.links.forEach((link, linkIndex) => {
          const where = `agenda[${index}].links[${linkIndex}]`;
          if (!isObject(link) || !isNonEmptyString(link.with) || !isNonEmptyString(link.effect)) {
            problems.push(`${where} must have a non-empty "with" and "effect"`);
            return;
          }
          if (!agendaTitles.has(link.with)) {
            problems.push(`${where}.with "${link.with}" is not an agenda title`);
          } else if (isNonEmptyString(item.title) && link.with === item.title) {
            problems.push(`${where}.with cannot be the agenda item itself`);
          }
        });
      }
    }
    if (!isNonEmptyString(item.ownerRole)) {
      problems.push(`agenda[${index}].ownerRole must be a non-empty string`);
    } else if (!roleIds.has(item.ownerRole)) {
      problems.push(`agenda[${index}].ownerRole "${item.ownerRole}" is not a known role`);
    }
    if (item.discussion !== undefined) {
      readAgendaDiscussion(item.discussion, `agenda[${index}].discussion`, roleIds, attendeeNames, problems);
    }
  });
}

function readAgendaDiscussion(
  value: unknown,
  label: string,
  roleIds: Set<string>,
  attendeeNames: Set<string>,
  problems: string[],
): void {
  if (!isObject(value)) {
    problems.push(`${label} must be an object`);
    return;
  }
  if (!Array.isArray(value.openingViews) || value.openingViews.length === 0) {
    problems.push(`${label}.openingViews must be a non-empty array`);
  } else {
    const seen = new Set<string>();
    value.openingViews.forEach((view, index) => {
      const where = `${label}.openingViews[${index}]`;
      if (!isObject(view) || !isNonEmptyString(view.attendee) || !isNonEmptyString(view.angle)) {
        problems.push(`${where} must have a non-empty "attendee" and "angle"`);
        return;
      }
      if (!attendeeNames.has(view.attendee)) {
        problems.push(`${where}.attendee "${view.attendee}" is not one of the attendees`);
      } else if (seen.has(view.attendee)) {
        problems.push(`${where}.attendee "${view.attendee}" is duplicated`);
      } else {
        seen.add(view.attendee);
      }
    });
  }
  if (!Array.isArray(value.tradeOffs) || value.tradeOffs.length === 0) {
    problems.push(`${label}.tradeOffs must be a non-empty array`);
  } else {
    value.tradeOffs.forEach((tradeOff, index) => {
      const where = `${label}.tradeOffs[${index}]`;
      if (!isObject(tradeOff)) {
        problems.push(`${where} must be an object`);
        return;
      }
      if (
        !isNonEmptyString(tradeOff.attendee) ||
        !isNonEmptyString(tradeOff.idea) ||
        !isNonEmptyString(tradeOff.tradeOff) ||
        !isNonEmptyString(tradeOff.question)
      ) {
        problems.push(`${where} must have a non-empty "attendee", "idea", "tradeOff" and "question"`);
      }
      if (isNonEmptyString(tradeOff.attendee) && !attendeeNames.has(tradeOff.attendee)) {
        problems.push(`${where}.attendee "${tradeOff.attendee}" is not one of the attendees`);
      }
      if (!isNonEmptyString(tradeOff.role)) {
        problems.push(`${where}.role must be a non-empty string`);
      } else if (!roleIds.has(tradeOff.role)) {
        problems.push(`${where}.role "${tradeOff.role}" is not a known role`);
      }
    });
  }
}

/** Validate unknown JSON as a scenario, throwing once with every problem found. */
export function parseScenario(value: unknown): Scenario {
  if (!isObject(value)) {
    throw new Error('Invalid scenario: expected a JSON object');
  }

  const problems: string[] = [];
  if (!isNonEmptyString(value.id)) problems.push('id must be a non-empty string');
  if (!isNonEmptyString(value.organisation)) problems.push('organisation must be a non-empty string');
  if (!isNonEmptyString(value.meetingTitle)) problems.push('meetingTitle must be a non-empty string');

  const roleIds = readRoles(value.roles, problems);
  readAttendees(value.attendees, roleIds, problems);
  const attendeeNames = new Set<string>(
    Array.isArray(value.attendees)
      ? value.attendees.flatMap((attendee) =>
          isObject(attendee) && isNonEmptyString(attendee.name) ? [attendee.name] : [],
        )
      : [],
  );
  const facilitatorRoleIds = new Set<string>(
    Array.isArray(value.roles)
      ? value.roles.flatMap((role) =>
          isObject(role) && role.facilitator === true && isNonEmptyString(role.id) ? [role.id] : [],
        )
      : [],
  );
  const hostNames = new Set<string>(
    Array.isArray(value.attendees)
      ? value.attendees.flatMap((attendee) =>
          isObject(attendee) &&
          isNonEmptyString(attendee.name) &&
          isNonEmptyString(attendee.role) &&
          facilitatorRoleIds.has(attendee.role)
            ? [attendee.name]
            : [],
        )
      : [],
  );
  const agendaTitles = new Set<string>(
    Array.isArray(value.agenda)
      ? value.agenda.flatMap((item) => (isObject(item) && isNonEmptyString(item.title) ? [item.title] : []))
      : [],
  );
  readAgenda(value.agenda, roleIds, attendeeNames, hostNames, agendaTitles, problems);
  readOptionalStringArray(value.background, 'background', problems);
  if (value.excludedPairs !== undefined) {
    if (!Array.isArray(value.excludedPairs) || value.excludedPairs.length === 0) {
      problems.push('excludedPairs must be a non-empty array of agenda-title pairs when present');
    } else {
      value.excludedPairs.forEach((pair, index) => {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !isNonEmptyString(pair[0]) ||
          !isNonEmptyString(pair[1])
        ) {
          problems.push(`excludedPairs[${index}] must be a pair of two non-empty agenda titles`);
          return;
        }
        for (const title of pair) {
          if (!agendaTitles.has(title)) problems.push(`excludedPairs[${index}] title "${title}" is not an agenda title`);
        }
        if (pair[0] === pair[1]) problems.push(`excludedPairs[${index}] must name two different agenda titles`);
      });
    }
  }
  if (value.hostBrief !== undefined) {
    if (!isObject(value.hostBrief) || !isNonEmptyString(value.hostBrief.goal) || !isNonEmptyString(value.hostBrief.decision)) {
      problems.push('hostBrief must have a non-empty "goal" and "decision" when present');
    }
  }
  if (
    value.glossary !== undefined &&
    (!isObject(value.glossary) || !Object.values(value.glossary).every(isNonEmptyString))
  ) {
    problems.push('glossary must map each term to a non-empty plain-language meaning when present');
  }
  if (value.situation !== undefined && !isNonEmptyString(value.situation)) {
    problems.push('situation must be a non-empty string when present');
  }
  if (
    value.vocabulary !== undefined &&
    (!Array.isArray(value.vocabulary) || !value.vocabulary.every(isNonEmptyString))
  ) {
    problems.push('vocabulary must be an array of non-empty strings when present');
  }
  readNpcs(value.npcs, value.attendees, roleIds, problems);

  if (problems.length > 0) {
    throw new Error(`Invalid scenario:\n- ${problems.join('\n- ')}`);
  }

  return value as unknown as Scenario;
}

/** True when a value is a role id the scenario defines. */
export function isRoleIn(scenario: Scenario, value: unknown): value is Role {
  return typeof value === 'string' && scenario.roles.some((role) => role.id === value);
}

/** The label the scenario gives a role; throws when the role is not in it. */
export function roleLabel(scenario: Scenario, role: Role): string {
  const found = scenario.roles.find((candidate) => candidate.id === role);
  if (found === undefined) {
    throw new Error(`Unknown role "${role}" in scenario "${scenario.id}"`);
  }
  return found.label;
}

/**
 * The person and role label for a role in the scenario (for example "Arjun (Lead Programmer)"),
 * or the visitor's own name when `viewer` holds that seat (for example "Boo (you · Producer)").
 */
export function assigneeLabel(
  scenario: Scenario,
  role: Role,
  viewer?: { name: string; seatName?: string },
): string {
  const label = roleLabel(scenario, role);
  const attendee = scenario.attendees.find((candidate) => candidate.role === role);
  if (attendee === undefined) return label;
  if (
    viewer?.seatName !== undefined &&
    attendee.name.trim().toLowerCase() === viewer.seatName.trim().toLowerCase()
  ) {
    return `${viewer.name} (you · ${label})`;
  }
  return `${attendee.name} (${label})`;
}

/** Map a Zoom display name to that attendee's role, if they are in this scenario. */
export function roleForZoomName(scenario: Scenario, name: string): Role | undefined {
  const wanted = name.trim().toLowerCase();
  const exact = scenario.attendees.find(
    (attendee) => attendee.zoomDisplayName.trim().toLowerCase() === wanted || attendee.name.trim().toLowerCase() === wanted,
  )?.role;
  if (exact !== undefined) return exact;
  const roleMatch = /\(([^)]+)\)\s*$/.exec(wanted);
  if (roleMatch !== null) {
    const label = roleMatch[1]!.trim();
    const role = scenario.roles.find((r) => r.label.trim().toLowerCase() === label || r.id.toLowerCase() === label);
    if (role !== undefined) return role.id;
  }
  return undefined;
}
