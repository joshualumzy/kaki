import {
  hostIdentityOf,
  runnerEpochNewer,
  sameRunnerEpoch,
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
 * server epoch, or when a newer server epoch arrives through the current service connection. That
 * keeps a slow fetch or a retained event from rolling the runner backwards, including across a
 * restart. `clear()` forgets the snapshot but not the ordering, so a reset that republishes the same
 * version is still adopted.
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
   * `authoritative` marks the reconnect read made by `meetingSync.connected()`: the server on the
   * other end of that new connection is the truth even if its clock moved back, so it may replace
   * an epoch that would otherwise look older.
   */
  apply(
    snapshot: RunnerMeetingSnapshot,
    options?: { currentConnection?: boolean; authoritative?: boolean },
  ): boolean;
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
        if (sameRunnerEpoch(next.version.epoch, knownVersion.epoch)) {
          // Same incarnation: the sequence is the only ordering. A snapshot at the known seq is
          // normally a repeat, but after `clear()` the snapshot is gone and must be re-adopted.
          const afterClear = snapshot === undefined;
          if (next.version.seq < knownVersion.seq) {
            log?.(
              `ignored a stale runner snapshot from epoch ${knownVersion.epoch.id}: ` +
                `seq ${next.version.seq} is older than ${knownVersion.seq}`,
            );
            return false;
          }
          if (next.version.seq === knownVersion.seq && !afterClear) return false;
          if (afterClear && knownMeetingId !== undefined && next.meetingId !== knownMeetingId) {
            log?.(
              `ignored a runner snapshot for meeting ${next.meetingId}: ` +
                `the next snapshot must be for ${knownMeetingId ?? 'the expected meeting'}`,
            );
            return false;
          }
        } else {
          // A different epoch is only believable when the current service connection delivered it,
          // and only when it is a newer incarnation. `clear()` keeps this ordering too.
          if (options?.currentConnection !== true) {
            log?.(
              `ignored a runner snapshot from another server epoch (${next.version.epoch.id}) ` +
                'on a path that is not the current service connection',
            );
            return false;
          }
          if (!runnerEpochNewer(next.version.epoch, knownVersion.epoch)) {
            if (options?.authoritative !== true) {
              log?.(
                `ignored a runner snapshot from an older server epoch (${next.version.epoch.id}, ` +
                  `booted ${next.version.epoch.startedAt}) while holding ${knownVersion.epoch.id} ` +
                  `(booted ${knownVersion.epoch.startedAt})`,
              );
              return false;
            }
            // The connection this read came down is the current one; a clock that moved back must
            // not lock the runner out of the server that is actually serving it.
            log?.('[runner] adopted server epoch with older start time (clock moved back?)');
          }
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
