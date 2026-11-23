/**
 * Cross-seat bleed: one person's voice is picked up by another person's microphone, so the
 * recogniser forwards the same words under a second seat. A second seat is only a copy when the
 * audio proves it: the two recognitions cover overlapping speech time, and the second microphone
 * heard the voice clearly more quietly than the seat that actually spoke. Words alone are never
 * enough, because two people in a group meeting really do both say "Yes" or "Okay".
 */

/**
 * How much quieter the second microphone must be before its copy is treated as bleed. An RMS ratio
 * of 0.3 is about 10 dB, the usual drop for a voice heard across a room. Two people who really both
 * said the words differ far less than that even on different devices, so their lines are kept:
 * a duplicate left in is harmless, a real line dropped is not.
 */
export const CROSS_SEAT_BLEED_LEVEL_RATIO = 0.3;

/** How long a spoken line stays available for a copy of it to arrive; longer than any recognised stretch. */
export const CROSS_SEAT_BLEED_RETENTION_MS = 60_000;

export interface SpeechLine {
  /** The seat that produced the line (never the display name, which two people may share). */
  seat: string;
  /** How the line is shown in the transcript, for the log only. */
  speaker: string;
  text: string;
  /** When this seat's recogniser heard the speech begin, in milliseconds since the epoch. */
  speechStartedAt?: number;
  /** When this seat's recogniser heard the speech end, in milliseconds since the epoch. */
  speechEndedAt?: number;
  /** RMS microphone level (0..1) over exactly the audio recognised for this line. */
  micLevel?: number;
}

/** Case and whitespace do not make it a different line; the words themselves must match exactly. */
function comparable(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface EvidencedLine extends SpeechLine {
  speechStartedAt: number;
  speechEndedAt: number;
  micLevel: number;
}

/** A line can only prove bleed if its mic carried speech for a real span and its level was measured. */
function evidenced(line: SpeechLine): line is EvidencedLine {
  return (
    line.speechStartedAt !== undefined &&
    line.speechEndedAt !== undefined &&
    line.micLevel !== undefined &&
    Number.isFinite(line.speechStartedAt) &&
    Number.isFinite(line.speechEndedAt) &&
    Number.isFinite(line.micLevel) &&
    line.speechEndedAt > line.speechStartedAt &&
    line.micLevel > 0
  );
}

function spansOverlap(left: EvidencedLine, right: EvidencedLine): boolean {
  return Math.min(left.speechEndedAt, right.speechEndedAt) > Math.max(left.speechStartedAt, right.speechStartedAt);
}

/**
 * The earlier loud line that this quieter, overlapping line copies, if the audio proves it. The
 * caller keeps the loud line and drops the copy; without overlapping speech time and a clearly
 * lower microphone level this returns undefined, so two people saying the same words both stay.
 */
export function findCrossSeatDuplicate(
  candidate: SpeechLine,
  recent: readonly SpeechLine[],
): SpeechLine | undefined {
  const text = comparable(candidate.text);
  if (text === '' || !evidenced(candidate)) return undefined;
  let original: EvidencedLine | undefined;
  for (const entry of recent) {
    if (entry.seat === candidate.seat || comparable(entry.text) !== text || !evidenced(entry)) continue;
    if (!spansOverlap(entry, candidate)) continue;
    if (candidate.micLevel > entry.micLevel * CROSS_SEAT_BLEED_LEVEL_RATIO) continue;
    // Several microphones can hear the same voice; the loudest one is the seat that actually spoke.
    if (original === undefined || entry.micLevel > original.micLevel) original = entry;
  }
  return original;
}

/** Keep an accepted speech line for the next check, and forget lines too old to be echoed. */
export function rememberSpeechLine(
  recent: SpeechLine[],
  line: SpeechLine,
  retentionMs = CROSS_SEAT_BLEED_RETENTION_MS,
): void {
  if (!evidenced(line)) return;
  recent.push(line);
  const cutoff = line.speechEndedAt - retentionMs;
  while (recent.length > 0) {
    const oldest = recent[0]!;
    const endedAt = oldest.speechEndedAt ?? oldest.speechStartedAt ?? Number.NEGATIVE_INFINITY;
    if (endedAt >= cutoff) break;
    recent.shift();
  }
}
