import type { Role } from './roles';

/** One role the active scenario defines, with the label people see. */
export interface ScenarioRole {
  id: Role;
  label: string;
}

/** A participant joining the meeting, with the name Zoom shows for them. */
export interface Attendee {
  name: string;
  role: Role;
  zoomDisplayName: string;
}

/** One agenda item with its time limit and the role that owns it. */
export interface AgendaItem {
  title: string;
  minutes: number;
  ownerRole: Role;
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
  /** Part they play in the meeting: the host runs it, observers only speak when addressed or relevant. */
  role?: NpcRole;
  /** How they sound: sentence length, verbal habits, how they hedge or push back. */
  speechStyle?: string;
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
  /** AI attendees for the live demo meeting; absent when the scenario has none. */
  npcs?: NpcProfile[];
}

const ROLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_ROLE_ID = 'screen';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  });
}

function readNpcs(value: unknown, attendees: unknown, problems: string[]): void {
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
    for (const field of ['speechStyle', 'hiddenGoal'] as const) {
      if (npc[field] !== undefined && !isNonEmptyString(npc[field])) {
        problems.push(`npcs[${index}].${field} must be a non-empty string`);
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

function readAgenda(value: unknown, roleIds: Set<string>, problems: string[]): void {
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
    if (!isNonEmptyString(item.ownerRole)) {
      problems.push(`agenda[${index}].ownerRole must be a non-empty string`);
    } else if (!roleIds.has(item.ownerRole)) {
      problems.push(`agenda[${index}].ownerRole "${item.ownerRole}" is not a known role`);
    }
  });
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
  readAgenda(value.agenda, roleIds, problems);
  if (value.situation !== undefined && !isNonEmptyString(value.situation)) {
    problems.push('situation must be a non-empty string when present');
  }
  readNpcs(value.npcs, value.attendees, problems);

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

/** Map a Zoom display name to that attendee's role, if they are in this scenario. */
export function roleForZoomName(scenario: Scenario, name: string): Role | undefined {
  const wanted = name.trim().toLowerCase();
  return scenario.attendees.find((attendee) => attendee.zoomDisplayName.trim().toLowerCase() === wanted)
    ?.role;
}
