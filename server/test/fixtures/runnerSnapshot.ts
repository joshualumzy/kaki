import {
  castWithHostProfile,
  hostIdentityOf,
  type RunnerEpoch,
  type RunnerMeetingSnapshot,
  type RunnerSnapshotVersion,
  type Scenario,
} from '@kaki/shared';

/** The epoch every test snapshot uses unless it names another server incarnation. */
export const TEST_EPOCH: RunnerEpoch = { startedAt: 1_000, id: 'test-epoch' };

/** Let a test keep passing a plain number for `version`; it becomes a seq in the test epoch. */
type SnapshotOverrides = Omit<Partial<RunnerMeetingSnapshot>, 'version'> & {
  version?: number | RunnerSnapshotVersion;
};

function versionOf(version: number | RunnerSnapshotVersion | undefined): RunnerSnapshotVersion {
  if (version === undefined) return { epoch: TEST_EPOCH, seq: 1 };
  if (typeof version === 'number') return { epoch: TEST_EPOCH, seq: version };
  return version;
}

/** A complete runner snapshot from a scenario, so tests never hand-build the wire shape. */
export function runnerSnapshot(
  scenario: Scenario,
  overrides: SnapshotOverrides = {},
): RunnerMeetingSnapshot {
  const host = hostIdentityOf(scenario);
  const hostSeat = host.seat;
  const hostName = host.name;
  const { version, ...fields } = overrides;
  return {
    meetingId: 'meeting-1',
    phase: 'lobby',
    started: false,
    agendaIndex: 0,
    agenda: scenario.agenda.map((item) => ({ ...item })),
    roles: scenario.roles.map((role) => ({ ...role })),
    cast: castWithHostProfile(scenario.npcs ?? [], hostName),
    kind: 'real',
    organisation: scenario.organisation,
    attendeeNames: scenario.attendees.map((attendee) => attendee.name),
    ...(scenario.meetingTitle === undefined ? {} : { meetingTitle: scenario.meetingTitle }),
    ...(hostName === undefined ? {} : { hostName }),
    ...(hostSeat === undefined ? {} : { hostSeat }),
    hostIsHuman: false,
    paused: false,
    ...fields,
    version: versionOf(version),
  };
}
