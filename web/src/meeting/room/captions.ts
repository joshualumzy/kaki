import type { Role } from '@kaki/shared';
import { humanAttendeeForRole, speakerName, type KakiEvent, type Scenario } from '@kaki/shared';

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
    return scenario.attendees.find((attendee) => attendee.name === ai.attendee)?.displayName ?? ai.attendee;
  }
  const attendee = humanAttendeeForRole(scenario, participant.metadata ?? '');
  return attendee?.displayName ?? participant.identity;
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
const CUT_MARK = '…';

/** Shows a partly heard line as the words that were heard followed by an ellipsis. */
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
    const base = speakerName(lower);
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
  /** The exact seat they hold, so a shared display name never makes another person's line "(you)". */
  seat?: string;
}

/**
 * How a speaker is shown in the transcript panel. When the line's seat is known, its name comes from
 * the People list's disambiguated names (so two people called Sam read "Sam" and "Sam (2)"), and only
 * the viewer's own seat says "(you)". Lines without a seat (AI speech and older feeds) keep the name
 * match, and practice keeps its role and AI attendee labels.
 */
export function speakerLabel(
  speaker: string,
  viewer: TranscriptViewer | undefined,
  scenario?: Scenario,
  seat?: string,
  seatNames?: ReadonlyMap<string, string>,
): string {
  const cleanSpeaker = speakerName(speaker);
  const lineSeat = seat?.trim().toLowerCase();
  const seatName = lineSeat === undefined || lineSeat === '' ? undefined : seatNames?.get(lineSeat);
  const viewerSeat = viewer?.seat?.trim().toLowerCase();
  const bySeat = lineSeat !== undefined && lineSeat !== '' && viewerSeat !== undefined && viewerSeat !== '';
  const isViewer = bySeat
    ? lineSeat === viewerSeat
    : viewer !== undefined &&
      (cleanSpeaker.toLowerCase() === viewer.name.trim().toLowerCase() ||
        (viewer.seatName !== undefined && cleanSpeaker.toLowerCase() === viewer.seatName.trim().toLowerCase()));
  const baseName = isViewer ? `${seatName ?? viewer?.name ?? cleanSpeaker} (you)` : (seatName ?? cleanSpeaker);
  if (scenario === undefined) return baseName;
  // A line's seat names its attendee exactly, so a renamed display name still finds its role.
  const wanted = cleanSpeaker.toLowerCase();
  const attendee =
    (lineSeat === undefined || lineSeat === ''
      ? undefined
      : scenario.attendees.find((candidate) => candidate.role.trim().toLowerCase() === lineSeat)) ??
    scenario.attendees.find(
      (candidate) =>
        candidate.name.trim().toLowerCase() === wanted ||
        candidate.displayName.trim().toLowerCase() === wanted ||
        (isViewer &&
          viewer?.seatName !== undefined &&
          candidate.name.trim().toLowerCase() === viewer.seatName.trim().toLowerCase()),
    );
  const roleObj = attendee === undefined ? undefined : scenario.roles.find((role) => role.id === attendee.role);
  // A plain seat's label is the person's own name, so showing both would read "Name · Name".
  if (roleObj === undefined || roleObj.label.trim().toLowerCase() === cleanSpeaker.toLowerCase()) {
    return baseName;
  }
  return `${baseName} · ${roleObj.label}`;
}
