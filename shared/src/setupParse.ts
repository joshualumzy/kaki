import { isNonEmptyString, isObject } from './guards';
import { RESERVED_ROLE_ID, ROLE_ID_PATTERN } from './scenarioTypes';
import {
  DEFAULT_MEETING_PACE,
  MAX_AGENDA_MINUTES,
  MAX_ORGANISATION_LENGTH,
  type MeetingPace,
  type MeetingSetup,
  type MeetingSetupAgendaItem,
  type MeetingSetupRole,
  type MeetingSetupSeat,
  type MeetingSetupSources,
  type SetupFieldError,
  type SetupSource,
} from './setupTypes';

const SETUP_SOURCES: readonly SetupSource[] = ['calendar invite', 'demo pack', 'typed'];

type SetupParseResult =
  | { ok: true; value: MeetingSetup }
  | { ok: false; errors: SetupFieldError[] };

interface ParseMeetingSetupOptions {
  /** The NPC profiles in the loaded demo pack; absent or empty means AI seats are not allowed. */
  npcProfileIds?: readonly string[];
}

const MIN_PACE_SECONDS = 10;
const MAX_PACE_SECONDS = 600;

function isSource(value: unknown): value is SetupSource {
  return typeof value === 'string' && SETUP_SOURCES.includes(value as SetupSource);
}

function error(errors: SetupFieldError[], field: string, message: string): void {
  errors.push({ field, message });
}

interface RoleRead {
  list: MeetingSetupRole[];
  ids: Set<string>;
}

function readRoles(value: unknown, errors: SetupFieldError[]): RoleRead {
  const list: MeetingSetupRole[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();

  if (!Array.isArray(value) || value.length === 0) {
    error(errors, 'roles', 'Add at least one role.');
    return { list, ids };
  }

  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      error(errors, `roles[${index}]`, 'Each role must be an object.');
      return;
    }
    const id = entry.id;
    if (!isNonEmptyString(id)) {
      error(errors, `roles[${index}].id`, 'Enter a role id.');
    } else if (ids.has(id)) {
      error(errors, `roles[${index}].id`, 'Role ids must be unique.');
    } else if (id === RESERVED_ROLE_ID) {
      error(errors, `roles[${index}].id`, `"${RESERVED_ROLE_ID}" is a reserved role id.`);
    } else if (!ROLE_ID_PATTERN.test(id)) {
      error(
        errors,
        `roles[${index}].id`,
        'Role ids start with a letter and use only lowercase letters, numbers and underscores.',
      );
    } else {
      ids.add(id);
    }

    const label = entry.label;
    if (!isNonEmptyString(label)) {
      error(errors, `roles[${index}].label`, 'Enter a role name.');
    } else if (labels.has(label)) {
      error(errors, `roles[${index}].label`, 'Role names must be unique.');
    } else {
      labels.add(label);
    }

    const facilitator = entry.facilitator;
    if (typeof facilitator !== 'boolean') {
      error(errors, `roles[${index}].facilitator`, 'Say whether this role runs the meeting.');
    }

    if (isNonEmptyString(id) && isNonEmptyString(label) && typeof facilitator === 'boolean') {
      list.push({ id, label, facilitator });
    }
  });

  return { list, ids };
}

