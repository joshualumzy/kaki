import type { MeetingStateParticipant } from '@kaki/shared';

/**
 * The name to show for each person, keyed by seat. Two people who joined with the same name stay
 * two seats; the later one is shown as "Name (2)", "Name (3)" so they can be told apart.
 */
export function distinctDisplayNames(people: readonly MeetingStateParticipant[]): Map<string, string> {
  const seen = new Map<string, number>();
  const shown = new Map<string, string>();
  for (const person of people) {
    const base = (person.displayName || person.name).trim();
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    shown.set(person.seat, count === 1 ? base : `${base} (${count})`);
  }
  return shown;
}

/** The server participants a LiveKit room does not have yet (matched by seat, else by identity). */
export function peopleNotInRoom(
  people: readonly MeetingStateParticipant[],
  inRoom: readonly { identity: string; metadata?: string | undefined }[],
): MeetingStateParticipant[] {
  const seats = new Set(inRoom.map((p) => p.metadata?.trim().toLowerCase()).filter((s): s is string => !!s));
  const identities = new Set(inRoom.map((p) => p.identity.trim().toLowerCase()));
  return people.filter(
    (person) => !seats.has(person.seat.trim().toLowerCase()) && !identities.has(person.name.trim().toLowerCase()),
  );
}
