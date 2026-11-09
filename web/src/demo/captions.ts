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

/**
 * Split a long spoken sentence into bite-sized caption bursts (~11 words max) on natural phrase boundaries
 * so the video tile never renders a dense wall of text.
 */
export function splitCaptionBursts(text: string, maxWords = 11): string[] {
  const cleaned = text.trim();
  if (cleaned.length === 0) return [];
  const words = cleaned.split(/\s+/);
  if (words.length <= maxWords) return [cleaned];

  // First split on natural clause boundaries (commas, semicolons, em-dashes, colons, sentence endings)
  const rawClauses = cleaned
    .split(/(?<=[,;:.!?—–])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const bursts: string[] = [];
  let current: string[] = [];

  for (const clause of rawClauses) {
    const clauseWords = clause.split(/\s+/);
    if (current.length > 0 && current.length + clauseWords.length <= maxWords) {
      current.push(...clauseWords);
    } else {
      if (current.length > 0) {
        bursts.push(current.join(' '));
        current = [];
      }
      if (clauseWords.length <= maxWords) {
        current.push(...clauseWords);
      } else {
        for (let i = 0; i < clauseWords.length; i += maxWords) {
          bursts.push(clauseWords.slice(i, i + maxWords).join(' '));
        }
      }
    }
  }
  if (current.length > 0) bursts.push(current.join(' '));
  return bursts;
}

/**
 * The caption to show under a speaker's tile: their latest spoken sentence, matching the exact
 * sentence currently playing in TTS audio. Stays visible while they are still speaking, and
 * fades `windowMs` after their line started once they finish.
 */
export function captionFor(
  chunks: readonly TranscriptChunk[],
  speaker: string,
  now: number,
  windowMs = 8000,
  stillSpeaking = false,
  aliases: readonly string[] = [],
): string | null {
  const candidates = new Set(
    [speaker, ...aliases]
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  const matchesSpeaker = (rawSpeaker: string): boolean => {
    const lower = rawSpeaker.trim().toLowerCase();
    if (candidates.has(lower)) return true;
    const base = lower.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return base.length > 0 && candidates.has(base);
  };
  const mine = chunks.filter((chunk) => matchesSpeaker(chunk.payload.speaker));
  const latest = mine.at(-1);
  if (latest === undefined) return null;

  const latestAt = Date.parse(latest.payload.timestamp);
  if (!Number.isFinite(latestAt) || (!stillSpeaking && now - latestAt > windowMs)) return null;

  const caption = latest.payload.text.trim();
  return caption.length > 0 ? caption : null;
}

/** Who the visitor is in the room: the name they typed, and the attendee seat Kaki's transcript files them under. */
export interface TranscriptViewer {
  name: string;
  seatName: string | undefined;
}

/** How a speaker is shown in the transcript panel: the visitor sees their own name and role, and AI colleagues show their name and role. */
export function speakerLabel(speaker: string, viewer: TranscriptViewer | undefined, scenario?: Scenario): string {
  const cleanSpeaker = speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const isViewer =
    viewer !== undefined &&
    (cleanSpeaker.toLowerCase() === viewer.name.trim().toLowerCase() ||
      (viewer.seatName !== undefined && cleanSpeaker.toLowerCase() === viewer.seatName.trim().toLowerCase()));
  const baseName = isViewer ? `${viewer.name} (you)` : cleanSpeaker;
  if (scenario === undefined) return baseName;
  const wanted = cleanSpeaker.toLowerCase();
  const attendee = scenario.attendees.find(
    (candidate) =>
      candidate.name.trim().toLowerCase() === wanted ||
      candidate.zoomDisplayName.trim().toLowerCase() === wanted ||
      (isViewer && viewer.seatName !== undefined && candidate.name.trim().toLowerCase() === viewer.seatName.trim().toLowerCase()),
  );
  const roleObj = attendee === undefined ? undefined : scenario.roles.find((role) => role.id === attendee.role);
  return roleObj === undefined ? baseName : `${baseName} · ${roleObj.label}`;
}