function readAgenda(
  value: unknown,
  roleIds: Set<string>,
  errors: SetupFieldError[],
): MeetingSetupAgendaItem[] {
  const list: MeetingSetupAgendaItem[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();

  if (!Array.isArray(value) || value.length === 0) {
    error(errors, 'agenda', 'Add at least one agenda item.');
    return list;
  }

  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      error(errors, `agenda[${index}]`, 'Each agenda item must be an object.');
      return;
    }

    const id = entry.id;
    if (!isNonEmptyString(id)) {
      error(errors, `agenda[${index}].id`, 'Enter an agenda item id.');
    } else if (ids.has(id)) {
      error(errors, `agenda[${index}].id`, 'Agenda item ids must be unique.');
    } else {
      ids.add(id);
    }

    const title = entry.title;
    if (!isNonEmptyString(title)) {
      error(errors, `agenda[${index}].title`, 'Enter an agenda item title.');
    } else if (titles.has(title)) {
      error(errors, `agenda[${index}].title`, 'Agenda item titles must be unique.');
    } else {
      titles.add(title);
    }

    const minutes = entry.minutes;
    const minutesValid =
      typeof minutes === 'number' &&
      Number.isFinite(minutes) &&
      minutes > 0 &&
      minutes <= MAX_AGENDA_MINUTES;
    if (!minutesValid) {
      error(
        errors,
        `agenda[${index}].minutes`,
        `Minutes must be a number greater than 0 and no more than ${MAX_AGENDA_MINUTES}.`,
      );
    }

    const ownerRoleId = entry.ownerRoleId;
    if (!isNonEmptyString(ownerRoleId) || !roleIds.has(ownerRoleId)) {
      error(errors, `agenda[${index}].ownerRoleId`, 'Choose an owner role that exists in this meeting.');
    }

    if (
      isNonEmptyString(id) &&
      isNonEmptyString(title) &&
      minutesValid &&
      isNonEmptyString(ownerRoleId)
    ) {
      list.push({ id, title, minutes: minutes as number, ownerRoleId });
    }
  });

  return list;
}

interface SeatRead {
  list: MeetingSetupSeat[];
  personCount: number;
  aiCount: number;
}

function readSeats(
  value: unknown,
  roleIds: Set<string>,
  npcProfileIds: readonly string[],
  errors: SetupFieldError[],
): SeatRead {
  const list: MeetingSetupSeat[] = [];
  const names = new Set<string>();
  const profiles = new Set(npcProfileIds);
  let personCount = 0;
  let aiCount = 0;

  if (!Array.isArray(value) || value.length === 0) {
    error(errors, 'seats', 'Add at least one seat for a person.');
    return { list, personCount, aiCount };
  }

  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      error(errors, `seats[${index}]`, 'Each seat must be an object.');
      return;
    }

    const displayName = entry.displayName;
    if (!isNonEmptyString(displayName)) {
      error(errors, `seats[${index}].displayName`, 'Enter the name shown for this seat.');
    } else if (names.has(displayName)) {
      error(errors, `seats[${index}].displayName`, 'Each person needs a different name.');
    } else {
      names.add(displayName);
    }

    const roleId = entry.roleId;
    if (!isNonEmptyString(roleId) || !roleIds.has(roleId)) {
      error(errors, `seats[${index}].roleId`, 'Choose a role that exists in this meeting.');
    }

    const kind = entry.kind;
    if (kind !== 'person' && kind !== 'ai') {
      error(errors, `seats[${index}].kind`, 'Choose a person or an AI stand-in.');
      return;
    }

    if (kind === 'person') {
      personCount += 1;
    } else {
      aiCount += 1;
      const npcProfileId = entry.npcProfileId;
      if (!isNonEmptyString(npcProfileId)) {
        error(errors, `seats[${index}].npcProfileId`, 'Choose an AI stand-in from the loaded demo pack.');
      } else if (profiles.size === 0) {
        error(errors, `seats[${index}].npcProfileId`, 'AI stand-ins are only available when a demo pack is loaded.');
      } else if (!profiles.has(npcProfileId)) {
        error(errors, `seats[${index}].npcProfileId`, 'Choose an AI stand-in from the loaded demo pack.');
      }
    }

    if (
      isNonEmptyString(displayName) &&
      isNonEmptyString(roleId) &&
      (kind === 'person' || isNonEmptyString(entry.npcProfileId))
    ) {
      list.push(
        kind === 'ai'
          ? {
              displayName,
              roleId,
              kind,
              npcProfileId: entry.npcProfileId as string,
            }
          : { displayName, roleId, kind },
      );
    }
  });

  if (personCount === 0) {
    error(errors, 'seats', 'Add at least one seat for a person.');
  }
  if (aiCount > 0 && personCount !== 1) {
    error(errors, 'seats', 'A meeting with AI stand-ins has room for one person.');
  }

  return { list, personCount, aiCount };
}

