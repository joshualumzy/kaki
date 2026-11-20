import { setMeetingAgenda } from './demo';
import { errorMessage } from './errors';
import { isNonEmptyString } from './guards';
import { parseScenario } from './scenario';
import type { AgendaItem, Attendee, NpcProfile, Scenario, ScenarioRole } from './scenarioTypes';
import {
  DEFAULT_MEETING_PACE,
  type MeetingSetup,
  type MeetingSetupAgendaItem,
  type MeetingSetupRole,
  type MeetingSetupSeat,
  type SetupFieldError,
} from './setupTypes';

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
      displayName: pack?.displayName ?? name,
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
