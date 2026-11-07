import type { AgendaItem, AgendaTradeOff, Scenario } from '@kaki/shared';
import type { ChatMessage } from '../llm';

/** Marker in the assessment prompt, so tests and logs can recognise the bounded call. */
export const PROPOSAL_ASSESSMENT_MARKER = '[KAKI_PROPOSAL_ASSESSMENT]';

/** How long one readiness check may take before it is abandoned and the item stays open. */
export const DEFAULT_ASSESSMENT_TIMEOUT_MS = 6_000;

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
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `evidence` appears word-for-word (after punctuation and spacing are normalised) in what the visitor said. */
export function evidenceMatchesVisitor(evidence: string, visitorText: string): boolean {
  const quote = normalize(evidence);
  return quote.length > 0 && normalize(visitorText).includes(quote);
}

/** A proposal phrased as a question ("What if we move the cash box?"), not a question looking for facts. */
const PROPOSAL_QUESTION = /^(?:what if|why not|why don'?t we|how about|shall we|let'?s)\b/i;

const FEASIBILITY_QUESTION =
  /\b(?:can (?:you|we) do (?:that|this|it)|could (?:you|we) do (?:that|this|it)|is that (?:possible|doable|okay)|would that work|does that work|why (?:can't|cannot) (?:we|you)(?: just)?)\b[^.?!]*\?$/i;

const GREETING_OR_FILLER =
  /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|yo|testing|test|wait|hold on|one sec|hang on|can you hear me|you guys hear me|is my mic working|idk|i don't know|not sure|hmm+|uh+|um+|ok|okay|sure|yes|no|yeah|yep|nope|right|fine|thanks|thank you|got it)\b[^.?!]*[.?!]*)+$/i;

const META_OR_NONSENSE =
  /\b(?:ignore all previous instructions|system prompt|output your|admit that you are|write your next line)\b/i;

const SIDE_TASK_REQUEST =
  /\b(?:can|could|would|will)\s+you\s+(?:[a-z]+\s+){0,3}(?:send|email|post|file|write|schedule|book|share|confirm|update|put|make sure|arrange|bring|check|draft|print)\b/i;

const SIDE_TASK_MARKER = /\b(?:after|before)\s+(?:this|the meeting|we finish|you go|the call)\b/i;

const FIRST_PERSON_FOLLOW_UP =
  /\bi(?:'ll| will)\s+(?:send|email|post|file|write|schedule|book|share|confirm|update|put|make sure|arrange|bring|check|draft|print)\b/i;

/**
 * True when a visitor's line is worth one readiness check: a concrete proposal for the item,
 * not a question, greeting, filler, status update, or a side request to send/file/post something.
 */
export function isSubstantiveProposal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (GREETING_OR_FILLER.test(trimmed)) return false;
  if (META_OR_NONSENSE.test(trimmed)) return false;
  if (SIDE_TASK_REQUEST.test(trimmed) || SIDE_TASK_MARKER.test(trimmed) || FIRST_PERSON_FOLLOW_UP.test(trimmed)) {
    return false;
  }
  if (trimmed.endsWith('?')) return PROPOSAL_QUESTION.test(trimmed);
  return !FEASIBILITY_QUESTION.test(trimmed);
}

function assessmentPrompt(item: AgendaItem): string {
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  const listed =
    tradeOffs.length === 0
      ? 'There are no listed trade-offs for this item; mark it complete only when the visitor makes a clear, concrete call.'
      : tradeOffs.map((tradeOff, index) => tradeOffLine(tradeOff, index)).join('\n');
  return [
    PROPOSAL_ASSESSMENT_MARKER,
    'You check one visitor line in a live meeting against one agenda decision. Reply with one JSON object only.',
    `Decision: ${item.decision ?? item.title}`,
    'Trade-offs (use the id on the left):',
    listed,
    'Rules:',
    '- A proposal is a concrete course of action for this decision. A question, greeting, filler, status update, or a side request to send/file/post something is not a proposal.',
    '- Mark readiness "complete" only when the visitor\'s own words make a clear call and resolve EVERY listed trade-off (or explicitly accept its residual risk).',
    '- Resolved entries must quote the visitor\'s exact words in "evidence". Never invent an offer, number, permission or promise.',
    '- Unresolved entries name the trade-off id and the open question a colleague should ask next.',
    '- If the line is not a proposal, return "isProposal": false with empty arrays.',
    'Shape: {"isProposal": true|false, "readiness": "open"|"complete", "resolved": [{"tradeOffId": "T1", "evidence": string}], "unresolved": [{"tradeOffId": "T2", "question": string}]}',
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

function allUnresolved(tradeOffs: AgendaTradeOff[]): UnresolvedTradeOff[] {
  return tradeOffs.map((tradeOff) => ({ tradeOff: tradeOff.tradeOff, question: tradeOff.question }));
}

/**
 * One bounded model call that decides whether a substantive visitor proposal is ready to settle.
 * Returns `undefined` on a failed, empty, malformed or timed-out reply; callers keep the item open.
 */
export async function assessProposal(options: {
  scenario: Scenario;
  item: AgendaItem;
  visitorText: string;
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxChars?: number;
  log?(message: string): void;
}): Promise<ProposalAssessment | undefined> {
  const { scenario, item, visitorText, stream, signal, log } = options;
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  if (signal?.aborted === true) return undefined;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS);
  timeout.unref?.();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [`The meeting is at ${scenario.organisation}: "${scenario.meetingTitle}".`, assessmentPrompt(item)].join('\n'),
    },
    { role: 'user', content: `Visitor said: "${visitorText}"` },
  ];

  let raw = '';
  try {
    for await (const chunk of stream(messages, controller.signal)) {
      if (controller.signal.aborted) break;
      raw += chunk;
      if (raw.length >= (options.maxChars ?? DEFAULT_ASSESSMENT_MAX_CHARS)) break;
    }
  } catch (error) {
    if (!controller.signal.aborted || !isAborted(signal)) {
      log?.(`proposal assessment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }

  if (controller.signal.aborted) {
    if (!isAborted(signal)) log?.('proposal assessment timed out; keeping the item open');
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
    return { isProposal: false, readiness: 'open', resolved: [], unresolved: [] };
  }
  const readiness = parsed.readiness;
  if (readiness !== 'open' && readiness !== 'complete') {
    log?.('proposal assessment reply had no usable readiness; keeping the item open');
    return undefined;
  }

  const resolved = readResolved(parsed.resolved, tradeOffs, visitorText);
  const unresolved = readUnresolved(parsed.unresolved, tradeOffs);
  const missing = tradeOffs.filter(
    (tradeOff) => !resolved.some((entry) => normalize(entry.tradeOff) === normalize(tradeOff.tradeOff)),
  );
  if (readiness === 'complete' && (missing.length > 0 || unresolved.length > 0)) {
    return {
      isProposal: true,
      readiness: 'open',
      resolved,
      unresolved: [...unresolved, ...missing.map((tradeOff) => ({ tradeOff: tradeOff.tradeOff, question: tradeOff.question }))],
    };
  }
  if (readiness === 'complete') {
    return { isProposal: true, readiness: 'complete', resolved, unresolved: [] };
  }
  return {
    isProposal: true,
    readiness: 'open',
    resolved,
    unresolved: unresolved.length > 0 ? unresolved : allUnresolved(tradeOffs.filter((tradeOff) => !resolved.some((entry) => normalize(entry.tradeOff) === normalize(tradeOff.tradeOff)))),
  };
}
