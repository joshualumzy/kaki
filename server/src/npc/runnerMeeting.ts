import {
  hostIdentityOf,
  type AgendaItem,
  type NpcProfile,
  type RunnerMeetingSnapshot,
  type RunnerSnapshotVersion,
  type Scenario,
  type ScenarioRole,
} from '@kaki/shared';

/**
 * The runner's one view of the meeting. It holds the server's immutable snapshot and replaces it
 * wholesale; nothing else edits it. A snapshot is accepted when its seq is higher within the same
 * server epoch, or when a new epoch arrives through the current service connection. That keeps a
 * slow fetch or a retained event from rolling the runner backwards, including across a restart.
 */
export interface RunnerMeeting {
  current(): RunnerMeetingSnapshot | undefined;
  version(): RunnerSnapshotVersion | undefined;
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
   * `currentConnection` authorises a new server epoch: only a fetch or event on the current
   * service connection may prove the server restarted, and its sequence started again.
   */
  apply(snapshot: RunnerMeetingSnapshot, options?: { currentConnection?: boolean }): boolean;
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
export function createRunnerMeeting(
  base: Scenario,
  initial?: RunnerMeetingSnapshot,
  log?: (message: string) => void,
): RunnerMeeting {
  let snapshot: RunnerMeetingSnapshot | undefined;
  let knownMeetingId: string | undefined;
  let knownVersion: RunnerSnapshotVersion | undefined;
  const retiredEpochs = new Set<string>();
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
      if (knownVersion !== undefined) {
        if (next.version.epoch === knownVersion.epoch) {
          if (next.version.seq <= knownVersion.seq) {
            if (next.version.seq < knownVersion.seq) {
              log?.(
                `ignored a stale runner snapshot from epoch ${next.version.epoch}: ` +
                  `seq ${next.version.seq} is older than ${knownVersion.seq}`,
              );
            }
            return false;
          }
        } else if (options?.currentConnection !== true) {
          // A different epoch is only believable when the current service connection delivered it.
          log?.(
            `ignored a runner snapshot from another server epoch (${next.version.epoch}) ` +
              'on a path that is not the current service connection',
          );
          return false;
        } else if (retiredEpochs.has(next.version.epoch)) {
          // Once a newer incarnation has been adopted, an older one must never come back.
          log?.(
            `ignored a runner snapshot from retired server epoch ${next.version.epoch} ` +
              `while on ${knownVersion.epoch}`,
          );
          return false;
        } else {
          retiredEpochs.add(knownVersion.epoch);
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
