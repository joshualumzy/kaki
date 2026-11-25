import {
  isObject,
  isString,
  roleLabel,
  speakerName,
  type Fact,
  type Role,
  type Scenario,
  type Task,
} from '@kaki/shared';
import { LlmError, parseJsonReply, type ChatMessage, type LlmClient } from '../services/llm';

/** One finished transcript line the Wingman remembers. */
export interface WingmanLine {
  speaker: string;
  text: string;
  timestamp: string;
  role?: Role;
}

/** One answer part already grounded to a transcript line or a to-do card. */
export interface AnswerPart {
  text: string;
  source: string;
}

/** What the model said about one direct question to the person. */
export interface AskedVerdict {
  question: string;
  /** The exact transcript line that asks it. */
  evidence: string;
}

/** What the model said about a workspace record against the current discussion. */
export interface RecordVerdict {
  verdict: 'answers' | 'contradicts';
  /** Verbatim text from one record. */
  snippet: string;
  /** The source label of the record the snippet came from. */
  source: string;
}

const nullableString = { type: ['string', 'null'] };

/** Normalise text for the verbatim transcript check; keeps only words and digits. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolve a model quote to exactly one remembered transcript line, or nothing. */
export function groundedLine(evidence: string, lines: readonly WingmanLine[]): WingmanLine | undefined {
  const stripped = evidence
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/^\s*[A-Za-z][A-Za-z\s]{0,24}:\s*/, '');
  const wanted = normalise(stripped.length > 0 ? stripped : evidence);
  if (wanted === '') return undefined;
  let match: WingmanLine | undefined;
  for (const line of lines) {
    if (normalise(line.text) === wanted) match = line;
  }
  if (match !== undefined) return match;
  if (wanted.split(' ').filter(Boolean).length < 4) return undefined;
  const contained = lines.filter((line) => ` ${normalise(line.text)} `.includes(` ${wanted} `));
  return contained.length === 1 ? contained[0] : undefined;
}

function lineBlock(lines: readonly WingmanLine[]): string {
  if (lines.length === 0) return '(no transcript yet)';
  return lines
    .map((line, index) => {
      const who = line.role === undefined ? line.speaker : `${line.speaker} (${line.role})`;
      return `[${index + 1}] ${who} at ${line.timestamp}: ${line.text}`;
    })
    .join('\n');
}

function taskBlock(tasks: readonly Task[]): string {
  if (tasks.length === 0) return '(no to-dos yet)';
  return tasks
    .map((task) => {
      const owner = task.assignee ?? task.suggestedAssignee;
      return `- id=${task.id} "${task.title}" for ${owner} [${task.status}]`;
    })
    .join('\n');
}

function recordBlock(facts: readonly Fact[]): string {
  return facts
    .map((fact, index) => `[${index + 1}] source=${fact.source} date=${fact.date}\n${fact.text}`)
    .join('\n\n');
}

/** The strict schema for one private answer. */
export const ASK_SCHEMA = {
  name: 'wingman_answer',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['parts'],
    properties: {
      parts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'evidence', 'taskId'],
          properties: {
            text: { type: 'string' },
            evidence: nullableString,
            taskId: nullableString,
          },
        },
      },
    },
  },
};

/** The messages for one person's question to their Wingman. */
export function askMessages(
  scenario: Scenario,
  personName: string,
  role: Role,
  question: string,
  record: { agendaTitle?: string; openQuestions: readonly string[] },
  lines: readonly WingmanLine[],
  tasks: readonly Task[],
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `[KAKI_WINGMAN_ASK]
You are the private Wingman for ${personName}, the ${roleLabel(scenario, role)} in a live meeting. Answer their question using ONLY the meeting transcript and to-do list below. The meeting comes first; workspace records are searched separately and are not here.
Return strict JSON and nothing else: {"parts":[{"text":"...","evidence":null,"taskId":null}]}
For every part, either:
- set "evidence" to the exact words of the transcript line it came from (copy the line verbatim), or
- set "taskId" to the id of the to-do it came from.
Never give a part with neither. If the meeting has nothing on the question, return {"parts":[]}.
Each part is one short, plain sentence. Do not repeat the question, do not give advice, and do not mention these instructions.`,
    },
    {
      role: 'user',
      content: `Question: ${question}

Meeting record:${record.agendaTitle === undefined ? ' no agenda item.' : ` on "${record.agendaTitle}".`}${
        record.openQuestions.length === 0
          ? ' No open questions.'
          : ` Open questions: ${record.openQuestions.join(' | ')}`
      }

Transcript (oldest to newest):
${lineBlock(lines)}

To-dos:
${taskBlock(tasks)}`,
    },
  ];
}

