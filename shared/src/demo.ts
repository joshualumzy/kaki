import type { Attendee, NpcProfile, Scenario, ScenarioRole } from './scenario';

/** LiveKit data topic on which the browser sends the words its speech recognition heard. */
export const STT_TOPIC = 'kaki.stt';

/** LiveKit data topic on which the AI attendees say what they are doing (thinking, speaking, ...). */
export const NPC_STATE_TOPIC = 'kaki.npc-state';

/** LiveKit data topic on which the browser sends what the person types, and "typing" and "stop" signals. */
export const CONTROL_TOPIC = 'kaki.control';

/** Longest typed message the AI attendees accept. */
export const MAX_TYPED_LENGTH = 500;

/** What the browser sends on {@link CONTROL_TOPIC}. */
export type ControlMessage =
  | { kind: 'text'; text: string }
  /** Keys are being pressed: a short sound in the microphone is probably the keyboard, not speech. */
  | { kind: 'typing' }
  /** The person wants the AI attendees to stop talking now. */
  | { kind: 'stop' };

/** A control message from the wire, or `undefined` when it is not a valid one. */
export function parseControlMessage(raw: unknown): ControlMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as { kind?: unknown; text?: unknown };
  if (message.kind === 'typing' || message.kind === 'stop') return { kind: message.kind };
  if (message.kind === 'text' && typeof message.text === 'string') {
    const text = message.text.trim().slice(0, MAX_TYPED_LENGTH);
    return text.length > 0 ? { kind: 'text', text } : undefined;
  }
  return undefined;
}

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

/**
 * The role a person can take to run the meeting: the facilitator role, when its attendee's character is `playable`.
 * Taking it sends the AI host out of the cast, so the person hosts and the AI attendees follow their lead.
 */
export function hostRole(scenario: Scenario): ScenarioRole | undefined {
  return scenario.roles.find(
    (role) =>
      role.facilitator === true &&
      scenario.attendees.some((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee)) &&
      (scenario.npcs ?? []).some((npc) => scenario.attendees.some((a) => a.name === npc.attendee && a.role === role.id)),
  );
}

/** How many people may be in the demo meeting at once (the rest of the cast stays AI). */
export const DEFAULT_MAX_HUMANS = 3;

/**
 * Why a person cannot take a seat right now, or `undefined` if they can. `present` are the people already in the room.
 * Two rules: a seat holds one person, and at least one character must stay AI so the room always has an AI voice.
 */
export function seatProblem(
  scenario: Scenario,
  present: ReadonlyArray<{ role?: string }>,
  wantedRole: string | undefined,
  maxHumans: number = DEFAULT_MAX_HUMANS,
): string | undefined {
  const castSize = (scenario.npcs ?? []).length;
  const cap = Math.max(1, Math.min(maxHumans, castSize > 0 ? castSize - 1 : maxHumans));
  if (present.length >= cap) {
    return `The meeting is full (${cap} ${cap === 1 ? 'person' : 'people'} at most). Try again when someone leaves.`;
  }
  const seat = wantedRole === undefined ? undefined : humanAttendeeForRole(scenario, wantedRole);
  if (seat !== undefined && present.some((person) => person.role !== undefined && humanAttendeeForRole(scenario, person.role)?.name === seat.name)) {
    return `${seat.name}'s seat is taken. Pick another role.`;
  }
  return undefined;
}
