/** Behaviour switches and browser-free checks for the AI-guest live playtest personas. */

export const BEHAVIOURS = ['silent', 'interrupter', 'flip-flop', 'rejoin'] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** Personas that also change how the robot behaves, not only how it words a line. */
const PERSONA_BEHAVIOURS: Readonly<Record<string, Behaviour | undefined>> = {
  silent: 'silent',
  interrupter: 'interrupter',
  'flip-flop': 'flip-flop',
  rejoin: 'rejoin',
};

export function behaviourForPersona(persona: string): Behaviour | undefined {
  return PERSONA_BEHAVIOURS[persona];
}

/** The transcript shape the pure checks need; `Line` in the driver is compatible. */
export type TranscriptLine = { at: string; agendaIndex: number; speaker: string; text: string };

const VISITOR_SPEAKER = /robot visitor/i;

function isVisitorLine(line: TranscriptLine): boolean {
  return VISITOR_SPEAKER.test(line.speaker);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
  'actually', 'about', 'after', 'again', 'also', 'because', 'been', 'before', 'could', 'from',
  'have', 'into', 'just', 'make', 'more', 'only', 'rather', 'really', 'scrap', 'should', 'still',
  'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'want', 'what',
  'when', 'where', 'which', 'while', 'with', 'would', 'your',
]);

/** Words long enough to identify an option, with filler words such as "actually, scrap that" removed. */
export function significantWords(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9$%.]+/g, ' ')
      .split(/\s+/)
      .map((word) => word.replace(/^[^a-z0-9$]+|[^a-z0-9%]+$/g, ''))
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  )];
}

/** True when a spoken line names the visitor, by full name or by one of its distinctive words. */
export function isVisitorAddress(text: string, visitorName: string): boolean {
  const name = normalize(visitorName);
  if (name === '') return false;
  const lower = text.toLowerCase();
  if (lower.includes(name)) return true;
  return name
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .some((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

export type SilencePrompt = { prompted: boolean; waitedMs: number; text?: string };

/**
 * Find the first host line after `fromIndex` that addresses the visitor by name within `windowMs`
 * of `quietAtMs`. `hostName` narrows the search to the facilitator when supplied.
 */
export function silencePromptWithin(
  lines: readonly TranscriptLine[],
  fromIndex: number,
  visitorName: string,
  quietAtMs: number,
  windowMs = 60_000,
  hostName?: string,
): SilencePrompt {
  const host = hostName === undefined ? '' : hostName.toLowerCase();
  for (let index = Math.max(0, fromIndex); index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isVisitorLine(line)) continue;
    if (host !== '' && !line.speaker.toLowerCase().includes(host)) continue;
    if (!isVisitorAddress(line.text, visitorName)) continue;
    const at = Date.parse(line.at);
    if (Number.isNaN(at)) continue;
    const waitedMs = at - quietAtMs;
    if (waitedMs >= 0 && waitedMs <= windowMs) return { prompted: true, waitedMs, text: line.text };
  }
  return { prompted: false, waitedMs: windowMs };
}

/** AI lines (never the robot's) repeated word for word at or after `fromIndex`. */
export function duplicatedAiLines(lines: readonly TranscriptLine[], fromIndex = 0): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (let index = Math.max(0, fromIndex); index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isVisitorLine(line)) continue;
    const key = normalize(line.text);
    if (key === '') continue;
    if (seen.has(key)) duplicates.add(line.text.trim());
    else seen.add(key);
  }
  return [...duplicates];
}

/**
 * The follow-up card follows the visitor's final call when its context or decisionSource contains
 * a word introduced by the final line that the first line did not use.
 */
export function cardFollowsFinalCall(
  card: { context?: string; decisionSource?: string },
  firstLine: string,
  finalLine: string,
): boolean {
  const finalWords = significantWords(finalLine);
  if (finalWords.length === 0) return false;
  const firstWords = new Set(significantWords(firstLine));
  const changedWords = finalWords.filter((word) => !firstWords.has(word));
  const required = changedWords.length > 0 ? changedWords : finalWords;
  const haystack = normalize(`${card.decisionSource ?? ''} ${card.context ?? ''}`);
  return required.some((word) => haystack.includes(word));
}

/** Add the persona's reversal phrase when the model omitted it, so the change of mind is readable. */
export function reversalLine(line: string): string {
  const trimmed = line.trim();
  if (/^actually,?\s+scrap that\b/i.test(trimmed)) return trimmed;
  const rest = trimmed.replace(/^(?:actually,?\s+)?(?:scrap that\s*[—,-]?\s*)/i, '');
  return `Actually, scrap that — ${rest}`;
}

const OPENING_LINE_RE = /\b(?:welcome(?!\s+back\b)|let'?s get started|let'?s begin|thanks for (?:joining|coming)|good morning,? everyone|kick (?:us|things) off)\b/i;

/**
 * A fresh opening or welcome line from the host after the given transcript index. When the
 * original opening line is supplied, an exact repeat of it also counts.
 */
export function rejoinWelcome(
  lines: readonly TranscriptLine[],
  fromIndex: number,
  hostName: string,
  previousOpening?: string,
): TranscriptLine | undefined {
  const prior = previousOpening === undefined ? '' : normalize(previousOpening);
  const host = hostName.toLowerCase();
  return lines.slice(Math.max(0, fromIndex)).find((line) => {
    if (isVisitorLine(line)) return false;
    if (host !== '' && !line.speaker.toLowerCase().includes(host)) return false;
    if (OPENING_LINE_RE.test(line.text)) return true;
    if (prior === '') return false;
    const text = normalize(line.text);
    return text === prior ||
      (text.length >= 20 && prior.includes(text)) ||
      (prior.length >= 20 && text.includes(prior));
  });
}

export type RejoinSnapshot = {
  agendaBefore: number;
  agendaAfter: number;
  closingAfter: boolean;
  hostWelcomeAfter: boolean;
  earlierTaskIds: readonly string[];
  currentTaskIds: readonly string[];
  secondsToRejoin?: number;
  maxAgendaAdvance?: number;
  maxSeconds?: number;
};

export type RejoinVerdict = { ok: boolean; reasons: string[] };

/** The rejoin resumed the meeting rather than restarting it, with its cards intact. */
export function rejoinResumes(snapshot: RejoinSnapshot): RejoinVerdict {
  const reasons: string[] = [];
  const maxAdvance = snapshot.maxAgendaAdvance ?? 1;
  const advance = snapshot.agendaAfter - snapshot.agendaBefore;
  if (advance < 0 || advance > maxAdvance) {
    reasons.push(`agenda restarted or jumped: topic ${snapshot.agendaBefore + 1} → ${snapshot.agendaAfter + 1}`);
  }
  if (snapshot.closingAfter) reasons.push('the meeting reached wrap-up after rejoin');
  if (snapshot.hostWelcomeAfter) reasons.push('the host gave a second opening/welcome line after rejoin');
  const missing = snapshot.earlierTaskIds.filter((id) => !snapshot.currentTaskIds.includes(id));
  if (missing.length > 0) reasons.push(`earlier task card(s) missing after rejoin: ${missing.join(', ')}`);
  const maxSeconds = snapshot.maxSeconds ?? 20;
  if (snapshot.secondsToRejoin !== undefined && snapshot.secondsToRejoin > maxSeconds) {
    reasons.push(`rejoin took ${snapshot.secondsToRejoin.toFixed(1)} s (limit ${maxSeconds} s)`);
  }
  return { ok: reasons.length === 0, reasons };
}
