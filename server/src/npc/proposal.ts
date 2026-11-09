import type { AgendaItem, AgendaTradeOff, Scenario } from '@kaki/shared';
import type { ChatMessage } from '../llm';

/** Marker in the assessment prompt, so tests and logs can recognise the bounded call. */
export const PROPOSAL_ASSESSMENT_MARKER = '[KAKI_PROPOSAL_ASSESSMENT]';

/** How long one readiness check may take before it is abandoned and the item stays open. Must stay under the shared LLM client's 20s timeout. */
export const DEFAULT_ASSESSMENT_TIMEOUT_MS = 4_500;

/** The most text the assessment will read; a longer reply is malformed and ignored. */
export const DEFAULT_ASSESSMENT_MAX_CHARS = 4_000;

/** A trade-off the visitor's words are taken to have resolved, with the words they used. */
export interface ResolvedTradeOff {
  tradeOff: string;
  evidence: string;
}

/** A trade-off still open after the visitor's line, and the question a colleague should ask next. */
export interface UnresolvedTradeOff {
  tradeOff: string;
  question: string;
}

/** The readiness check for one substantive visitor proposal. */
export interface ProposalAssessment {
  /** False when the model decides the line was a question, side request, greeting or filler. */
  isProposal: boolean;
  /** `complete` only when the visitor made a clear call and every listed trade-off is resolved. */
  readiness: 'open' | 'complete';
  resolved: ResolvedTradeOff[];
  unresolved: UnresolvedTradeOff[];
  /**
   * The visitor's own lines that still make up the final decision, oldest first, exactly as they said
   * them. A later line that replaces an earlier proposal leaves the earlier line out; one that only
   * adds a missing detail keeps both. Undefined when the reply did not name any lines, so callers can
   * fall back to the proposal history.
   */
  decisionLines?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const EVIDENCE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'or', 'so', 'that', 'this', 'it', 'we', 'will', 'our', 'is', 'are', 'be',
]);

/** True when `evidence` appears word-for-word (or shares its substantive words) in what the visitor said. */
export function evidenceMatchesVisitor(evidence: string, visitorText: string): boolean {
  const quote = normalize(evidence);
  if (quote.length === 0) return false;
  const spoken = normalize(visitorText);
  if (spoken.includes(quote)) return true;
  const quoteWords = quote.split(' ').filter((w) => w.length >= 3 && !EVIDENCE_STOP_WORDS.has(w));
  if (quoteWords.length < 2) return false;
  const spokenSet = new Set(spoken.split(' '));
  const matched = quoteWords.filter((w) => spokenSet.has(w)).length;
  return matched >= 2 && matched / quoteWords.length >= 0.65;
}

/** A proposal phrased as a question ("What if we move the cash box?"), not a question looking for facts. */
const PROPOSAL_QUESTION = /^(?:what if|why not|why don'?t we|how about|shall we|let'?s)\b/i;

