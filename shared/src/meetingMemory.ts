/** Facts established during one meeting, separate from the scenario's source data. */
export type MeetingMemoryEntry =
  | { kind: 'decision'; item: string; text: string }
  | { kind: 'invented'; item: string; text: string }
  | { kind: 'saidAloud'; item: string; text: string };

export const MEETING_MEMORY_LIMIT = 40;

export function isMeetingMemoryEntries(value: unknown, agendaTitles: readonly string[]): value is MeetingMemoryEntry[] {
  return Array.isArray(value) && value.length <= MEETING_MEMORY_LIMIT && value.every((entry) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
    (entry.kind === 'decision' || entry.kind === 'invented' || entry.kind === 'saidAloud') &&
    typeof entry.item === 'string' && agendaTitles.includes(entry.item) &&
    typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.text.length <= 10_000,
  );
}