function readPace(value: unknown, errors: SetupFieldError[]): MeetingPace {
  const pace: MeetingPace = { ...DEFAULT_MEETING_PACE };
  if (!isObject(value)) {
    error(errors, 'pace', 'Enter the two pace warnings in seconds.');
    return pace;
  }

  const fields: Array<keyof MeetingPace> = ['quietCheckAfter', 'comingUpBefore'];
  const labels: Record<keyof MeetingPace, string> = {
    quietCheckAfter: 'Quiet check time',
    comingUpBefore: 'Coming-up warning',
  };

  for (const field of fields) {
    const seconds = value[field];
    if (
      typeof seconds === 'number' &&
      Number.isInteger(seconds) &&
      seconds >= MIN_PACE_SECONDS &&
      seconds <= MAX_PACE_SECONDS
    ) {
      pace[field] = seconds;
    } else {
      error(
        errors,
        `pace.${field}`,
        `${labels[field]} must be a whole number of seconds between ${MIN_PACE_SECONDS} and ${MAX_PACE_SECONDS}.`,
      );
    }
  }

  return pace;
}

function readSources(value: unknown, errors: SetupFieldError[]): MeetingSetupSources {
  const sources: MeetingSetupSources = {
    title: 'typed',
    agenda: 'typed',
    roles: 'typed',
    seats: 'typed',
    pace: 'typed',
  };
  if (!isObject(value)) {
    error(errors, 'source', 'Say where each part of the setup came from.');
    return sources;
  }

  const fields: Array<keyof MeetingSetupSources> = ['title', 'agenda', 'roles', 'seats', 'pace'];
  for (const field of fields) {
    const source = value[field];
    if (isSource(source)) sources[field] = source;
    else error(errors, `source.${field}`, 'Choose calendar invite, demo pack, or typed.');
  }
  return sources;
}

/** Validate an unknown setup value, returning either the setup or every field-specific problem. */
export function parseMeetingSetup(
  value: unknown,
  options: ParseMeetingSetupOptions = {},
): SetupParseResult {
  const errors: SetupFieldError[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: [{ field: 'setup', message: 'The setup must be an object.' }] };
  }

  const title = value.title;
  if (!isNonEmptyString(title)) error(errors, 'title', 'Enter a meeting title.');

  // Optional: blank is a real choice (the meeting has no organisation to name), not an error.
  const organisation = value.organisation;
  let parsedOrganisation: string | undefined;
  if (organisation !== undefined) {
    if (typeof organisation !== 'string') {
      error(errors, 'organisation', 'Enter a team or organisation, or leave it blank.');
    } else {
      const trimmed = organisation.trim();
      if (trimmed.length > MAX_ORGANISATION_LENGTH) {
        error(
          errors,
          'organisation',
          `Keep the team or organisation to ${MAX_ORGANISATION_LENGTH} characters or fewer.`,
        );
      } else if (trimmed.length > 0) {
        parsedOrganisation = trimmed;
      }
    }
  }

  const roles = readRoles(value.roles, errors);
  const agenda = readAgenda(value.agenda, roles.ids, errors);
  const seats = readSeats(value.seats, roles.ids, options.npcProfileIds ?? [], errors);
  const pace = readPace(value.pace, errors);
  const source = readSources(value.source, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      title: title as string,
      ...(parsedOrganisation === undefined ? {} : { organisation: parsedOrganisation }),
      agenda,
      roles: roles.list,
      seats: seats.list,
      pace,
      source,
    },
  };
}

/** A new meeting plan with nothing in it yet: a title field, default pace, no roles, seats or agenda. */
export function blankMeetingSetup(): MeetingSetup {
  return {
    title: '',
    agenda: [],
    roles: [],
    seats: [],
    pace: { ...DEFAULT_MEETING_PACE },
    source: {
      title: 'typed',
      agenda: 'typed',
      roles: 'typed',
      seats: 'typed',
      pace: 'typed',
    },
  };
}

/**
 * True for a draft that has no roles, seats or agenda yet. Such a plan is saved while the owner
 * fills it in, so it is readable across a restart even though it cannot open a meeting until filled.
 */
export function isBlankMeetingDraft(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.title !== 'string') return false;
  if (!Array.isArray(value.agenda) || value.agenda.length > 0) return false;
  if (!Array.isArray(value.roles) || value.roles.length > 0) return false;
  if (!Array.isArray(value.seats) || value.seats.length > 0) return false;
  const errors: SetupFieldError[] = [];
  readPace(value.pace, errors);
  readSources(value.source, errors);
  return errors.length === 0;
}
