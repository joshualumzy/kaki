/** Why a piece of recognised speech was refused. */
export type GateRejection = 'echo' | 'no-voice';

/**
 * `text` is present when the recognised words mixed the AI's voice with the person's: it is only
 * the person's part, and `removed` is the echo that was cut out.
 */
export type GateDecision = { ok: true; text?: string; removed?: string } | { ok: false; reason: GateRejection };

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

/** Most of the text is the AI's voice when at least this share of its words are covered by what the AI said. */
const ECHO_SHARE = 0.6;
/** A run of the person's own words inside echo must be this long, or this long at the very start or end. */
const MIN_RUN_INSIDE = 3;
const MIN_RUN_AT_EDGE = 2;

type EchoAnalysis =
  | { kind: 'none' }
  | { kind: 'echo' }
  | { kind: 'mixed'; text: string; removed: string };

/**
 * Decides whether text from the browser's speech recognition is the person talking, or the AI's
 * own voice coming back through the microphone. Two independent checks, each cheap to explain:
 *
 * - Echo: while the AI's voice could be in the microphone (it is talking or just stopped), a stretch of four
 *   or more words whose word triples mostly appear in what the AI said a moment ago. If the person's own
 *   words are mixed into it, only those are kept. Short replies like "ok" are never treated as echo: they
 *   cannot be told apart from the AI's words by text alone. The person's echo-cancelled microphone carrying
 *   speech outranks the text match: someone repeating the AI's wording aloud is speaking, not echo, and
 *   once the AI has been quiet past the tail there is no echo left to match.
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
    const aiRecently = this.aiAudible || at - this.aiLastAudible < this.aiTailMs;
    const voiceBehindIt = this.humanTalking || this.humanLastTalking >= this.aiSince;
    // Echo matching only means something while the AI's voice could actually be in the microphone: while it
    // talks or within the recognition tail. A person repeating the AI's wording later, or over it with their
    // own voice live, is speaking, not echo.
    const echo = aiRecently ? this.analyseEcho(text, at) : ({ kind: 'none' } as EchoAnalysis);
    if (echo.kind === 'echo' && !voiceBehindIt) return { ok: false, reason: 'echo' };
    if (aiRecently && !voiceBehindIt) return { ok: false, reason: 'no-voice' };
    return echo.kind === 'mixed' ? { ok: true, text: echo.text, removed: echo.removed } : { ok: true };
  }

  /**
   * Compare recognised text with what the AI said a moment ago. Mostly the AI's words: echo, unless
   * a clear run of other words sits inside it, which is the person talking over their own echo.
   */
  private analyseEcho(text: string, at: number): EchoAnalysis {
    const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
    const owners: number[] = [];
    const heard: string[] = [];
    tokens.forEach((token, index) => {
      for (const word of words(token)) {
        heard.push(word);
        owners.push(index);
      }
    });
    if (heard.length < 4) return { kind: 'none' };

    const recent = ` ${this.spoken
      .filter((entry) => at - entry.at < this.memoryMs)
      .map((entry) => words(entry.text).join(' '))
      .join(' ')} `;
    const covered = new Array<boolean>(heard.length).fill(false);
    for (let start = 0; start + 2 < heard.length; start += 1) {
      if (recent.includes(` ${heard.slice(start, start + 3).join(' ')} `)) {
        covered[start] = covered[start + 1] = covered[start + 2] = true;
      }
    }
    const share = covered.filter(Boolean).length / heard.length;
    if (share < ECHO_SHARE) return { kind: 'none' };

    // A token is the AI's if all of its words are covered; find the longest run of tokens that are not.
    const isEcho = tokens.map((_, index) => owners.every((owner, word) => owner !== index || covered[word]));
    let best: { from: number; to: number } | undefined;
    for (let index = 0; index < tokens.length; ) {
      if (isEcho[index]) {
        index += 1;
        continue;
      }
      const from = index;
      while (index < tokens.length && !isEcho[index]) index += 1;
      if (best === undefined || index - from > best.to - best.from) best = { from, to: index };
    }
    if (best === undefined) return { kind: 'echo' };

    const length = best.to - best.from;
    const atEdge = best.from === 0 || best.to === tokens.length;
    if (length < (atEdge ? MIN_RUN_AT_EDGE : MIN_RUN_INSIDE)) return { kind: 'echo' };
    return {
      kind: 'mixed',
      text: tokens.slice(best.from, best.to).join(' '),
      removed: [...tokens.slice(0, best.from), ...tokens.slice(best.to)].join(' '),
    };
  }
}
