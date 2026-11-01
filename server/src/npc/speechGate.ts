/** Why a piece of recognised speech was refused. */
export type GateRejection = 'echo' | 'no-voice';

export type GateDecision = { ok: true } | { ok: false; reason: GateRejection };

export interface SpeechGateOptions {
  now?: () => number;
  /** After the AI stops, text still needs a live voice behind it for this long (recognition lags). */
  aiTailMs?: number;
  /** AI sentences older than this are forgotten for echo matching. */
  memoryMs?: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function trigrams(list: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index + 2 < list.length; index += 1) out.push(list.slice(index, index + 3).join(' '));
  return out;
}

/**
 * Decides whether text from the browser's speech recognition is the person talking, or the AI's
 * own voice coming back through the microphone. Two independent checks, each cheap to explain:
 *
 * - Echo: a stretch of four or more words whose word triples mostly appear in what the AI said
 *   a moment ago. Short replies like "ok" are never treated as echo: they cannot be told apart
 *   from the AI's words by text alone.
 * - Voice: while the AI is talking, and just after, text is only accepted if the person's own
 *   (echo-cancelled) microphone track carried speech since the AI began its current stretch of
 *   talking. Plain echo leaves that track quiet; the person's previous sentence does not count.
 */
export class SpeechGate {
  private readonly now: () => number;
  private readonly aiTailMs: number;
  private readonly memoryMs: number;
  private aiAudible = false;
  private aiLastAudible = Number.NEGATIVE_INFINITY;
  /** When the AI's current stretch of talking began; a stretch ends when the person speaks or a pause outlasts the tail. */
  private aiSince = Number.NEGATIVE_INFINITY;
  private humanTalking = false;
  private humanLastTalking = Number.NEGATIVE_INFINITY;
  private spoken: Array<{ at: number; text: string }> = [];

  constructor(options: SpeechGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.aiTailMs = options.aiTailMs ?? 2500;
    this.memoryMs = options.memoryMs ?? 20000;
  }

  /** The AI started or stopped making sound. */
  setAiAudible(active: boolean): void {
    const at = this.now();
    if (active && !this.aiAudible) {
      const personSpokeSince = this.humanLastTalking > this.aiLastAudible;
      if (personSpokeSince || at - this.aiLastAudible > this.aiTailMs) this.aiSince = at;
    }
    this.aiAudible = active;
    this.aiLastAudible = at;
  }

  /** The person's microphone started or stopped carrying speech. */
  setHumanTalking(active: boolean): void {
    this.humanTalking = active;
    this.humanLastTalking = this.now();
  }

  /** Remember a sentence the AI is saying, for echo matching. */
  aiSaid(text: string): void {
    const at = this.now();
    this.spoken = this.spoken.filter((entry) => at - entry.at < this.memoryMs).slice(-5);
    this.spoken.push({ at, text });
  }

  check(text: string): GateDecision {
    const at = this.now();
    if (this.looksLikeEcho(text, at)) return { ok: false, reason: 'echo' };

    const aiRecently = this.aiAudible || at - this.aiLastAudible < this.aiTailMs;
    const voiceBehindIt = this.humanTalking || this.humanLastTalking >= this.aiSince;
    if (aiRecently && !voiceBehindIt) return { ok: false, reason: 'no-voice' };
    return { ok: true };
  }

  private looksLikeEcho(text: string, at: number): boolean {
    const heard = words(text);
    if (heard.length < 4) return false;
    const recent = ` ${this.spoken
      .filter((entry) => at - entry.at < this.memoryMs)
      .map((entry) => words(entry.text).join(' '))
      .join(' ')} `;
    const grams = trigrams(heard);
    const matched = grams.filter((gram) => recent.includes(` ${gram} `)).length;
    return matched / grams.length >= 0.6;
  }
}
