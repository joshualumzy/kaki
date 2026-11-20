/** Behaviour switches and browser-free checks for the AI-guest live playtest personas. */
import { parseJsonReply, type ChatMessage, type LlmClient } from '../server/src/llm';

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

type SilencePrompt = { prompted: boolean; waitedMs: number; text?: string };

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

type CardFollowVerdict = { follows: boolean; reason: string };
type CardFollowModel = Pick<LlmClient, 'complete'>;

/** The messages for judging whether a follow-up card carries the final call and not the replaced one. */
export function cardFollowPrompt(
  card: { context?: string; decisionSource?: string },
  firstLine: string,
  finalLine: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Judge one follow-up card from a live meeting against the guest\'s two spoken calls.',
        'The guest first called the topic one way, then said "actually, scrap that" and made a different final call.',
        'The card must reflect the whole final decision, and it must not contain the superseded call or part of it.',
        'A card that keeps both calls, or keeps the old call, fails. A short paraphrase of the final call passes.',
        'Return only JSON: {"follows":true|false,"reason":"<one short sentence>"}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `First (superseded) call: ${firstLine}`,
        `Final call: ${finalLine}`,
        `Card decision source: ${card.decisionSource ?? '(empty)'}`,
        `Card context: ${card.context ?? '(empty)'}`,
      ].join('\n'),
    },
  ];
}

/** Parse the judge's one-line verdict; anything unusable throws so the caller can fail loudly. */
export function parseCardFollowVerdict(text: string): CardFollowVerdict {
  let value: unknown;
  try {
    value = parseJsonReply(text);
  } catch {
    throw new Error('the card judge reply was not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the card judge reply was not a JSON object');
  }
  const data = value as Record<string, unknown>;
  if (typeof data.follows !== 'boolean') throw new Error('the card judge reply had no usable verdict');
  if (typeof data.reason !== 'string' || data.reason.trim() === '' || /[\r\n]/.test(data.reason)) {
    throw new Error('the card judge reply had no usable reason');
  }
  return { follows: data.follows, reason: data.reason.trim() };
}

/** A model judges the card as a whole; word matching cannot tell a paraphrase from a leftover old call. */
export async function judgeCardFollowsFinalCall(
  card: { context?: string; decisionSource?: string },
  firstLine: string,
  finalLine: string,
  model: CardFollowModel,
): Promise<CardFollowVerdict> {
  if (finalLine.trim() === '') throw new Error('the final call is empty, so there is nothing for the card to follow');
  const raw = await model.complete(cardFollowPrompt(card, firstLine, finalLine), {
    json: true, temperature: 0, maxTokens: 200, reasoningEffort: 'none',
  });
  return parseCardFollowVerdict(raw);
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

type RejoinSnapshot = {
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

type RejoinVerdict = { ok: boolean; reasons: string[] };

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
