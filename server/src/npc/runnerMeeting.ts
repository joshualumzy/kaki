import {
  hostIdentityOf,
  type AgendaItem,
  type NpcProfile,
  type RunnerMeetingSnapshot,
  type Scenario,
  type ScenarioRole,
} from '@kaki/shared';

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
  /**
   * Replace the snapshot when it is newer; returns false when it is stale or identical.
   * `newSequence` lets a fenced reconnect/prepare adopt a different meeting id even at a lower
   * revision, because that meeting's revision starts again.
   */
  apply(snapshot: RunnerMeetingSnapshot, options?: { newSequence?: boolean }): boolean;
  /** Forget the snapshot, remembering which meeting (if known) must be fenced next. */
  clear(nextMeetingId?: string): void;
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

  function host(): ReturnType<typeof hostIdentityOf> {
    return hostIdentityOf(view());
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
    hostName: () => snapshot?.hostName ?? host().name,
    hostSeat: () => snapshot?.hostSeat ?? host().seat,
    hostIsHuman: () => snapshot?.hostIsHuman === true,
    scenario: view,
    apply(next, options) {
      if (knownMeetingId !== undefined || snapshot !== undefined) {
        if (next.meetingId === knownMeetingId) {
          // After a clear the snapshot is gone but its id is expected: that meeting's revision may
          // start again. A snapshot still held only ever moves forward.
          if (snapshot !== undefined && next.version <= knownVersion) return false;
        } else if (options?.newSequence !== true) {
          // Without a fenced path, a stale answer for another meeting must never replace this one.
          return false;
        }
      }
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
