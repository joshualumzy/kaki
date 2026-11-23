import { isNonEmptyString, isObject } from './guards';
import type { Role } from './roles';
import {
  RESERVED_ROLE_ID,
  ROLE_ID_PATTERN,
  type NpcRole,
  type Scenario,
} from './scenarioTypes';
import { ACTION_KINDS, type ActionKind } from './task';

const NPC_ROLES: readonly NpcRole[] = ['host', 'participant', 'observer'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function readOptionalStringArray(value: unknown, label: string, problems: string[]): void {
  if (value === undefined) return;
  if (!isStringArray(value)) problems.push(`${label} must be a non-empty array of non-empty strings when present`);
}

function readRoles(value: unknown, problems: string[], allowEmpty = false): Set<string> {
  const roleIds = new Set<string>();
  if (!Array.isArray(value)) {
    problems.push('roles must be an array');
    return roleIds;
  }
  if (value.length === 0) {
    if (!allowEmpty) problems.push('roles must contain at least one role');
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
    if (role.stance !== undefined && !isNonEmptyString(role.stance)) {
      problems.push(`roles[${index}].stance must be a non-empty string when present`);
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
    if (!isNonEmptyString(attendee.displayName)) {
      problems.push(`attendees[${index}].displayName must be a non-empty string`);
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
  allowEmpty = false,
): void {
  if (!Array.isArray(value)) {
    problems.push('agenda must be an array');
    return;
  }
  if (value.length === 0) {
    if (!allowEmpty) problems.push('agenda must contain at least one agenda item');
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

interface ParseScenarioOptions {
  /**
   * Require the organisation, as a demo pack file must have. Runtime scenarios may leave it out:
   * an owner-written meeting with a blank organisation field has none.
   */
  requireOrganisation?: boolean;
  /** A real product meeting may have no agenda yet; a demo pack must always carry one. */
  allowEmptyAgenda?: boolean;
  /** A real product meeting starts with no roles until people join it. */
  allowEmptyRoles?: boolean;
}

/** Validate unknown JSON as a scenario, throwing once with every problem found. */
export function parseScenario(value: unknown, options: ParseScenarioOptions = {}): Scenario {
  if (!isObject(value)) {
    throw new Error('Invalid scenario: expected a JSON object');
  }

  const requireOrganisation = options.requireOrganisation !== false;
  const problems: string[] = [];
  if (!isNonEmptyString(value.id)) problems.push('id must be a non-empty string');
  if (value.organisation === undefined ? requireOrganisation : !isNonEmptyString(value.organisation)) {
    problems.push('organisation must be a non-empty string');
  }
  if (!isNonEmptyString(value.meetingTitle)) problems.push('meetingTitle must be a non-empty string');
  if (value.speechRegister !== undefined && !isNonEmptyString(value.speechRegister)) {
    problems.push('speechRegister must be a non-empty string when present');
  }

  const roleIds = readRoles(value.roles, problems, options.allowEmptyRoles === true);
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
  readAgenda(
    value.agenda,
    roleIds,
    attendeeNames,
    hostNames,
    agendaTitles,
    problems,
    options.allowEmptyAgenda === true,
  );
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
  if (value.practiceBriefing !== undefined) {
    const briefing = value.practiceBriefing;
    if (!isObject(briefing) || !isNonEmptyString(briefing.intro)) {
      problems.push('practiceBriefing must have a non-empty "intro" when present');
    } else {
      for (const field of ['heroArt', 'badge'] as const) {
        if (briefing[field] !== undefined && !isNonEmptyString(briefing[field])) {
          problems.push(`practiceBriefing.${field} must be a non-empty string when present`);
        }
      }
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
  if (value.toolUrls !== undefined) {
    if (!isObject(value.toolUrls)) {
      problems.push('toolUrls must be an object when present');
    } else {
      for (const key of ['wiki', 'gitea', 'mattermost', 'email', 'calendar'] as const) {
        if (!isNonEmptyString(value.toolUrls[key])) {
          problems.push(`toolUrls.${key} must be a non-empty string when present`);
        }
      }
    }
  }

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
 * The person and role label for a role in the scenario (for example "Arjun (Tech & POS Lead)"),
 * or the visitor's own name when `viewer` holds that seat (for example "Boo (you · Operations Director)").
 */
export function assigneeLabel(
  scenario: Scenario,
  role: Role,
  viewer?: { name: string; seatName?: string; seat?: string },
): string {
  const label = roleLabel(scenario, role);
  const attendee = scenario.attendees.find((candidate) => candidate.role === role);
  if (attendee === undefined) return label;
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  // The seat is exact; a display name is only a fallback, since two people can share one.
  const isViewer =
    viewer?.seat !== undefined && viewer.seat.trim() !== ''
      ? same(role, viewer.seat)
      : viewer?.seatName !== undefined && same(attendee.name, viewer.seatName);
  const name = isViewer ? (viewer?.name ?? attendee.name) : attendee.name;
  // A team meeting's role label is the person's own name: never print it twice.
  const roleNote = same(label, name) ? undefined : label;
  if (isViewer) return roleNote === undefined ? `${name} (you)` : `${name} (you · ${roleNote})`;
  return roleNote === undefined ? name : `${name} (${roleNote})`;
}

/** Map a display name to that attendee's role, if they are in this scenario. */
export function roleForDisplayName(scenario: Scenario, name: string): Role | undefined {
  const wanted = name.trim().toLowerCase();
  const exact = scenario.attendees.find(
    (attendee) => attendee.displayName.trim().toLowerCase() === wanted || attendee.name.trim().toLowerCase() === wanted,
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
