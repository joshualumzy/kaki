import type { AgendaItem, NpcProfile, Scenario, ScenarioRole } from './scenario';
import type { Role } from './roles';

/**
 * One server process, ordered by when it booted. The random id keeps two boots in the same
 * millisecond distinct; `startedAt` is what lets a surviving runner tell a newer incarnation from
 * an older one without remembering every epoch it has seen.
 */
export interface RunnerEpoch {
  /** Wall-clock milliseconds when the server process booted. */
  startedAt: number;
  /** A random id for this process. */
  id: string;
}

/**
 * The fence on a runner snapshot. `epoch` names one server process; `seq` counts the snapshots
 * that process has published. A restarted server has a newer epoch but restarts its sequence, so the
 * epoch is what lets a surviving runner adopt it without mistaking an old read for a new one.
 */
export interface RunnerSnapshotVersion {
  epoch: RunnerEpoch;
  seq: number;
}

/** True when `a` and `b` name the same server process. */
export function sameRunnerEpoch(a: RunnerEpoch, b: RunnerEpoch): boolean {
  return a.startedAt === b.startedAt && a.id === b.id;
}

/**
 * A total order over server incarnations. A process that booted later is newer; two boots in the
 * same millisecond are ordered by id so the choice is stable and never rolls back.
 */
export function runnerEpochNewer(a: RunnerEpoch, b: RunnerEpoch): boolean {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return a.id > b.id;
}

/** The one meeting snapshot the AI runner reads; the server replaces it wholesale on every change. */
export interface RunnerMeetingSnapshot {
  meetingId: string;
  phase: 'lobby' | 'starting' | 'running' | 'ended';
  started: boolean;
  agendaIndex: number;
  /** The sealed agenda once the meeting has started, else the draft the next Start would use. */
  agenda: AgendaItem[];
  roles: ScenarioRole[];
  /** The AI seats the meeting voices, with their names and voices. */
  cast: NpcProfile[];
  meetingTitle?: string;
  hostName?: string;
  /** The host's seat (a role id), so a person in that seat is recognisable from the roster. */
  hostSeat?: string;
  hostIsHuman: boolean;
  paused: boolean;
  /** Fences stale reads: a snapshot is only newer within the same epoch when its seq is higher. */
  version: RunnerSnapshotVersion;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isAgendaIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRunnerEpoch(value: unknown): value is RunnerEpoch {
  return (
    isObject(value) &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    value.startedAt >= 0 &&
    isNonEmptyString(value.id)
  );
}

function isAgendaItem(value: unknown): value is AgendaItem {
  if (!isObject(value)) return false;
  return (
    isNonEmptyString(value.title) &&
    typeof value.minutes === 'number' &&
    Number.isFinite(value.minutes) &&
    value.minutes >= 0 &&
    typeof value.canWait === 'boolean' &&
    typeof value.deadline === 'string' &&
    isNonEmptyString(value.ownerRole)
  );
}

function isScenarioRole(value: unknown): value is ScenarioRole {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    (value.facilitator === undefined || typeof value.facilitator === 'boolean')
  );
}

function isNpcProfile(value: unknown): value is NpcProfile {
  return (
    isObject(value) &&
    isNonEmptyString(value.attendee) &&
    typeof value.voice === 'string' &&
    typeof value.personality === 'string' &&
    typeof value.agenda === 'string' &&
    Array.isArray(value.concerns) &&
    value.concerns.every((concern) => typeof concern === 'string') &&
    (value.role === undefined || value.role === 'host' || value.role === 'participant' || value.role === 'observer') &&
    (value.playable === undefined || typeof value.playable === 'boolean') &&
    (value.knows === undefined ||
      (Array.isArray(value.knows) && value.knows.every((fact) => typeof fact === 'string')))
  );
}

/** Validate a runner meeting snapshot received over HTTP or the service channel. */
export function isRunnerMeetingSnapshot(value: unknown): value is RunnerMeetingSnapshot {
  if (!isObject(value)) return false;
  const phase = value.phase;
  if (phase !== 'lobby' && phase !== 'starting' && phase !== 'running' && phase !== 'ended') return false;
  return (
    isNonEmptyString(value.meetingId) &&
    typeof value.started === 'boolean' &&
    isAgendaIndex(value.agendaIndex) &&
    Array.isArray(value.agenda) &&
    value.agenda.every(isAgendaItem) &&
    Array.isArray(value.roles) &&
    value.roles.every(isScenarioRole) &&
    Array.isArray(value.cast) &&
    value.cast.every(isNpcProfile) &&
    (value.meetingTitle === undefined || typeof value.meetingTitle === 'string') &&
    (value.hostName === undefined || typeof value.hostName === 'string') &&
    (value.hostSeat === undefined || typeof value.hostSeat === 'string') &&
    typeof value.hostIsHuman === 'boolean' &&
    typeof value.paused === 'boolean' &&
    isObject(value.version) &&
    isRunnerEpoch(value.version.epoch) &&
    isAgendaIndex(value.version.seq)
  );
}

/** The role that chairs this meeting, when the scenario names one. */
export function facilitatorRole(roles: readonly ScenarioRole[]): Role | undefined {
  return roles.find((role) => role.facilitator === true)?.id;
}

/** The seat and attendee that chair a meeting, read from the same effective scenario everywhere. */
export interface MeetingHostIdentity {
  /** The role id of the facilitator, or of the NPC marked as host when no role is the facilitator. */
  seat?: string;
  /** The attendee who holds that seat. */
  name?: string;
}

/**
 * Resolve the meeting's host from its effective setup. A facilitator role decides the seat and the
 * attendee in it; the legacy `role: 'host'` NPC profile is only a fallback for scenarios with no
 * facilitator. Moving the facilitator therefore moves the host identity with it.
 */
export function hostIdentityOf(scenario: Scenario): MeetingHostIdentity {
  const facilitator = scenario.roles.find((role) => role.facilitator === true);
  if (facilitator !== undefined) {
    const attendee = scenario.attendees.find((candidate) => candidate.role === facilitator.id);
    return { seat: facilitator.id, ...(attendee === undefined ? {} : { name: attendee.name }) };
  }
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc === undefined) return {};
  const attendee = scenario.attendees.find((candidate) => candidate.name === hostNpc.attendee);
  return { ...(attendee === undefined ? {} : { seat: attendee.role }), name: hostNpc.attendee };
}

/**
 * Give the effective host attendee the host profile the conversation reads. A pack's old host
 * profile is demoted when the facilitator seat moved to another AI attendee.
 */
export function castWithHostProfile(
  cast: readonly NpcProfile[],
  hostName: string | undefined,
): NpcProfile[] {
  if (hostName === undefined) return cast.map((npc) => ({ ...npc }));
  return cast.map((npc) => {
    if (npc.attendee === hostName) return { ...npc, role: 'host' };
    if (npc.role === 'host') return { ...npc, role: 'participant' };
    return { ...npc };
  });
}