const FEASIBILITY_QUESTION =
  /\b(?:can (?:you|we) do (?:that|this|it)|could (?:you|we) do (?:that|this|it)|is that (?:possible|doable|okay)|would that work|does that work|why (?:can't|cannot) (?:we|you)(?: just)?)\b[^.?!]*\?$/i;

export const GREETING_OR_FILLER =
  /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|yo|testing|test|wait|hold on|one sec|hang on|can you hear me|you guys hear me|is my mic working|idk|i don't know|not sure|hmm+|uh+|um+|ok|okay|sure|yes|no|yeah|yep|nope|right|fine|thanks|thank you|got it)\b[^.?!]*[.?!]*)+$/i;

const META_OR_NONSENSE =
  /\b(?:ignore all previous instructions|system prompt|output your|admit that you are|write your next line)\b/i;

const SIDE_TASK_REQUEST =
  /\b(?:can|could|would|will)\s+you\s+(?:[a-z]+\s+){0,3}(?:send|email|post|file|write|schedule|book|draft)\b/i;

const SIDE_TASK_MARKER = /\b(?:after|before)\s+(?:this(?:\s+(?:meeting|call|huddle))?(?![\s-]+[a-z])|the meeting|we finish|you go|the call)\b/i;

const FOLLOW_UP_VERBS =
  String.raw`send|email|post|file|write|schedule|book|share|confirm|update|put|make sure|arrange|bring|check|draft|print`;

/** One ordinary first-person commitment ("I'll post the handover in Mattermost."), matched as a whole sentence so a plan before or after it is not mistaken for the promise object. */
const ORDINARY_FIRST_PERSON_FOLLOW_UP = new RegExp(
  String.raw`\bi(?:'ll| will)\s+(?:${FOLLOW_UP_VERBS})\b[^.?!]*[.?!]?`,
  'i',
);

/** A speaker can name themselves between "I" and the promise ("I, Booth Playtest, will post..."). Keep the name short and comma-delimited so ordinary prose cannot bridge the two halves into a false follow-up. */
const SELF_IDENTIFICATION = String.raw`,\s*[\w'\u2019 -]{1,40}?,\s*`;

/**
 * A named first-person commitment ("I, Booth Playtest, will post the agreed plan...").
 * Used only to recognise a follow-up that is *purely* a communication promise, so a real decision
 * before or after it still reaches the readiness assessment. Matches one whole sentence, so the
 * promise object is not mistaken for trailing decision text.
 */
const NAMED_FIRST_PERSON_FOLLOW_UP = new RegExp(
  String.raw`\bi${SELF_IDENTIFICATION}will\s+(?:${FOLLOW_UP_VERBS})\b[^.?!]*[.?!]?`,
  'i',
);

/** The only harmless prefixes before a pure named promise: nothing, or the exact confirmation the live visitor used. */
const HARMLESS_NAMED_PROMISE_PREFIX = /^(?:confirmed,\s*that(?:'s| is) my decision\.?)?$/i;

/** A trailing request a speaker appends after naming their own follow-up ("Please assign that handover to me"). */
const TRAILING_TASK_REQUEST =
  /^(?:please\s+)?(?:assign|draft|send|email|post|file|write|print|schedule|book|share|forward|submit|upload|circulate|confirm)\b/i;

/**
 * True only when the line is an ordinary first-person communication promise with no other decision:
 * the whole line is the promise, or it is preceded by the bounded live confirmation and followed by
 * nothing worse than a side request. A prefix or suffix carrying a real plan is not matched here.
 */
function isPureOrdinaryCommunicationPromise(text: string): boolean {
  const match = ORDINARY_FIRST_PERSON_FOLLOW_UP.exec(text);
  if (match === null) return false;
  const prefix = text.slice(0, match.index).trim();
  const suffix = text.slice(match.index + match[0].length).trim();
  if (!HARMLESS_NAMED_PROMISE_PREFIX.test(prefix)) return false;
  return suffix.length === 0 || TRAILING_TASK_REQUEST.test(suffix) || GREETING_OR_FILLER.test(suffix);
}

/**
 * True only when the line is a communication promise by a self-named speaker with no other decision:
 * the whole line is the promise, or it is preceded by the bounded live confirmation and followed by
 * nothing worse than a side request. A prefix or suffix carrying a new decision is not matched here.
 */
function isPureNamedCommunicationPromise(text: string): boolean {
  const match = NAMED_FIRST_PERSON_FOLLOW_UP.exec(text);
  if (match === null) return false;
  const prefix = text.slice(0, match.index).trim();
  const suffix = text.slice(match.index + match[0].length).trim();
  if (!HARMLESS_NAMED_PROMISE_PREFIX.test(prefix)) return false;
  return suffix.length === 0 || TRAILING_TASK_REQUEST.test(suffix) || GREETING_OR_FILLER.test(suffix);
}

/**
 * An imperative follow-up request ("Please draft the handover", "Post the update", "Draft the note").
 * Deliberately anchored to the first word and limited to communication/deliverable verbs, so it never
 * swallows a decision that merely mentions a draft or a post as one part of the plan.
 */
const SIDE_TASK_IMPERATIVE =
  /^(?:please\s+)?(?:draft|send|email|post|file|write|forward|submit|upload|circulate)\b(?!.*\b(?:and|then)\s+(?:ban|block|stop|start|put|place|move|add|remove|switch|swap|make|set|use|keep|cut|limit|reserve|enforce|print|hold|pause|pull)\b)/i;

/**
 * A terse instruction that is clearly a course of action for the decision ("Ban laptops during
 * breakfast", "Put a cash drawer back at the toast counter"). Used only as a fallback when the model
 * wrongly calls such a line a non-proposal; it never marks the item complete.
 */
const CLEAR_ACTION_IMPERATIVE =
  /^(?:please\s+)?(?:ban|block|stop|start|put|place|move|add|remove|switch|swap|make|set|use|bring|open|close|cap|limit|reserve|keep|leave|cut|charge|price|give|introduce|launch|run|require|allow|hire|train|rotate|assign|redirect|replace|rename|label|double|halve|change|serve|offer|install|enforce|police|print|share|confirm|pause|pull|hold|sanitize)\b/i;

/**
 * True when a visitor's line is worth one readiness check: a concrete proposal for the item,
 * not a question, greeting, filler, status update, or a side request to send/file/post something.
 */
export function isSubstantiveProposal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (GREETING_OR_FILLER.test(trimmed)) return false;
  if (META_OR_NONSENSE.test(trimmed)) return false;
  if (
    SIDE_TASK_REQUEST.test(trimmed) ||
    SIDE_TASK_MARKER.test(trimmed) ||
    isPureOrdinaryCommunicationPromise(trimmed) ||
    isPureNamedCommunicationPromise(trimmed) ||
    SIDE_TASK_IMPERATIVE.test(trimmed)
  ) {
    return false;
  }
  if (trimmed.endsWith('?')) return PROPOSAL_QUESTION.test(trimmed);
  return !FEASIBILITY_QUESTION.test(trimmed);
}

/**
 * True when the line asks a colleague to prepare or send a follow-up deliverable ("Can you draft a
 * ticket…", "Please send the budget…"). A first-person promise ("I'll email…") is not a request.
 */
export function isSideRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return SIDE_TASK_REQUEST.test(trimmed) || SIDE_TASK_IMPERATIVE.test(trimmed);
}

/** True when the model called a clear action imperative a non-proposal; the item must stay open. */
function isClearActionImperative(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.endsWith('?') && CLEAR_ACTION_IMPERATIVE.test(trimmed);
}

function assessmentPrompt(item: AgendaItem, visitorLines: string[], assistantContext: string[] = []): string {
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  const listed =
    tradeOffs.length === 0
      ? 'There are no listed trade-offs for this item; mark it complete only when the visitor makes a clear, concrete call.'
      : tradeOffs.map((tradeOff, index) => tradeOffLine(tradeOff, index)).join('\n');
  const spoken = visitorLines.map((line, index) => `${index + 1}. "${line}"`).join('\n');
  const recentColleagues =
    assistantContext.length > 0
      ? [
          'Recent colleague lines just before the visitor spoke (context only — resolved "evidence" quotes must still come from the visitor\'s own lines):',
          ...assistantContext.map((line) => `- ${line}`),
        ]
      : [];
  return [
    PROPOSAL_ASSESSMENT_MARKER,
    'You check the visitor\'s cumulative proposal in a live meeting against one agenda decision. Reply with one JSON object only.',
    `Decision: ${item.decision ?? item.title}`,
    'Trade-offs (use the id on the left):',
    listed,
    ...recentColleagues,
    'What the visitor has said on this decision so far, oldest first (the number on the left is its line number):',
    spoken,
    'Rules:',
    '- A proposal is a concrete course of action for this decision. A question, greeting, filler, status update, or a side request to send/file/post something is not a proposal.',
    '- A terse instruction telling the room what to do is a proposal, not a question or side request: for example "Ban laptops during breakfast" or "Put a cash drawer back at the toast counter". Mark it a proposal, and keep readiness "open" until every listed trade-off is resolved; never mark it complete just because it states an action.',
    '- Judge the proposal as a whole across these lines, not only the latest one: an adjustment can complete an earlier partial proposal.',
    '- Mark readiness "complete" when the visitor\'s proposal makes a clear, practical call that addresses the listed trade-offs (including by adopting a practical workaround, phasing a change, accepting a trade-off, endorsing a colleague\'s suggested option, or offering a sensible Option C). Do not nitpick or keep readiness "open" if the visitor has already given a multi-part practical plan or explicitly agreed to a colleague\'s suggested option.',
    '- Resolved entries must quote one continuous, short phrase from the visitor in "evidence", copied exactly from one line above. Do not join fragments with ellipses or add words: for "I can run the desk, count the float and balance receipts", quote "count the float" rather than "run the desk ... balance receipts". Never invent an offer, number, permission or promise.',
    '- Unresolved entries name the trade-off id and the open question a colleague should ask next.',
    '- In "decisionLines", list the line numbers, oldest first, whose exact words still make up the final decision. When a later line replaces, reverses or withdraws an earlier proposal, leave the superseded line out. When a later line only adds a detail the earlier proposal was missing, keep both lines. Never quote or paraphrase the visitor yourself.',
    '- If the line is not a proposal, return "isProposal": false with empty arrays and "decisionLines": [].',
    'Shape: {"isProposal": true|false, "readiness": "open"|"complete", "decisionLines": [1, 2], "resolved": [{"tradeOffId": "T1", "evidence": string}], "unresolved": [{"tradeOffId": "T2", "question": string}]}',
  ].join('\n');
}

function tradeOffLine(tradeOff: AgendaTradeOff, index: number): string {
  return `T${index + 1} [${tradeOff.role}] ${tradeOff.tradeOff} (open question: ${tradeOff.question})`;
}

function jsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function readResolved(value: unknown, tradeOffs: AgendaTradeOff[], visitorText: string): ResolvedTradeOff[] {
  if (!Array.isArray(value)) return [];
  const out: ResolvedTradeOff[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = isNonEmptyString(entry.tradeOffId) ? entry.tradeOffId : undefined;
    const index = id === undefined ? -1 : Number(id.replace(/^T/i, '')) - 1;
    const known = index >= 0 ? tradeOffs[index] : undefined;
    const tradeOff = known?.tradeOff ?? (isNonEmptyString(entry.tradeOff) ? entry.tradeOff : undefined);
    const evidence = isNonEmptyString(entry.evidence) ? entry.evidence.trim() : undefined;
    if (tradeOff === undefined || evidence === undefined) continue;
    if (!evidenceMatchesVisitor(evidence, visitorText)) continue;
    if (out.some((resolved) => normalize(resolved.tradeOff) === normalize(tradeOff))) continue;
    out.push({ tradeOff, evidence });
  }
  return out;
}

function readUnresolved(value: unknown, tradeOffs: AgendaTradeOff[]): UnresolvedTradeOff[] {
  if (!Array.isArray(value)) return [];
  const out: UnresolvedTradeOff[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = isNonEmptyString(entry.tradeOffId) ? entry.tradeOffId : undefined;
    const index = id === undefined ? -1 : Number(id.replace(/^T/i, '')) - 1;
    const known = index >= 0 ? tradeOffs[index] : undefined;
    const tradeOff = known?.tradeOff ?? (isNonEmptyString(entry.tradeOff) ? entry.tradeOff : undefined);
    const question =
      isNonEmptyString(entry.question) ? entry.question.trim() : known?.question;
    if (tradeOff === undefined || question === undefined) continue;
    if (out.some((unresolved) => normalize(unresolved.tradeOff) === normalize(tradeOff))) continue;
    out.push({ tradeOff, question });
  }
  return out;
}

/**
 * Reads the line numbers whose exact words still make up the final decision. References outside the
 * lines the visitor actually said are dropped; if the reply named only unusable numbers the caller
 * falls back to the proposal history rather than inventing a decision. An explicit empty list means
 * the model named no line, which callers treat as the latest line only.
 */
function readDecisionLines(value: unknown, visitorLines: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) continue;
    const line = visitorLines[entry - 1];
    if (line === undefined || out.includes(line)) continue;
    out.push(line);
  }
  if (out.length === 0 && value.length > 0) return undefined;
  return out;
}

