import type { AgendaItem, NpcProfile, ScenarioRole } from './scenario';
import type { Role } from './roles';

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
  /** Monotonic across the server: an older snapshot never replaces a newer one. */
  version: number;
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
    isAgendaIndex(value.version)
  );
}

/** The role that chairs this meeting, when the scenario names one. */
export function facilitatorRole(roles: readonly ScenarioRole[]): Role | undefined {
  return roles.find((role) => role.facilitator === true)?.id;
}
