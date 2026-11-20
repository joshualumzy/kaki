import type { RunnerMeetingSnapshot, Scenario } from '@kaki/shared';

/** Azure accepts long phrase lists, but a bounded one stays quick and unsurprising. */
export const MAX_STT_PHRASES = 500;

/** A trailing " (Role)" a room may show beside a person's name; it is not part of who they are. */
const ROLE_SUFFIX = /\s*\([^)]*\)\s*$/;

/** Trim each phrase, drop blanks, and keep the first spelling of each word or name. */
export function tidySttPhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>();
  const tidy: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (phrase === '') continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tidy.push(phrase);
  }
  return tidy;
}

function personName(displayName: string): string {
  return displayName.replace(ROLE_SUFFIX, '').trim();
}

export interface SttPhraseInput {
  /** The process's boot pack, used only while the runner has not heard an active meeting. */
  startupPack: Scenario;
  /** The server's snapshot of the meeting the runner follows now. */
  meeting?: RunnerMeetingSnapshot;
  /** The display names of the people in the room now, with any role suffix still attached. */
  joinedNames?: readonly string[];
}

/**
 * The words Azure should lean towards for the meeting that is running now.
 *
 * The boot pack is only the fallback: once a meeting is active, its own people and company are
 * what the recogniser hears, and the pack's vocabulary and AI cast stay out of a team meeting.
 */
export function buildSttPhrases({ startupPack, meeting, joinedNames = [] }: SttPhraseInput): string[] {
  const people = joinedNames.map(personName);
  if (meeting?.kind === undefined) {
    return tidySttPhrases([
      ...(startupPack.vocabulary ?? []),
      ...startupPack.attendees.map((attendee) => attendee.name),
      startupPack.organisation,
      ...people,
    ]);
  }

  const practice = meeting.kind === 'practice';
  return tidySttPhrases([
    ...(practice ? startupPack.vocabulary ?? [] : []),
    ...(meeting.attendeeNames ?? []),
    ...(practice ? meeting.cast.map((npc) => npc.attendee) : []),
    ...(meeting.organisation === undefined ? [] : [meeting.organisation]),
    ...people,
  ]);
}
