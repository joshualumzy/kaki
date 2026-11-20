import { setMeetingAgenda } from './demo';
import { errorMessage } from './errors';
import { isNonEmptyString, isObject } from './guards';
import {
  parseScenario,
  RESERVED_ROLE_ID,
  ROLE_ID_PATTERN,
  type AgendaItem,
  type Attendee,
  type NpcProfile,
  type Scenario,
  type ScenarioRole,
} from './scenario';

/** Where a group of setup fields came from, shown next to them on the setup screen. */
export type SetupSource = 'calendar invite' | 'demo pack' | 'typed';

const SETUP_SOURCES: readonly SetupSource[] = ['calendar invite', 'demo pack', 'typed'];

/** One agenda item in the pre-Start setup. */
export interface MeetingSetupAgendaItem {
  id: string;
  title: string;
  minutes: number;
  /** The id of the role that owns this item. */
  ownerRoleId: string;
}

/** One role in the pre-Start setup. */
interface MeetingSetupRole {
  id: string;
  label: string;
  /** Whether this role runs the meeting. */
  facilitator: boolean;
}

type MeetingSetupSeatKind = 'person' | 'ai';

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

interface MeetingSetupSources {
  title: SetupSource;
  agenda: SetupSource;
  roles: SetupSource;
  seats: SetupSource;
  pace: SetupSource;
}

