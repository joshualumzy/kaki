import {
  meetingScenarioFromSetup,
  type RunnerMeetingSnapshot,
  type Scenario,
  type ScenarioRole,
} from '@kaki/shared';
import type { MeetingSession } from './session';

export interface RunnerStateInput {
  meetingId: string;
  session: MeetingSession;
  fullScenario: Scenario;
  /** The agenda item the live clock is on, when the meeting is running. */
  agendaIndex?: number | undefined;
  /** The server-owned pause flag (the agenda clock's). */
  paused?: boolean | undefined;
}

/** The role that chairs a meeting: the facilitator, or the seat of the host character. */
function hostRoleOf(scenario: Scenario): ScenarioRole | undefined {
  const facilitator = scenario.roles.find((role) => role.facilitator === true);
  if (facilitator !== undefined) return facilitator;
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc === undefined) return undefined;
  const attendee = scenario.attendees.find((candidate) => candidate.name === hostNpc.attendee);
  return scenario.roles.find((role) => role.id === attendee?.role);
}

/** The name the AI host speaks under, even when a person has taken its seat. */
function hostNameOf(scenario: Scenario, hostRole: ScenarioRole | undefined): string | undefined {
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc !== undefined) return hostNpc.attendee;
  if (hostRole === undefined) return undefined;
  return scenario.attendees.find((attendee) => attendee.role === hostRole.id)?.name;
}

/** True when a real person holds the host's seat right now. The roster, not the runner, decides. */
export function hostIsHumanFromSession(
  session: Pick<MeetingSession, 'holders'>,
  scenario: Scenario,
): boolean {
  const hostRole = hostRoleOf(scenario);
  return hostRole !== undefined && session.holders().some((holder) => holder.seat === hostRole.id);
}

/**
 * The one scenario the meeting is (or would be) run with. A started meeting uses its sealed
 * scenario; a lobby uses the draft the next Start would seal, which is the active scenario until
 * the owner edits the draft. This never reads the browser-facing `seating()` view.
 */
function runnerScenario({ session, fullScenario }: RunnerStateInput): Scenario {
  const phase = session.phase();
  if (phase === 'running' || phase === 'ended') return session.active();
  if (phase === 'starting') return session.candidate() ?? session.active();
  if (!session.draftTouched()) return session.active();
  try {
    return meetingScenarioFromSetup(fullScenario, session.draft());
  } catch {
    // An invalid draft cannot be started as it stands; the live scenario is the honest fallback.
    return session.active();
  }
}

/**
 * Build the AI runner's meeting snapshot from the meeting session. One function feeds both the
 * service-only endpoint and the RUNNER_STATE events, so a runner never sees two shapes.
 */
export function buildRunnerMeetingSnapshot(input: RunnerStateInput): RunnerMeetingSnapshot {
  const scenario = runnerScenario(input);
  const hostRole = hostRoleOf(scenario);
  const hostName = hostNameOf(scenario, hostRole);
  const agenda = scenario.agenda;
  const requested = input.agendaIndex ?? 0;
  const agendaIndex = agenda.length === 0 ? 0 : Math.max(0, Math.min(requested, agenda.length - 1));
  return {
    meetingId: input.meetingId,
    phase: input.session.phase(),
    started: input.session.phase() === 'running',
    agendaIndex,
    agenda: agenda.map((item) => ({ ...item })),
    roles: scenario.roles.map((role) => ({ ...role })),
    cast: (scenario.npcs ?? []).map((npc) => ({ ...npc })),
    ...(scenario.meetingTitle === undefined ? {} : { meetingTitle: scenario.meetingTitle }),
    ...(hostName === undefined ? {} : { hostName }),
    ...(hostRole === undefined ? {} : { hostSeat: hostRole.id }),
    hostIsHuman: hostRole !== undefined && input.session.holders().some((holder) => holder.seat === hostRole.id),
    paused: input.paused === true,
    version: 0,
  };
}