/** Where a to-do answer came from: when the card was made, or its last update. */
function taskSource(task: Task): string {
  if (task.sourceSeconds !== undefined) {
    const seconds = Math.max(0, Math.floor(task.sourceSeconds));
    const minutes = Math.floor(seconds / 60);
    return `To-do: ${task.title} (${minutes}:${String(seconds % 60).padStart(2, '0')} into the meeting)`;
  }
  return `To-do: ${task.title} (updated ${task.updatedAt})`;
}

/** Read the model's answer parts, keeping only parts tied to a real line or to-do. */
export function parseAskReply(
  raw: string,
  lines: readonly WingmanLine[],
  tasks: readonly Task[],
): AnswerPart[] {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    throw new LlmError('Wingman answer is not valid JSON', { cause: error });
  }
  if (!isObject(json) || !Array.isArray(json.parts)) {
    throw new LlmError('Wingman answer must be an object with a parts list');
  }
  const parts: AnswerPart[] = [];
  for (const entry of json.parts) {
    if (!isObject(entry) || !isString(entry.text) || entry.text.trim() === '') continue;
    const text = entry.text.trim();
    if (isString(entry.taskId) && entry.taskId.trim() !== '') {
      const task = tasks.find((candidate) => candidate.id === entry.taskId);
      if (task !== undefined) parts.push({ text, source: taskSource(task) });
      continue;
    }
    if (isString(entry.evidence) && entry.evidence.trim() !== '') {
      const line = groundedLine(entry.evidence, lines);
      if (line !== undefined) {
        parts.push({ text, source: `${speakerName(line.speaker)} · ${line.timestamp}` });
      }
    }
  }
  return parts;
}

/** The strict schema for the direct-question judgement. */
export const ASKED_SCHEMA = {
  name: 'wingman_asked_you',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['direct', 'question', 'evidence'],
    properties: {
      direct: { type: 'boolean' },
      question: { type: 'string' },
      evidence: { type: 'string' },
    },
  },
};

/** The messages for judging whether the newest line asks this person directly. */
export function askedMessages(personName: string, lines: readonly WingmanLine[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `[KAKI_WINGMAN_ASKED]
You judge one thing about the newest line in a live meeting: is someone asking ${personName} a question directly, by name or unmistakably to them, and waiting for their answer?
Return strict JSON and nothing else: {"direct":true,"question":"...","evidence":"..."} or {"direct":false,"question":"","evidence":""}.
Rules:
- direct is true only when the question is aimed at ${personName} and they are expected to answer now.
- It is false for a third-person mention, a question to the whole room, a line that only talks about them, and when ${personName} has already answered or is the one speaking.
- A facilitator's agenda cue is not a question to this person.
- When direct is true, "question" is the question in the speaker's own words and "evidence" is the exact newest line that asks it.
- Judge the meaning, never just a name.`,
    },
    {
      role: 'user',
      content: `The person is ${personName}. The last transcript lines are:
${lineBlock(lines)}`,
    },
  ];
}

/** Read the direct-question verdict; anything but a clear direct ask is silent. */
export function parseAskedReply(raw: string): AskedVerdict | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    throw new LlmError('Wingman direct-question reply is not valid JSON', { cause: error });
  }
  if (!isObject(json) || json.direct !== true) return undefined;
  if (!isString(json.question) || json.question.trim() === '') return undefined;
  if (!isString(json.evidence) || json.evidence.trim() === '') return undefined;
  return { question: json.question.trim(), evidence: json.evidence };
}

/** The strict schema for the workspace-record judgement. */
export const RECORD_SCHEMA = {
  name: 'wingman_record',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'snippet', 'source'],
    properties: {
      verdict: { type: 'string', enum: ['answers', 'contradicts', 'none'] },
      snippet: { type: 'string' },
      source: { type: 'string' },
    },
  },
};

