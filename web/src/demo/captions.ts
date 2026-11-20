import type { Role } from '@kaki/shared';
import { humanAttendeeForRole, type KakiEvent, type Scenario } from '@kaki/shared';

/** One line of the meeting transcript, after any display-only cut or restore update has been applied. */
export interface TranscriptChunk {
  speaker: string;
  text: string;
  timestamp: string;
  textOnly?: boolean;
  speakerRole?: Role;
  lineId?: string;
  /** True when the room only heard part of the line before it was interrupted. */
  cut?: boolean;
  /** When the speech began and ended (ISO), and whether it overlapped the previous line. */
  speechStartedAt?: string;
  speechEndedAt?: string;
  overlap?: boolean;
}

/**
 * The most recent transcript lines; older ones are never shown, so there is no point keeping them.
 * A `TRANSCRIPT_LINE_UPDATED` replaces the line it names, so a cut or restored line is never listed twice.
 */
export function transcriptChunks(events: readonly KakiEvent[], limit = 40): TranscriptChunk[] {
  const lines: TranscriptChunk[] = [];
  const indexByLineId = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'TRANSCRIPT_CHUNK') {
      const { speaker, text, timestamp, textOnly, speakerRole, lineId, speechStartedAt, speechEndedAt, overlap } = event.payload;
      if (lineId !== undefined) indexByLineId.set(lineId, lines.length);
      lines.push({
        speaker,
        text,
        timestamp,
        ...(textOnly === true ? { textOnly: true } : {}),
        ...(speakerRole === undefined ? {} : { speakerRole }),
        ...(lineId === undefined ? {} : { lineId }),
        ...(speechStartedAt === undefined ? {} : { speechStartedAt }),
        ...(speechEndedAt === undefined ? {} : { speechEndedAt }),
        ...(overlap === true ? { overlap: true } : {}),
      });
    } else if (event.type === 'TRANSCRIPT_LINE_UPDATED') {
      const index = indexByLineId.get(event.payload.lineId);
      if (index === undefined) continue;
      const line = lines[index]!;
      lines[index] = {
        ...line,
        speaker: event.payload.speaker,
        text: event.payload.text,
        timestamp: event.payload.timestamp,
        cut: event.payload.cut,
      };
    }
  }
  return lines.slice(-limit);
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

/** The calm note shown while the latest line is text-only, so the visitor knows why there is no voice. */
export const TEXT_ONLY_NOTE = 'Voice unavailable — showing text';

/**
 * The note to show near the captions: visible only while the latest transcript line is text-only,
 * and it clears as soon as a line with audio arrives or `windowMs` passes without another one.
 */
export function textOnlyNote(
  chunks: readonly TranscriptChunk[],
  now: number,
  windowMs = 10_000,
): string | null {
  const latest = chunks.at(-1);
  if (latest === undefined || latest.textOnly !== true) return null;
  const latestAt = Date.parse(latest.timestamp);
  if (!Number.isFinite(latestAt) || now - latestAt > windowMs) return null;
  return TEXT_ONLY_NOTE;
}

/**
 * How a line the room only partly heard is shown: the heard words followed by an ellipsis. An empty
 * heard part still shows the ellipsis, so a line cut off before its first word never looks finished.
 */
export const CUT_MARK = '…';

export function cutLineText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? CUT_MARK : `${trimmed} ${CUT_MARK}`;
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
  role?: string,
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
  // A server-written human line knows its seat, so a renamed display name still matches its tile.
  // Lines without a role (AI speech and old events) keep the name match.
  const wantedRole = role?.trim().toLowerCase();
  const mine = chunks.filter((chunk) =>
    chunk.speakerRole !== undefined
      ? wantedRole !== undefined && chunk.speakerRole.trim().toLowerCase() === wantedRole
      : matchesSpeaker(chunk.speaker),
  );
  const latest = mine.at(-1);
  if (latest === undefined) return null;

  const latestAt = Date.parse(latest.timestamp);
  if (!Number.isFinite(latestAt) || (!stillSpeaking && now - latestAt > windowMs)) return null;

  const caption = latest.text.trim();
  if (latest.cut === true) return cutLineText(caption);
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
