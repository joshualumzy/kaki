import {
  castWithHostProfile,
  hostIdentityOf,
  meetingScenarioFromSetup,
  type RunnerMeetingSnapshot,
  type Scenario,
} from '@kaki/shared';
import type { MeetingSession } from './session';

interface RunnerStateInput {
  meetingId: string;
  session: MeetingSession;
  fullScenario: Scenario;
  /** The agenda item the live clock is on, when the meeting is running. */
  agendaIndex?: number | undefined;
  /** The server-owned pause flag (the agenda clock's). */
  paused?: boolean | undefined;
  /** Why the meeting is paused, when it is (the agenda clock's). */
  pauseKind?: RunnerMeetingSnapshot['pauseKind'];
  /** Set while the room is off the record, so the listener stops sending audio to speech recognition. */
  offTheRecordSince?: string | undefined;
}

/** True when a real person holds the host's seat right now. The roster, not the runner, decides. */
export function hostIsHumanFromSession(
  session: Pick<MeetingSession, 'holders'>,
  scenario: Scenario,
): boolean {
  const hostSeat = hostIdentityOf(scenario).seat;
  return hostSeat !== undefined && session.holders().some((holder) => holder.seat === hostSeat);
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
 * service-only endpoint and the RUNNER_STATE events, so a runner never sees two shapes. The caller
 * adds the server-incarnation version, because only the process that publishes knows its sequence.
 */
export function buildRunnerMeetingSnapshot(input: RunnerStateInput): Omit<RunnerMeetingSnapshot, 'version'> {
  const scenario = runnerScenario(input);
  const host = hostIdentityOf(scenario);
  const agenda = scenario.agenda;
  const kind = input.session.kind();
  const requested = input.agendaIndex ?? 0;
  const agendaIndex = agenda.length === 0 ? 0 : Math.max(0, Math.min(requested, agenda.length - 1));
  return {
    meetingId: input.meetingId,
    phase: input.session.phase(),
    started: input.session.phase() === 'running',
    agendaIndex,
    agenda: agenda.map((item) => ({ ...item })),
    roles: scenario.roles.map((role) => ({ ...role })),
    cast: castWithHostProfile(scenario.npcs ?? [], host.name),
    ...(kind === undefined ? {} : { kind }),
    ...(scenario.organisation === undefined ? {} : { organisation: scenario.organisation }),
    attendeeNames: scenario.attendees.map((attendee) => attendee.name),
    ...(scenario.meetingTitle === undefined ? {} : { meetingTitle: scenario.meetingTitle }),
    ...(host.name === undefined ? {} : { hostName: host.name }),
    ...(host.seat === undefined ? {} : { hostSeat: host.seat }),
    hostIsHuman: host.seat !== undefined && input.session.holders().some((holder) => holder.seat === host.seat),
    paused: input.paused === true,
    ...(input.pauseKind === undefined ? {} : { pauseKind: input.pauseKind }),
    offTheRecord: input.offTheRecordSince === undefined ? null : { since: input.offTheRecordSince },
  };
}
