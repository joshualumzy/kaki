import type { Attendee, NpcProfile, Scenario, ScenarioRole } from './scenario';

/** LiveKit data topic on which the browser sends the words its speech recognition heard. */
export const STT_TOPIC = 'kaki.stt';

/** LiveKit data topic on which the AI attendees say what they are doing (thinking, speaking, ...). */
export const NPC_STATE_TOPIC = 'kaki.npc-state';

/** What the browser sends on {@link STT_TOPIC}: one finished piece of recognised speech. */
export interface SttMessage {
  text: string;
}

/** What the AI attendees are doing, sent on {@link NPC_STATE_TOPIC}. */
export type NpcStateMessage =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'speaking'; speaker: string }
  | { kind: 'error'; message: string };

/** The LiveKit room the live demo meeting of a scenario happens in. */
export function demoRoomName(scenario: Scenario): string {
  return `kaki-demo-${scenario.id}`;
}

/** True when an AI always plays this attendee: it has a profile and a person cannot take its seat. */
function isPlayedByAi(scenario: Scenario, attendee: Attendee): boolean {
  return (scenario.npcs ?? []).some((npc) => npc.attendee === attendee.name && npc.playable !== true);
}

/**
 * The AI attendees of a session: every profile except the seat the person took. With no seat
 * (nobody has joined yet) it is the characters that are always AI.
 */
export function aiCast(scenario: Scenario, humanSeat?: string): NpcProfile[] {
  return (scenario.npcs ?? []).filter((npc) =>
    humanSeat === undefined ? npc.playable !== true : npc.attendee !== humanSeat,
  );
}

/** The roles a person can take in the demo meeting: those whose attendee is not played by an AI. */
export function humanRoles(scenario: Scenario): ScenarioRole[] {
  return scenario.roles.filter((role) => role.facilitator !== true &&
    scenario.attendees.some((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee)),
  );
}

/** The attendee a person plays when they pick a role (by id or label): the first one no AI plays. */
export function humanAttendeeForRole(scenario: Scenario, roleIdOrLabel: string): Attendee | undefined {
  const wanted = roleIdOrLabel.trim().toLowerCase();
  const role = scenario.roles.find(
    (candidate) => candidate.id.toLowerCase() === wanted || candidate.label.toLowerCase() === wanted,
  );
  if (role === undefined) return undefined;
  return scenario.attendees.find((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee));
}
