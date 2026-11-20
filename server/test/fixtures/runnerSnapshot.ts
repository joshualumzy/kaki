import { castWithHostProfile, hostIdentityOf, type RunnerMeetingSnapshot, type Scenario } from '@kaki/shared';

/** A complete runner snapshot from a scenario, so tests never hand-build the wire shape. */
export function runnerSnapshot(
  scenario: Scenario,
  overrides: Partial<RunnerMeetingSnapshot> = {},
): RunnerMeetingSnapshot {
  const host = hostIdentityOf(scenario);
  const hostSeat = host.seat;
  const hostName = host.name;
  return {
    meetingId: 'meeting-1',
    phase: 'lobby',
    started: false,
    agendaIndex: 0,
    agenda: scenario.agenda.map((item) => ({ ...item })),
    roles: scenario.roles.map((role) => ({ ...role })),
    cast: castWithHostProfile(scenario.npcs ?? [], hostName),
    ...(scenario.meetingTitle === undefined ? {} : { meetingTitle: scenario.meetingTitle }),
    ...(hostName === undefined ? {} : { hostName }),
    ...(hostSeat === undefined ? {} : { hostSeat }),
    hostIsHuman: false,
    paused: false,
    version: 1,
    ...overrides,
  };
}
