import { humanAttendeeForRole, type KakiEvent, type Scenario } from '@kaki/shared';

/** One line of the meeting transcript. */
export type TranscriptChunk = Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }>;

/** The most recent transcript lines; older ones are never shown, so there is no point keeping them. */
export function transcriptChunks(events: readonly KakiEvent[], limit = 40): TranscriptChunk[] {
  const chunks = events.filter((event): event is TranscriptChunk => event.type === 'TRANSCRIPT_CHUNK');
  return chunks.slice(-limit);
}

/**
 * The name Kaki's transcript uses for the person on a tile. AI attendees and the scenario's
 * attendees use their display name; a visitor is called by the attendee their chosen role maps to.
 */
export function transcriptNameFor(
  scenario: Scenario,
  participant: { identity: string; metadata?: string },
): string {
  const ai = (scenario.npcs ?? []).find((npc) => npc.attendee === participant.identity);
  if (ai !== undefined) {
    return scenario.attendees.find((attendee) => attendee.name === ai.attendee)?.zoomDisplayName ?? ai.attendee;
  }
  const attendee = humanAttendeeForRole(scenario, participant.metadata ?? '');
  return attendee?.zoomDisplayName ?? participant.identity;
}

/** Lines closer together than this belong to one caption. */
const SAME_BREATH_MS = 6000;
const MAX_LINES = 3;

/**
 * The caption to show under a speaker's tile: their latest line, and the one or two lines just
 * before it if they were part of the same stretch of talking. Nothing once it is `windowMs` old.
 */
export function captionFor(
  chunks: readonly TranscriptChunk[],
  speaker: string,
  now: number,
  windowMs = 8000,
): string | null {
  const wanted = speaker.trim().toLowerCase();
  const mine = chunks.filter((chunk) => chunk.payload.speaker.trim().toLowerCase() === wanted);
  const latest = mine.at(-1);
  if (latest === undefined) return null;

  const latestAt = Date.parse(latest.payload.timestamp);
  if (!Number.isFinite(latestAt) || now - latestAt > windowMs) return null;

  const lines: string[] = [];
  for (let index = mine.length - 1; index >= 0 && lines.length < MAX_LINES; index -= 1) {
    const chunk = mine[index];
    if (chunk === undefined || latestAt - Date.parse(chunk.payload.timestamp) > SAME_BREATH_MS) break;
    lines.unshift(chunk.payload.text.trim());
  }
  const caption = lines.filter((line) => line.length > 0).join(' ');
  return caption.length > 0 ? caption : null;
}
