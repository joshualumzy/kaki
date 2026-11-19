import type { Scenario } from './scenario';

/** Where a group of setup fields came from, shown next to them on the setup screen. */
export type SetupSource = 'calendar invite' | 'demo pack' | 'typed';

export const SETUP_SOURCES: readonly SetupSource[] = ['calendar invite', 'demo pack', 'typed'];

/** One agenda item in the pre-Start setup. */
export interface MeetingSetupAgendaItem {
  id: string;
  title: string;
  minutes: number;
  /** The id of the role that owns this item. */
  ownerRoleId: string;
}

/** One role in the pre-Start setup. */
export interface MeetingSetupRole {
  id: string;
  label: string;
  /** Whether this role runs the meeting. */
  facilitator: boolean;
}

export type MeetingSetupSeatKind = 'person' | 'ai';

/** One seat at the meeting, either a real person or an AI stand-in from the demo pack. */
export interface MeetingSetupSeat {
  displayName: string;
  roleId: string;
  kind: MeetingSetupSeatKind;
  /** The demo-pack NPC profile this AI seat plays; required when `kind` is `ai`. */
  npcProfileId?: string;
}

/**
 * The three Wingman nudge timings, in seconds (the nudge module's current constants):
 * quietCheckAfter is how far into an item Wingman checks whether its owner has spoken;
 * ownerQuietBelow is how little talk by then counts as quiet; comingUpBefore is how long
 * before an item ends the next item's owner is told they are up.
 */
export interface MeetingPace {
  ownerQuietBelow: number;
  quietCheckAfter: number;
  comingUpBefore: number;
}

export interface MeetingSetupSources {
  title: SetupSource;
  agenda: SetupSource;
  roles: SetupSource;
  seats: SetupSource;
  pace: SetupSource;
}

/** The one authoritative meeting setup saved before Start. */
export interface MeetingSetup {
  title: string;
  agenda: MeetingSetupAgendaItem[];
  roles: MeetingSetupRole[];
  seats: MeetingSetupSeat[];
  pace: MeetingPace;
  source: MeetingSetupSources;
}

/** One plain-language problem with the field named in `field`. */
export interface SetupFieldError {
  field: string;
  message: string;
}

export type SetupParseResult =
  | { ok: true; value: MeetingSetup }
  | { ok: false; errors: SetupFieldError[] };

export interface ParseMeetingSetupOptions {
  /** The NPC profiles in the loaded demo pack; absent or empty means AI seats are not allowed. */
  npcProfileIds?: readonly string[];
}

export const MAX_AGENDA_MINUTES = 240;
export const MIN_PACE_SECONDS = 10;
export const MAX_PACE_SECONDS = 600;

export const DEFAULT_MEETING_PACE: MeetingPace = {
  ownerQuietBelow: 30,
  quietCheckAfter: 120,
  comingUpBefore: 60,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

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
    error(errors, 'seats', 'Add at least one person to the meeting.');
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
    error(errors, 'seats', 'Add at least one person to the meeting.');
  }
  if (aiCount > 0 && personCount !== 1) {
    error(errors, 'seats', 'A meeting with AI stand-ins has room for one person.');
  }

  return { list, personCount, aiCount };
}

function readPace(value: unknown, errors: SetupFieldError[]): MeetingPace {
  const pace: MeetingPace = { ...DEFAULT_MEETING_PACE };
  if (!isObject(value)) {
    error(errors, 'pace', 'Enter the three pace warnings in seconds.');
    return pace;
  }

  const fields: Array<keyof MeetingPace> = ['ownerQuietBelow', 'quietCheckAfter', 'comingUpBefore'];
  const labels: Record<keyof MeetingPace, string> = {
    ownerQuietBelow: 'Quiet owner talk',
    quietCheckAfter: 'Quiet check time',
    comingUpBefore: 'Coming-up warning',
  };
  const valid: Record<keyof MeetingPace, boolean> = {
    ownerQuietBelow: false,
    quietCheckAfter: false,
    comingUpBefore: false,
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
      valid[field] = true;
    } else {
      error(
        errors,
        `pace.${field}`,
        `${labels[field]} must be a whole number of seconds between ${MIN_PACE_SECONDS} and ${MAX_PACE_SECONDS}.`,
      );
    }
  }

  if (valid.ownerQuietBelow && valid.quietCheckAfter && pace.ownerQuietBelow >= pace.quietCheckAfter) {
    error(errors, 'pace.ownerQuietBelow', 'Quiet owner talk must be shorter than the quiet check time.');
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
      agenda,
      roles: roles.list,
      seats: seats.list,
      pace,
      source,
    },
  };
}

/** The NPC profile ids a loaded scenario offers as AI stand-ins. */
export function demoPackNpcProfileIds(scenario: Scenario): string[] {
  return (scenario.npcs ?? []).map((npc) => npc.attendee);
}

/**
 * The starting setup for the loaded scenario, marked as coming from the demo pack. The first
 * playable attendee is the person's seat and every other attendee is played by their NPC profile;
 * a scenario without a demo pack gets all-person seats.
 */
export function defaultMeetingSetup(scenario: Scenario): MeetingSetup {
  const roles: MeetingSetupRole[] = scenario.roles.map((role) => ({
    id: role.id,
    label: role.label,
    facilitator: role.facilitator === true,
  }));

  const agenda: MeetingSetupAgendaItem[] = scenario.agenda.map((item, index) => ({
    id: `agenda-${index + 1}`,
    title: item.title,
    minutes: item.minutes,
    ownerRoleId: item.ownerRole,
  }));

  const npcByAttendee = new Map((scenario.npcs ?? []).map((npc) => [npc.attendee, npc]));
  const person =
    scenario.attendees.find((attendee) => npcByAttendee.get(attendee.name)?.playable === true) ??
    scenario.attendees[0];
  const useAi =
    scenario.attendees.length > 1 &&
    scenario.attendees.every((attendee) => attendee === person || npcByAttendee.has(attendee.name));

  let seats: MeetingSetupSeat[];
  if (scenario.attendees.length > 0) {
    seats = scenario.attendees.map((attendee) => {
      const npc = npcByAttendee.get(attendee.name);
      return useAi && attendee !== person && npc !== undefined
        ? {
            displayName: attendee.name,
            roleId: attendee.role,
            kind: 'ai' as const,
            npcProfileId: npc.attendee,
          }
        : { displayName: attendee.name, roleId: attendee.role, kind: 'person' as const };
    });
  } else {
    const firstRole = scenario.roles[0];
    seats =
      firstRole === undefined
        ? []
        : [{ displayName: firstRole.label, roleId: firstRole.id, kind: 'person' }];
  }

  return {
    title: scenario.meetingTitle,
    agenda,
    roles,
    seats,
    pace: { ...DEFAULT_MEETING_PACE },
    source: {
      title: 'demo pack',
      agenda: 'demo pack',
      roles: 'demo pack',
      seats: 'demo pack',
      pace: 'demo pack',
    },
  };
}