function allUnresolved(tradeOffs: AgendaTradeOff[]): UnresolvedTradeOff[] {
  return tradeOffs.map((tradeOff) => ({ tradeOff: tradeOff.tradeOff, question: tradeOff.question }));
}

function dedupeUnresolved(entries: UnresolvedTradeOff[]): UnresolvedTradeOff[] {
  const out: UnresolvedTradeOff[] = [];
  for (const entry of entries) {
    if (out.some((unresolved) => normalize(unresolved.tradeOff) === normalize(entry.tradeOff))) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Keeps trade-offs already resolved earlier on this item, as long as their quoted words are still in the
 * visitor's cumulative proposal text. Later assessments may therefore omit an earlier settlement without
 * dropping it; nothing from a previous agenda item survives, because callers reset the list on a move.
 */
function mergeResolved(
  previous: ResolvedTradeOff[] | undefined,
  current: ResolvedTradeOff[],
  tradeOffs: AgendaTradeOff[],
  visitorWords: string,
): ResolvedTradeOff[] {
  const out = [...current];
  for (const entry of previous ?? []) {
    if (!tradeOffs.some((tradeOff) => normalize(tradeOff.tradeOff) === normalize(entry.tradeOff))) continue;
    if (!evidenceMatchesVisitor(entry.evidence, visitorWords)) continue;
    if (out.some((resolved) => normalize(resolved.tradeOff) === normalize(entry.tradeOff))) continue;
    out.push(entry);
  }
  return out;
}

/**
 * One bounded model call that decides whether a substantive visitor proposal is ready to settle.
 * Returns `undefined` on a failed, empty, malformed or timed-out reply; callers keep the item open.
 */
export async function assessProposal(options: {
  scenario: Scenario;
  item: AgendaItem;
  /** The latest substantive visitor proposal line. */
  visitorText: string;
  /** Earlier substantive proposal lines for the same agenda item, oldest first. */
  visitorContext?: string[];
  /** Recent colleague utterances before the visitor spoke, so endorsing a colleague's option is understood. */
  assistantContext?: string[];
  /** Trade-offs already resolved earlier on this item, so a later proposal builds on them. */
  resolvedSoFar?: ResolvedTradeOff[];
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxChars?: number;
  log?(message: string): void;
}): Promise<ProposalAssessment | undefined> {
  const { scenario, item, visitorText, stream, signal, log } = options;
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  if (signal?.aborted === true) return undefined;
  const visitorLines = [...(options.visitorContext ?? []), visitorText];
  const visitorWords = visitorLines.join('\n');

  const controller = new AbortController();
  let abortCause: 'timeout' | 'caller' | undefined;
  const abort = (cause: 'timeout' | 'caller'): void => {
    if (abortCause === undefined) abortCause = cause;
    controller.abort();
  };
  const cancel = (): void => abort('caller');
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => abort('timeout'), options.timeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS);
  timeout.unref?.();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        `The meeting is at ${scenario.organisation}: "${scenario.meetingTitle}".`,
        assessmentPrompt(item, visitorLines, options.assistantContext),
      ].join('\n'),
    },
    { role: 'user', content: `Visitor's latest line: "${visitorText}"` },
  ];

  let raw = '';
  try {
    for await (const chunk of stream(messages, controller.signal)) {
      if (controller.signal.aborted) break;
      raw += chunk;
      if (raw.length >= (options.maxChars ?? DEFAULT_ASSESSMENT_MAX_CHARS)) break;
    }
  } catch (error) {
    if (abortCause === 'timeout') {
      log?.('proposal assessment timed out; keeping the item open');
    } else if (abortCause === 'caller') {
      log?.('proposal assessment cancelled by the caller; keeping the item open');
    } else {
      log?.(`proposal assessment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }

  if (controller.signal.aborted) {
    if (abortCause === 'timeout') {
      log?.('proposal assessment timed out; keeping the item open');
    } else if (abortCause === 'caller') {
      log?.('proposal assessment cancelled by the caller; keeping the item open');
    }
    return undefined;
  }

  const parsed = jsonObject(raw);
  if (!isObject(parsed)) {
    log?.('proposal assessment reply was not a JSON object; keeping the item open');
    return undefined;
  }
  const isProposal = parsed.isProposal;
  if (typeof isProposal !== 'boolean') {
    log?.('proposal assessment reply did not say whether this was a proposal; keeping the item open');
    return undefined;
  }
  if (!isProposal) {
    if (!isClearActionImperative(visitorText)) {
      return { isProposal: false, readiness: 'open', resolved: [], unresolved: [] };
    }
    log?.('proposal assessment called a clear action imperative a non-proposal; keeping the item open');
    const resolved = mergeResolved(options.resolvedSoFar, [], tradeOffs, visitorWords);
    const missing = tradeOffs.filter(
      (tradeOff) => !resolved.some((entry) => normalize(entry.tradeOff) === normalize(tradeOff.tradeOff)),
    );
    return { isProposal: true, readiness: 'open', resolved, unresolved: allUnresolved(missing) };
  }
  const readiness = parsed.readiness;
  if (readiness !== 'open' && readiness !== 'complete') {
    log?.('proposal assessment reply had no usable readiness; keeping the item open');
    return undefined;
  }
  const decisionLines = readDecisionLines(parsed.decisionLines, visitorLines);
  const activeLines = decisionLines === undefined ? visitorLines : decisionLines.length > 0 ? decisionLines : [visitorText];
  const activeWords = activeLines.join('\n');

  const resolved = mergeResolved(
    options.resolvedSoFar,
    readResolved(parsed.resolved, tradeOffs, activeWords),
    tradeOffs,
    activeWords,
  );
  const unresolved = readUnresolved(parsed.unresolved, tradeOffs).filter(
    (entry) => !resolved.some((settled) => normalize(settled.tradeOff) === normalize(entry.tradeOff)),
  );
  const missing = tradeOffs.filter(
    (tradeOff) => !resolved.some((entry) => normalize(entry.tradeOff) === normalize(tradeOff.tradeOff)),
  );
  const enoughFollowUpConsensus =
    tradeOffs.length >= 3 &&
    resolved.length >= 2 &&
    unresolved.length <= 1;
  if (enoughFollowUpConsensus) {
    return {
      isProposal: true,
      readiness: 'complete',
      resolved,
      unresolved: [],
      ...(decisionLines !== undefined ? { decisionLines } : {}),
    };
  }
  if (readiness === 'complete' && (missing.length > 0 || unresolved.length > 0)) {
    return {
      isProposal: true,
      readiness: 'open',
      resolved,
      unresolved: dedupeUnresolved([
        ...unresolved,
        ...missing.map((tradeOff) => ({ tradeOff: tradeOff.tradeOff, question: tradeOff.question })),
      ]),
      ...(decisionLines !== undefined ? { decisionLines } : {}),
    };
  }
  if (readiness === 'complete') {
    return {
      isProposal: true,
      readiness: 'complete',
      resolved,
      unresolved: [],
      ...(decisionLines !== undefined ? { decisionLines } : {}),
    };
  }
  return {
    isProposal: true,
    readiness: 'open',
    resolved,
    unresolved: unresolved.length > 0 ? unresolved : allUnresolved(missing),
    ...(decisionLines !== undefined ? { decisionLines } : {}),
  };
}