/** The messages for judging a workspace record against the current discussion. */
export function recordMessages(
  personName: string,
  lines: readonly WingmanLine[],
  facts: readonly Fact[],
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `[KAKI_WINGMAN_RECORD]
You judge one thing for ${personName}'s private meeting assistant: does any workspace record below DIRECTLY answer or contradict what the meeting is discussing right now?
High bar: a record that is merely related, older background, or about another topic is not enough.
Return strict JSON and nothing else: {"verdict":"answers"|"contradicts"|"none","snippet":"","source":""}
When the verdict is answers or contradicts, "snippet" must be copied word for word from one record below, and "source" must be that record's source. Otherwise return verdict "none" with an empty snippet and source.`,
    },
    {
      role: 'user',
      content: `What the meeting is discussing now:
${lineBlock(lines)}

Workspace records:
${recordBlock(facts)}`,
    },
  ];
}

/** Read the record verdict; a clear answers/contradicts with a verbatim snippet only. */
export function parseRecordReply(raw: string): RecordVerdict | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    throw new LlmError('Wingman record reply is not valid JSON', { cause: error });
  }
  if (!isObject(json) || (json.verdict !== 'answers' && json.verdict !== 'contradicts')) return undefined;
  if (!isString(json.snippet) || json.snippet.trim() === '') return undefined;
  if (!isString(json.source) || json.source.trim() === '') return undefined;
  return { verdict: json.verdict, snippet: json.snippet.trim(), source: json.source.trim() };
}

/** One point a silent person could add, grounded in the meeting or in one workspace record. */
export interface CatchupVerdict {
  suggestion: string;
  /** The verbatim evidence the suggestion was drawn from. */
  evidence: string;
  /** Where the point came from: a transcript line time, or a record source and date. */
  source: string;
  /** The workspace record the point came from, when it did not come from the meeting. */
  fact?: Fact;
}

/** The strict schema for one catch-up suggestion. */
export const CATCHUP_SCHEMA = {
  name: 'wingman_catchup',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['suggestion', 'basis', 'evidence', 'source'],
    properties: {
      suggestion: { type: 'string' },
      basis: { type: 'string', enum: ['meeting', 'workspace', 'none'] },
      evidence: { type: 'string' },
      source: { type: 'string' },
    },
  },
};

/**
 * The messages for a catch-up: what the meeting is deciding, plus at most one point this person
 * could genuinely add. The bar is high, so nothing is invented when the meeting has no opening.
 */
export function catchupMessages(
  scenario: Scenario,
  personName: string,
  role: Role,
  itemTitle: string,
  openQuestion: string | undefined,
  lines: readonly WingmanLine[],
  facts: readonly Fact[],
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `[KAKI_WINGMAN_CATCHUP]
You are the private Wingman for ${personName}, the ${roleLabel(scenario, role)} in a live meeting. The meeting is on "${itemTitle}"${openQuestion === undefined ? '' : ` and the open question is "${openQuestion}"`}.
Decide whether there is ONE genuinely useful point ${personName} could add to this discussion, using ONLY the transcript and workspace records below.
High bar: the point must be directly relevant and new, never general background, advice, or a repeat of what someone already said. If nothing clears that bar, return no suggestion. Never invent a fact, and never say or imply that ${personName} is expected to speak.
Return strict JSON and nothing else: {"suggestion":"","basis":"meeting"|"workspace"|"none","evidence":"","source":""}
When there is a point:
- "suggestion" is one short, plain sentence ${personName} could add. It must be supported by that evidence: say it in your own words if you like, but never add a fact, number, name or claim that the evidence does not contain.
- basis "meeting": "evidence" is copied word for word from one transcript line that supports it, and "source" is empty.
- basis "workspace": "evidence" is copied word for word from the text of one workspace record below (not its source or date line), and "source" is that record's source label, without the date.
Otherwise return basis "none" with an empty suggestion, evidence and source.`,
    },
    {
      role: 'user',
      content: `Agenda item: ${itemTitle}
${openQuestion === undefined ? 'No open question on this item.' : `Open question: ${openQuestion}`}

Transcript (oldest to newest):
${lineBlock(lines)}

Workspace records:
${facts.length === 0 ? '(none available)' : recordBlock(facts)}`,
    },
  ];
}

