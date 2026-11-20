import type { AgendaItem, NpcProfile, RunnerMeetingSnapshot, Scenario, ScenarioRole } from '@kaki/shared';

/**
 * The runner's one view of the meeting. It holds the server's immutable snapshot and replaces it
 * wholesale; nothing else edits it. A snapshot is accepted only when its version is newer than the
 * one already held, so a slow fetch or a retained event can never roll the runner backwards.
 */
export interface RunnerMeeting {
  current(): RunnerMeetingSnapshot | undefined;
  version(): number;
  meetingId(): string | undefined;
  started(): boolean;
  paused(): boolean;
  agendaIndex(): number;
  agenda(): readonly AgendaItem[];
  roles(): readonly ScenarioRole[];
  cast(): readonly NpcProfile[];
  castNames(): ReadonlySet<string>;
  hostName(): string | undefined;
  hostSeat(): string | undefined;
  hostIsHuman(): boolean;
  /** The scenario the conversation should use, made from the snapshot over the boot pack. */
  scenario(): Scenario;
  /** Replace the snapshot when it is newer; returns false when it is stale or identical. */
  apply(snapshot: RunnerMeetingSnapshot): boolean;
  /** Forget the snapshot, remembering which meeting (if known) must be fenced next. */
  clear(nextMeetingId?: string): void;
}

function hostRoleOf(scenario: Scenario): ScenarioRole | undefined {
  const facilitator = scenario.roles.find((role) => role.facilitator === true);
  if (facilitator !== undefined) return facilitator;
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc === undefined) return undefined;
  const attendee = scenario.attendees.find((candidate) => candidate.name === hostNpc.attendee);
  return scenario.roles.find((role) => role.id === attendee?.role);
}

function hostNameOf(scenario: Scenario, hostRole: ScenarioRole | undefined): string | undefined {
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc !== undefined) return hostNpc.attendee;
  if (hostRole === undefined) return undefined;
  return scenario.attendees.find((attendee) => attendee.role === hostRole.id)?.name;
}

function scenarioFromSnapshot(base: Scenario, snapshot: RunnerMeetingSnapshot): Scenario {
  return {
    ...base,
    ...(snapshot.meetingTitle === undefined ? {} : { meetingTitle: snapshot.meetingTitle }),
    roles: snapshot.roles,
    npcs: snapshot.cast,
    agenda: snapshot.agenda,
  };
}

/** Build a runner meeting from the boot pack and, when it is already known, the server's snapshot. */
export function createRunnerMeeting(base: Scenario, initial?: RunnerMeetingSnapshot): RunnerMeeting {
  let snapshot: RunnerMeetingSnapshot | undefined;
  let knownMeetingId: string | undefined;
  let knownVersion = -1;
  let derived = base;
  let names: ReadonlySet<string> = new Set((base.npcs ?? []).map((npc) => npc.attendee));

  function adopt(next: RunnerMeetingSnapshot): void {
    snapshot = next;
    knownMeetingId = next.meetingId;
    knownVersion = next.version;
    derived = scenarioFromSnapshot(base, next);
    names = new Set(next.cast.map((npc) => npc.attendee));
  }

  if (initial !== undefined) adopt(initial);

  function view(): Scenario {
    return snapshot === undefined ? base : derived;
  }

  function hostRole(): ScenarioRole | undefined {
    return hostRoleOf(view());
  }

  return {
    current: () => snapshot,
    version: () => knownVersion,
    meetingId: () => snapshot?.meetingId ?? knownMeetingId,
    started: () => snapshot?.started === true,
    paused: () => snapshot?.paused === true,
    agendaIndex: () => snapshot?.agendaIndex ?? 0,
    agenda: () => view().agenda,
    roles: () => view().roles,
    cast: () => view().npcs ?? [],
    castNames: () => names,
    hostName: () => snapshot?.hostName ?? hostNameOf(view(), hostRole()),
    hostSeat: () => snapshot?.hostSeat ?? hostRole()?.id,
    hostIsHuman: () => snapshot?.hostIsHuman === true,
    scenario: view,
    apply(next) {
      if (next.version <= knownVersion) return false;
      adopt(next);
      return true;
    },
    clear(nextMeetingId) {
      snapshot = undefined;
      knownMeetingId = nextMeetingId;
      derived = base;
      names = new Set((base.npcs ?? []).map((npc) => npc.attendee));
    },
  };
}
