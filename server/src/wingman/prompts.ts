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
import { LlmError, parseJsonReply, type ChatMessage } from '../services/llm';

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