/** True when a quote is word for word in a record, ignoring case, punctuation and spacing. */
function quoteInRecord(evidence: string, text: string): boolean {
  const quote = normalise(evidence);
  const record = normalise(text);
  if (quote === '' || record === '') return false;
  // The model sometimes copies the record's source/date header along with its text, so accept
  // either direction; in both cases the record's own words are quoted in full.
  return ` ${record} `.includes(` ${quote} `) || ` ${quote} `.includes(` ${record} `);
}

/** True when the model's source label names this record, allowing a date it may have appended. */
function sourceNamesRecord(source: string, fact: Fact): boolean {
  const said = normalise(source);
  const label = normalise(fact.source);
  if (said === label) return true;
  const date = normalise(fact.date);
  return date !== '' && said === `${label} ${date}`;
}

/**
 * The record a model quote cites. A matching source label wins; otherwise the quoted words
 * must appear in exactly one offered record. In every case the quote itself must be real.
 * Shared by catch-up points and record notes so both accept the same harmless differences
 * (case, punctuation, spacing, a copied source/date header) without guessing at invented words.
 */
export function matchRecordFact(
  source: string | undefined,
  evidence: string,
  facts: readonly Fact[],
): Fact | undefined {
  const quoted = facts.filter((fact) => quoteInRecord(evidence, fact.text));
  if (quoted.length === 0) return undefined;
  const named = source === undefined ? undefined : quoted.find((fact) => sourceNamesRecord(source, fact));
  if (named !== undefined) return named;
  return quoted.length === 1 ? quoted[0] : undefined;
}

/**
 * Read a catch-up point whose evidence quote is real; the support check is a separate model
 * judgement. `log` receives the reason whenever no point survives, so a plain catch-up is never
 * silent in the server log.
 */
export function parseCatchupReply(
  raw: string,
  lines: readonly WingmanLine[],
  facts: readonly Fact[],
  log?: (reason: string) => void,
): CatchupVerdict | undefined {
  const reject = (reason: string): undefined => {
    log?.(reason);
    return undefined;
  };
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch (error) {
    throw new LlmError('Wingman catch-up reply is not valid JSON', { cause: error });
  }
  if (!isObject(json)) return reject('the reply was not a JSON object');
  if (json.basis === 'none') return reject('the model found no point worth adding');
  if (!isString(json.suggestion) || json.suggestion.trim() === '') {
    return reject('the reply had no suggestion');
  }
  if (!isString(json.evidence) || json.evidence.trim() === '') {
    return reject('the reply quoted no evidence');
  }
  const suggestion = json.suggestion.trim();
  const evidence = json.evidence.trim();
  const source = isString(json.source) && json.source.trim() !== '' ? json.source.trim() : undefined;
  // The evidence itself decides where the point is grounded, so a model that names the wrong basis
  // or leaves the source label out still keeps a point that is genuinely word for word.
  const meetingLine = groundedLine(evidence, lines);
  const meetingVerdict = (line: WingmanLine): CatchupVerdict => ({
    suggestion,
    evidence: line.text,
    source: `${speakerName(line.speaker)} · ${line.timestamp}`,
  });
  const factVerdict = (record: Fact): CatchupVerdict => ({
    suggestion,
    evidence: record.text,
    source: `${record.source} (${record.date})`,
    fact: record,
  });
  const fact = matchRecordFact(source, evidence, facts);
  if (json.basis === 'meeting') {
    if (meetingLine !== undefined) return meetingVerdict(meetingLine);
    if (fact !== undefined) return factVerdict(fact);
    return reject('the point is not word for word from a transcript line or a record we offered it');
  }
  if (json.basis === 'workspace') {
    if (fact !== undefined) return factVerdict(fact);
    if (meetingLine !== undefined) return meetingVerdict(meetingLine);
    return reject('the point is not word for word from a transcript line or a record we offered it');
  }
  return reject('the point had an unknown basis');
}

