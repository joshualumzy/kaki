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

/** The meeting Kaki is set in: organisation, roles, people and agenda. */
export interface Scenario {
  id: string;
  organisation: string;
  meetingTitle: string;
  roles: ScenarioRole[];
  attendees: Attendee[];
  agenda: AgendaItem[];
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
