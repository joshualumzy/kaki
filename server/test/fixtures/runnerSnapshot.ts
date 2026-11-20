import type { RunnerMeetingSnapshot, Scenario } from '@kaki/shared';

function hostRoleOf(scenario: Scenario): string | undefined {
  const facilitator = scenario.roles.find((role) => role.facilitator === true);
  if (facilitator !== undefined) return facilitator.id;
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc === undefined) return undefined;
  return scenario.attendees.find((attendee) => attendee.name === hostNpc.attendee)?.role;
}

function hostNameOf(scenario: Scenario, hostSeat: string | undefined): string | undefined {
  const hostNpc = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  if (hostNpc !== undefined) return hostNpc.attendee;
  return scenario.attendees.find((attendee) => attendee.role === hostSeat)?.name;
}

/** A complete runner snapshot from a scenario, so tests never hand-build the wire shape. */
export function runnerSnapshot(
  scenario: Scenario,
  overrides: Partial<RunnerMeetingSnapshot> = {},
): RunnerMeetingSnapshot {
  const hostSeat = hostRoleOf(scenario);
  const hostName = hostNameOf(scenario, hostSeat);
  return {
    meetingId: 'meeting-1',
    phase: 'lobby',
    started: false,
    agendaIndex: 0,
    agenda: scenario.agenda.map((item) => ({ ...item })),
    roles: scenario.roles.map((role) => ({ ...role })),
    cast: (scenario.npcs ?? []).map((npc) => ({ ...npc })),
    ...(scenario.meetingTitle === undefined ? {} : { meetingTitle: scenario.meetingTitle }),
    ...(hostName === undefined ? {} : { hostName }),
    ...(hostSeat === undefined ? {} : { hostSeat }),
    hostIsHuman: false,
    paused: false,
    version: 1,
    ...overrides,
  };
}