/** True when two statements say the same thing, allowing case, punctuation and a little extra text. */
function sameStatement(left: string, right: string): boolean {
  const first = normalise(left);
  const second = normalise(right);
  if (first === '' || second === '') return false;
  if (first === second) return true;
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
  // A short fragment inside a much longer sentence may be a different point, so only merge when
  // the two are close in size; this still absorbs a copied header or a missing trailing clause.
  if (shorter.length / longer.length < 0.8) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

/** A fact sourced from a past meeting's minutes rather than a company tool. */
function isMeetingSource(source: string): boolean {
  return /^meeting\b/i.test(source.trim());
}

/**
 * Turn the meeting's answer parts and the workspace facts into one statement per point. A record
 * that restates a meeting answer wins, so the shown sentence comes from the record with its source
 * and is never printed twice. A company record also wins over a past meeting's minutes, and the
 * first (best-ranked) fact wins when two records say the same thing.
 */
export function mergeAnswerEvidence(
  parts: readonly AnswerPart[],
  facts: readonly Fact[],
): { statements: AnswerPart[]; facts: Fact[] } {
  const merged: Array<AnswerPart & { fact?: Fact }> = [];
  const add = (candidate: AnswerPart & { fact?: Fact }): void => {
    const index = merged.findIndex((existing) => sameStatement(existing.text, candidate.text));
    if (index === -1) {
      merged.push(candidate);
      return;
    }
    const existing = merged[index]!;
    if (existing.fact === undefined && candidate.fact !== undefined) {
      // The record is the better citation for a statement the meeting also made.
      merged[index] = candidate;
      return;
    }
    if (
      existing.fact !== undefined &&
      candidate.fact !== undefined &&
      isMeetingSource(existing.fact.source) &&
      !isMeetingSource(candidate.fact.source)
    ) {
      merged[index] = candidate;
    }
  };
  for (const part of parts) add({ text: part.text, source: part.source });
  for (const fact of facts) add({ text: fact.text, source: `${fact.source} (${fact.date})`, fact });
  return {
    statements: merged.map(({ text, source }) => ({ text, source })),
    facts: merged.flatMap((entry) => (entry.fact === undefined ? [] : [entry.fact])),
  };
}

/** The strict schema for the support judgement of one catch-up suggestion. */
export const CATCHUP_CHECK_SCHEMA = {
  name: 'wingman_catchup_check',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['supported'],
    properties: {
      supported: { type: 'boolean' },
    },
  },
};

/** The messages for judging whether a catch-up suggestion is supported by its quoted evidence. */
export function catchupCheckMessages(suggestion: string, evidence: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `[KAKI_WINGMAN_CATCHUP_CHECK]
You judge one thing: is this catch-up suggestion supported by the quoted evidence?
Judge the meaning, not word overlap. A faithful paraphrase is supported. A suggestion is supported only when every claim it makes is stated in, or follows directly from, the evidence. It is not supported when it adds a fact, number, name, claim or implication the evidence does not contain.
Return strict JSON and nothing else: {"supported":true} or {"supported":false}.`,
    },
    {
      role: 'user',
      content: `Suggestion: "${suggestion}"
Evidence: "${evidence}"`,
    },
  ];
}

/** Read the support judgement; anything but a clear boolean is unreadable. */
export function parseCatchupCheckReply(raw: string): boolean | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(raw);
  } catch {
    return undefined;
  }
  return isObject(json) && typeof json.supported === 'boolean' ? json.supported : undefined;
}

/**
 * Ask the model whether a catch-up suggestion is supported by its evidence. A failed call or an
 * unreadable reply is retried once, like the notetaker's semantic verifier; if both fail it throws,
 * so the caller drops the suggestion instead of treating a transport problem as a pass.
 */
export async function verifyCatchupSuggestion(
  verifier: LlmClient,
  suggestion: string,
  evidence: string,
  log: (message: string) => void,
): Promise<boolean> {
  const messages = catchupCheckMessages(suggestion, evidence);
  let lastFailure: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await verifier.complete(messages, {
        json: true,
        schema: CATCHUP_CHECK_SCHEMA,
        temperature: 0,
      });
      const supported = parseCatchupCheckReply(reply);
      if (supported !== undefined) return supported;
      lastFailure = 'its reply could not be read';
      log(`could not read the catch-up check (attempt ${attempt + 1})`);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      log(`the catch-up check failed (attempt ${attempt + 1}): ${lastFailure}`);
    }
  }
  throw new Error(
    `the catch-up check could not judge the suggestion after 2 attempts (${lastFailure ?? 'no reason given'})`,
  );
}