/** The one authoritative meeting setup saved before Start. */
export interface MeetingSetup {
  title: string;
  /** The team or organisation the owner typed; absent when they left it blank. */
  organisation?: string;
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

type SetupParseResult =
  | { ok: true; value: MeetingSetup }
  | { ok: false; errors: SetupFieldError[] };

interface ParseMeetingSetupOptions {
  /** The NPC profiles in the loaded demo pack; absent or empty means AI seats are not allowed. */
  npcProfileIds?: readonly string[];
}

export const MAX_AGENDA_MINUTES = 240;
const MIN_PACE_SECONDS = 10;
const MAX_PACE_SECONDS = 600;
/** A team or organisation name is kept short enough to say and show beside the title. */
export const MAX_ORGANISATION_LENGTH = 120;

export const DEFAULT_MEETING_PACE: MeetingPace = {
  ownerQuietBelow: 30,
  quietCheckAfter: 120,
  comingUpBefore: 60,
};

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

/** The NPC profile ids a loaded scenario offers as AI stand-ins. */
export function demoPackNpcProfileIds(scenario: Scenario): string[] {
  return (scenario.npcs ?? []).map((npc) => npc.attendee);
}

/** The demo-pack NPC profile that plays a role, if the pack has one. */
export function demoPackNpcProfileForRole(
  scenario: Scenario,
  roleId: string,
): string | undefined {
  const profileIds = new Set(demoPackNpcProfileIds(scenario));
  return scenario.attendees.find(
    (attendee) => attendee.role === roleId && profileIds.has(attendee.name),
  )?.name;
}

/**
 * The demo-pack NPC profile a seat can switch to, if any. An AI seat keeps its chosen
 * profile; a person seat matches the pack by name, then by role, so renaming a pack seat
 * keeps its stand-in available. A typed seat with no pack match stays person-only.
 */
export function demoPackNpcProfileForSeat(
  scenario: Scenario,
  seat: MeetingSetupSeat,
): string | undefined {
  const profileIds = new Set(demoPackNpcProfileIds(scenario));
  if (
    seat.kind === 'ai' &&
    isNonEmptyString(seat.npcProfileId) &&
    profileIds.has(seat.npcProfileId)
  ) {
    return seat.npcProfileId;
  }

  const name = seat.displayName.trim().toLowerCase();
  const byName = (scenario.npcs ?? []).find(
    (npc) => npc.attendee.trim().toLowerCase() === name && profileIds.has(npc.attendee),
  );
  return byName?.attendee ?? demoPackNpcProfileForRole(scenario, seat.roleId);
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
  // A person without a pack profile is the meeting's human. When the pack covers everyone, the
  // first playable character is the human and the rest are AI stand-ins, as before.
  const person =
    scenario.attendees.find((attendee) => !npcByAttendee.has(attendee.name)) ??
    scenario.attendees.find((attendee) => npcByAttendee.get(attendee.name)?.playable === true) ??
    scenario.attendees[0];

  let seats: MeetingSetupSeat[];
  if (scenario.attendees.length > 0) {
    seats = scenario.attendees.map((attendee) => {
      const npc = npcByAttendee.get(attendee.name);
      return attendee !== person && npc !== undefined
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
    ...(scenario.organisation === undefined ? {} : { organisation: scenario.organisation }),
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

/**
 * The agenda a sealed setup runs: setup order, minutes and owners, with each title matched to the
 * pack's agenda item so its briefing, links and NPC knowledge stay attached. A title the pack does
 * not have becomes a plain item (no briefing) with the required fields filled in.
 *
 * `titleOrder` lets a restore keep the order the running meeting was actually using; a title missing
 * from the setup there falls back to the pack item, so an older save still loads.
 */
function meetingAgendaFromSetup(
  setup: MeetingSetup,
  scenario: Scenario,
  titleOrder: readonly string[] = setup.agenda.map((item) => item.title),
): AgendaItem[] {
  const sourceByTitle = new Map(scenario.agenda.map((item) => [item.title, item]));
  const setupByTitle = new Map(setup.agenda.map((item) => [item.title, item]));
  return titleOrder.map((title) => {
    const source = sourceByTitle.get(title);
    const item = setupByTitle.get(title);
    if (item === undefined) {
      if (source === undefined) throw new Error(`Unknown meeting agenda title: ${title}`);
      return source;
    }
    if (source === undefined) {
      return { title, minutes: item.minutes, canWait: true, deadline: 'today', ownerRole: item.ownerRoleId };
    }
    return { ...source, minutes: item.minutes, ownerRole: item.ownerRoleId };
  });
}

/**
 * True when a sealed setup owns no demo-pack content at all: every seat is a person and no agenda
 * item is a pack topic. Such a meeting is pack-free, so the demo pack's company records and facts
 * must stay out of it.
 */
export function isPackFreeMeeting(setup: MeetingSetup, pack: Scenario): boolean {
  if (setup.seats.some((seat) => seat.kind === 'ai')) return false;
  const packTitles = new Set(pack.agenda.map((item) => item.title));
  return setup.agenda.every((item) => !packTitles.has(item.title));
}

/**
 * The NPC profiles the runner may voice for a sealed setup: only the profiles of seats marked `ai`.
 * A pack seat switched to a person, or a typed seat with no profile, is left out.
 */
function setupAiCast(scenario: Scenario, setup: MeetingSetup): NpcProfile[] {
  const profiles = new Set(
    setup.seats.flatMap((seat) => (seat.kind === 'ai' && seat.npcProfileId !== undefined ? [seat.npcProfileId] : [])),
  );
  return (scenario.npcs ?? []).filter((npc) => profiles.has(npc.attendee));
}

/**
 * The scenario roles a sealed setup runs: its ids, labels and facilitator flag. A role the pack
 * already has keeps its pack data (a phone card, for example); a new role is defined by the setup.
 * A pack role the setup omits stays in the registry, so a seat or saved task naming it still parses.
 * A pack-free meeting keeps no pack role data at all: a reused role id is the owner's role, and its
 * card must not carry another company's briefing.
 */
export function setupScenarioRoles(scenario: Scenario, setup: MeetingSetup): ScenarioRole[] {
  const packFree = isPackFreeMeeting(setup, scenario);
  const packRoles = new Map(scenario.roles.map((role) => [role.id, role]));
  const applied = new Set<string>();
  const roles = setup.roles.map((role) => {
    applied.add(role.id);
    const packRole = packRoles.get(role.id);
    return packRole === undefined || packFree
      ? { id: role.id, label: role.label, facilitator: role.facilitator }
      : { ...packRole, label: role.label, facilitator: role.facilitator };
  });
  return [
    ...roles,
    ...scenario.roles
      .filter((role) => !applied.has(role.id))
      .map((role) => (packFree ? { id: role.id, label: role.label, facilitator: role.facilitator } : role)),
  ];
}

/**
 * The role ids a setup offers as person seats, in setup order. A role the owner added in setup is a
 * seat even when the demo pack has no attendee for it, so this never consults the pack's cast.
 */
export function setupPersonSeatRoles(setup: MeetingSetup): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const seat of setup.seats) {
    if (seat.kind !== 'person' || seen.has(seat.roleId)) continue;
    seen.add(seat.roleId);
    roles.push(seat.roleId);
  }
  return roles;
}

/**
 * The people actually at a sealed meeting: one attendee per seat. A person seat takes the name the
 * owner typed; an AI seat is the demo-pack profile it plays. Pack attendees the setup does not seat
 * are never carried over, so an absent character can never be offered work or counted as quiet.
 */
function setupAttendees(scenario: Scenario, setup: MeetingSetup): Attendee[] {
  const packByName = new Map(
    scenario.attendees.map((attendee) => [attendee.name.trim().toLowerCase(), attendee]),
  );
  const seen = new Set<string>();
  const attendees: Attendee[] = [];
  for (const seat of setup.seats) {
    const name = (seat.kind === 'ai' ? seat.npcProfileId ?? seat.displayName : seat.displayName).trim();
    const key = name.toLowerCase();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const pack = packByName.get(key);
    attendees.push({
      name,
      role: seat.roleId,
      zoomDisplayName: pack?.zoomDisplayName ?? name,
      ...(pack?.spokenJob === undefined ? {} : { spokenJob: pack.spokenJob }),
    });
  }
  return attendees;
}

/**
 * Drop pack content that names someone the setup does not seat: a briefing fact or discussion
 * angle from an absent colleague is not something the room can use. Items keep their other data.
 */
function fitPackContentToAttendees(meeting: Scenario): void {
  const names = new Set(meeting.attendees.map((attendee) => attendee.name));
  meeting.agenda = meeting.agenda.map((item) => {
    const next = { ...item };
    if (item.briefing !== undefined) {
      const briefing = item.briefing
        .map((fact) => ({ ...fact, knownBy: fact.knownBy.filter((knower) => names.has(knower.attendee)) }))
        .filter((fact) => fact.knownBy.length > 0);
      if (briefing.length > 0) next.briefing = briefing;
      else delete next.briefing;
    }
    if (item.discussion !== undefined) {
      const openingViews = item.discussion.openingViews.filter((view) => names.has(view.attendee));
      const tradeOffs = item.discussion.tradeOffs.filter((tradeOff) => names.has(tradeOff.attendee));
      if (openingViews.length > 0 && tradeOffs.length > 0) {
        next.discussion = { ...item.discussion, openingViews, tradeOffs };
      } else {
        delete next.discussion;
      }
    }
    return next;
  });
  if (meeting.npcs !== undefined) {
    meeting.npcs = meeting.npcs.map((npc) => {
      const next = { ...npc };
      if (npc.tensions !== undefined) {
        const tensions = npc.tensions.filter(
          (tension) => names.has(tension.with) && tension.with !== npc.attendee,
        );
        if (tensions.length > 0) next.tensions = tensions;
        else delete next.tensions;
      }
      return next;
    });
  }
}

interface MeetingScenarioFromSetupOptions {
  /** The agenda order to run; defaults to the setup's own order. */
  agendaOrder?: readonly string[];
}

/**
 * The meeting scenario a setup describes, built the one way the app builds any meeting scenario:
 * pack title, roles and cast applied over the pack, and the setup agenda normalized so links to
 * omitted topics are dropped. A pack-free meeting takes its organisation only from the owner's own
 * field, and keeps none of the pack's situation, background, register or wording.
 */
export function meetingScenarioFromSetup(
  scenario: Scenario,
  setup: MeetingSetup,
  options: MeetingScenarioFromSetupOptions = {},
): Scenario {
  const packFree = isPackFreeMeeting(setup, scenario);
  const meeting: Scenario = {
    ...scenario,
    meetingTitle: setup.title,
    roles: setupScenarioRoles(scenario, setup),
    npcs: setupAiCast(scenario, setup).map((npc) => ({ ...npc, playable: false })),
    joinSeats: setupPersonSeatRoles(setup),
    agenda: [...scenario.agenda],
    attendees: setupAttendees(scenario, setup),
  };
  const organisation = setup.organisation ?? (packFree ? undefined : scenario.organisation);
  if (organisation === undefined) delete meeting.organisation;
  else meeting.organisation = organisation;
  if (packFree) {
    delete meeting.situation;
    delete meeting.background;
    delete meeting.vocabulary;
    delete meeting.glossary;
    delete meeting.hostBrief;
    delete meeting.excludedPairs;
    delete meeting.speechRegister;
  }
  setMeetingAgenda(meeting, scenario, meetingAgendaFromSetup(setup, scenario, options.agendaOrder), {
    allowPlain: true,
  });
  fitPackContentToAttendees(meeting);
  return meeting;
}

type MeetingScenarioResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: SetupFieldError[] };

const HOST_BRIEFING_PROBLEM =
  /^agenda\[(\d+)\]\.briefing\[(\d+)\]\.knownBy\[(\d+)\]\.attendee "(.+)" is the host and cannot know a briefing fact$/;

/** Translate a derived scenario's parse problems into field errors an owner can act on. */
function scenarioSetupErrors(
  meeting: Scenario,
  setup: MeetingSetup,
  error: unknown,
): SetupFieldError[] {
  const problems = errorMessage(error)
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line !== '' && line !== 'Invalid scenario:');
  const errors: SetupFieldError[] = [];
  for (const problem of problems) {
    const hostBriefing = HOST_BRIEFING_PROBLEM.exec(problem);
    if (hostBriefing !== null) {
      const agendaIndex = Number(hostBriefing[1]);
      const attendeeName = hostBriefing[4]!;
      const topic = meeting.agenda[agendaIndex]?.title ?? `agenda item ${agendaIndex + 1}`;
      const roleId = meeting.attendees.find((attendee) => attendee.name === attendeeName)?.role;
      const roleIndex = setup.roles.findIndex((role) => role.id === roleId);
      const roleLabel = setup.roles[roleIndex]?.label ?? roleId ?? 'that role';
      errors.push({
        field: roleIndex >= 0 ? `roles[${roleIndex}].facilitator` : 'roles',
        message:
          `"${attendeeName}" is the facilitator through the "${roleLabel}" role, so they cannot share ` +
          `the briefing for "${topic}". Turn off "facilitator" for "${roleLabel}", or give that fact to another seat.`,
      });
      continue;
    }
    const agenda = /^agenda\[(\d+)\]/.exec(problem);
    if (agenda !== null) {
      const index = Number(agenda[1]);
      const topic = meeting.agenda[index]?.title;
      errors.push({
        field: `agenda[${index}]`,
        message: topic === undefined ? problem : `${problem} (topic "${topic}")`,
      });
      continue;
    }
    const role = /^roles\[(\d+)\]/.exec(problem);
    if (role !== null) {
      const index = Number(role[1]);
      const roleId = meeting.roles[index]?.id;
      const setupIndex = setup.roles.findIndex((candidate) => candidate.id === roleId);
      errors.push({
        field: setupIndex >= 0 ? `roles[${setupIndex}]` : 'roles',
        message: roleId === undefined ? problem : `${problem} (role "${roleId}")`,
      });
      continue;
    }
    if (problem.startsWith('npcs[') || problem.startsWith('attendees[')) {
      errors.push({ field: 'seats', message: problem });
      continue;
    }
    errors.push({ field: 'setup', message: `The meeting this setup describes is not valid: ${problem}` });
  }
  return errors.length > 0
    ? errors
    : [{ field: 'setup', message: 'The meeting this setup describes is not valid.' }];
}

/**
 * Derive the meeting a setup describes and validate it. A setup can pass field validation and still
 * describe a meeting the scenario rules refuse (for example, a facilitator who holds a briefing
 * fact); callers use this before storing, starting or restoring it.
 */
export function deriveMeetingScenario(
  scenario: Scenario,
  setup: MeetingSetup,
  options: MeetingScenarioFromSetupOptions = {},
): MeetingScenarioResult {
  let meeting: Scenario;
  try {
    meeting = meetingScenarioFromSetup(scenario, setup, options);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          field: 'setup',
          message: `The meeting this setup describes could not be built: ${errorMessage(error)}`,
        },
      ],
    };
  }
  try {
    parseScenario(meeting, { requireOrganisation: false });
    return { ok: true, scenario: meeting };
  } catch (error) {
    return { ok: false, errors: scenarioSetupErrors(meeting, setup, error) };
  }
}
