import {
  ACTION_KINDS,
  isActionKind,
  isRoleIn,
  isSuggestInput,
  roleForZoomName,
  roleLabel,
  type NotetakerStatus,
  type Question,
  type Role,
  type Scenario,
  type SuggestInput,
  type Task,
} from '@kaki/shared';
import { LlmError, parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { TaskStore } from '../tasks';

/** Rough speaking rate used to turn transcript words into talk time. */
const WORDS_PER_SECOND = 2.5;
/** A role is quiet when it has under this share of talk time... */
const QUIET_SHARE = 0.1;
/** ...once the meeting has at least this much talk overall. */
const QUIET_MIN_TOTAL_SECONDS = 60;
/** Unsent lines kept while the LLM is down; older ones are dropped. */
const MAX_PENDING_LINES = 200;
/** Share of a task's evidence words that must appear in one transcript line. */
const EVIDENCE_MATCH = 0.8;
/** Share of keywords two tasks for the same role must share to count as the same task. */
const DUPLICATE_OVERLAP = 0.6;

// Words that say nothing about which task it is, ignored when comparing task titles.
const FILLER_WORDS = new Set(
  (
    'a an and at by for from in into of on or the to with after before about once our their this that ' +
    'fix file send post email create add make update write draft ask get do check confirm follow up'
  ).split(' '),
);

interface TranscriptLine {
  speaker: string;
  role?: Role;
  text: string;
}

/** The notetaker's part of the Meeting Record. */
export interface NotetakerState {
  openQuestions: Question[];
  /** Talk time per role for one agenda item. */
  talkSecondsFor(agendaIndex: number): Partial<Record<Role, number>>;
  /** Attendee roles with little talk time across the meeting so far. */
  quietRoles: Role[];
  status: NotetakerStatus;
  /** Why the last pass failed; logged on the server, never shown in the room. */
  lastError?: string;
}

/** Turns new transcript into the Meeting Record and suggests tasks through the task store. */
export interface Notetaker {
  addChunk(chunk: { speaker: string; text: string }): void;
  /** Send transcript added since the last pass to the LLM; does nothing if a pass is running. */
  run(): Promise<void>;
  state(): NotetakerState;
}

/** What the notetaker needs; without `llm` it only keeps talk time. */
export interface NotetakerOptions {
  scenario: Scenario;
  tasks: TaskStore;
  llm?: LlmClient;
  /** The agenda item the meeting is on now. */
  agendaIndex: () => number;
  /** Called when the LLM hears the meeting move on to a later agenda item; omit to ignore it. */
  onAgendaIndex?: (agendaIndex: number) => void;
}

/** A task the LLM proposes, with the words it heard it in. */
export interface TaskCandidate extends SuggestInput {
  evidence: string;
  duplicateOf?: string;
}

interface NotetakerReply {
  agendaIndex?: number;
  newQuestions: Array<{ text: string; forRole?: Role }>;
  answeredQuestionIds: string[];
  /** Questions the new lines answer, each with the line that states the answer. */
  answeredQuestions?: Array<{ id: string; evidence: string }>;
  newTasks: TaskCandidate[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

// The words that identify a task, roughly singularised so "customers" matches "customer".
function keywords(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((word) => !FILLER_WORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
  );
}

const QUESTION_OVERLAP = 0.6;

/** True when a question asks (nearly) the same thing as one already open. */
export function isLikelyDuplicateQuestion(text: string, openTexts: string[]): boolean {
  const mine = keywords(text);
  if (mine.size === 0) return false;
  return openTexts.some((other) => {
    if (normalize(other) === normalize(text)) return true;
    const theirs = keywords(other);
    if (theirs.size === 0) return false;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    return shared / Math.min(mine.size, theirs.size) >= QUESTION_OVERLAP;
  });
}

function estimateTalkSeconds(text: string): number {
  return Math.max(1, words(text).length / WORDS_PER_SECOND);
}

/** The transcript line the evidence is (nearly) word for word, if there is one. */
export function groundingLine<T extends { text: string }>(evidence: string, lines: T[]): T | undefined {
  const wanted = words(evidence);
  if (wanted.length < 3) return undefined;
  return lines.find((line) => {
    const said = new Set(words(line.text));
    return wanted.filter((word) => said.has(word)).length / wanted.length >= EVIDENCE_MATCH;
  });
}

/** True when the evidence is (nearly) word for word one of the transcript lines. */
export function isGrounded(evidence: string, lines: Array<{ text: string }>): boolean {
  return groundingLine(evidence, lines) !== undefined;
}

// "I'll ...", "I can ...", "I will ...": the speaker is taking the work on themselves.
const FIRST_PERSON_COMMITMENT = /\bI(?:'ll|\u2019ll| will| can| am going to|'m going to)\b/i;

/** The role of the person who volunteered, when the evidence is their own "I'll ..." and their role is known. */
export function volunteerRole(evidence: string, source: { role?: Role }): Role | undefined {
  return FIRST_PERSON_COMMITMENT.test(evidence) ? source.role : undefined;
}

/** True when a candidate is the same work, for the same role, as an existing task. */
export function isLikelyDuplicate(candidate: SuggestInput, existing: Task[]): boolean {
  const title = normalize(candidate.title);
  const mine = keywords(candidate.title);
  return existing.some((task) => {
    if (normalize(task.title) === title) return true;
    if (task.suggestedAssignee !== candidate.suggestedAssignee || mine.size < 2) return false;
    const theirs = keywords(task.title);
    if (theirs.size < 2) return false;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    return shared / Math.min(mine.size, theirs.size) >= DUPLICATE_OVERLAP;
  });
}

/** Parse the LLM's JSON reply, dropping any item that does not fit the scenario. */
export function parseNotetakerReply(text: string, scenario: Scenario): NotetakerReply {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch (error) {
    throw new LlmError('Notetaker reply is not valid JSON', { cause: error });
  }
  if (!isObject(json)) throw new LlmError('Notetaker reply must be a JSON object');

  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const newQuestions = list(json.newQuestions).flatMap((question) => {
    if (!isObject(question) || typeof question.text !== 'string' || question.text.trim() === '') return [];
    return [isRoleIn(scenario, question.forRole) ? { text: question.text, forRole: question.forRole } : { text: question.text }];
  });

  const answeredQuestionIds = list(json.answeredQuestionIds).filter(
    (id): id is string => typeof id === 'string',
  );

  const answeredQuestions = list(json.answeredQuestions).flatMap((answer) =>
    isObject(answer) && typeof answer.id === 'string' && typeof answer.evidence === 'string'
      ? [{ id: answer.id, evidence: answer.evidence }]
      : [],
  );

  const newTasks = list(json.newTasks).flatMap((task): TaskCandidate[] => {
    if (!isObject(task) || typeof task.evidence !== 'string' || task.evidence.trim() === '') return [];
    // An unknown action kind still leaves a task the assignee can do by hand.
    const candidate = { ...task, actionKind: isActionKind(task.actionKind) ? task.actionKind : undefined };
    if (!isSuggestInput(candidate, scenario)) return [];
    const { title, context, suggestedAssignee, actionKind } = candidate;
    const duplicateOf = typeof task.duplicateOf === 'string' && task.duplicateOf.trim() !== '' ? task.duplicateOf : undefined;
    return [
      {
        title,
        context,
        suggestedAssignee,
        ...(actionKind === undefined ? {} : { actionKind }),
        evidence: task.evidence,
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
      },
    ];
  });

  const agendaIndex =
    Number.isInteger(json.agendaIndex) && (json.agendaIndex as number) >= 0 && (json.agendaIndex as number) < scenario.agenda.length
      ? (json.agendaIndex as number)
      : undefined;

  return {
    agendaIndex,
    newQuestions,
    answeredQuestionIds,
    ...(answeredQuestions.length === 0 ? {} : { answeredQuestions }),
    newTasks,
  };
}

function systemPrompt(scenario: Scenario): string {
  const roles = scenario.roles.map((role) => {
    const people = scenario.attendees.filter((attendee) => attendee.role === role.id).map((a) => a.name);
    return `- ${role.id}: ${role.label}${people.length > 0 ? ` (${people.join(', ')})` : ''}`;
  });
  const agenda = scenario.agenda.map(
    (item, index) => `${index}. ${item.title} (${item.minutes} min, owner: ${item.ownerRole})`,
  );

  return [
    `You are the notetaker for "${scenario.meetingTitle}" at ${scenario.organisation}.`,
    'You read new transcript lines and update the meeting record. Reply with one JSON object only.',
    '',
    'Roles (use the id on the left):',
    ...roles,
    '',
    'Agenda (use the number on the left):',
    ...agenda,
    '',
    'Action kinds:',
    '- gitea_issue: a bug or engineering task to file in the issue tracker',
    '- mattermost_post: an announcement or update for the team chat',
    '- email: a message to someone outside the team',
    '- wiki_page: write something up as a page on the team wiki (notes, decisions, a summary)',
    '- calendar_event: schedule a follow-up meeting or reminder at a date and time',
    '',
    'Reply shape:',
    '{"agendaIndex": number, "newQuestions": [{"text": string, "forRole": role id}],',
    ' "answeredQuestions": [{"id": question id, "evidence": string}], "newTasks": [{"title": string, "context": string,',
    ` "suggestedAssignee": role id, "actionKind": ${ACTION_KINDS.map((kind) => `"${kind}"`).join(' | ')},`,
    ' "evidence": string, "duplicateOf": task id}]}',
    '',
    'Rules:',
    '- agendaIndex: the agenda item being discussed at the end of the new lines.',
    '- Only what the lines say counts. Every item you report must be backed by a line, quoted word for word as evidence.',
    '- newQuestions: a factual question someone asked that nobody has answered. This includes a date, number or decision',
    '  that is asked for and not given. Write it as a full question ending in "?", with forRole the role best placed to',
    '  answer. A reply that does not state the answer ("no idea", "I\'d have to check"), or an answer its speaker doubts,',
    '  leaves it open. Read on first: if a later line answers it, do not list it. Never repeat an open question,',
    '  even reworded. At most two per pass.',
    '- answeredQuestions: an open question that a new line answers with the fact asked for, stated without doubt.',
    '  evidence is that line. A line that only mentions the topic, or gives a figure the speaker is unsure of, closes',
    '  nothing. Never close a question you cannot quote an answer for. Check every open question on every pass.',
    '- newTasks: usually empty. A task is a deliverable for after the meeting that one person was explicitly asked to',
    '  do ("can you…", "please…") or volunteered for ("I\'ll…"), and that was decided, not just proposed. Not a task:',
    '  * routine work already planned, an idea, an option being weighed, something postponed or taken offline, or',
    '    something conditional ("if there is budget"). A commitment that only waits for a step ("once it is confirmed,',
    '    I\'ll announce it") is still a task;',
    '  * the product work itself (fixing, changing, tuning, investigating), even when someone says they will do it.',
    '    A ticket, post or write-up about that work is a task only when someone was asked to produce it or volunteered',
    '    to. Never invent one for work that was only discussed;',
    '  * a fact to look up: that is a question.',
    '  suggestedAssignee is whoever will do it: the speaker\'s role for "I\'ll…", the addressed person\'s role for "Alex,',
    '  can you…" (roles are in brackets before each line), never the role the topic belongs to. Set actionKind when the',
    '  deliverable is an issue, chat post, email, wiki page or calendar event. Put the who, what and when into context,',
    '  using only what was said. evidence is the line where it was asked for or volunteered. If it is the same work as a',
    '  task already suggested, even reworded, set duplicateOf to that task id.',
    '',
    'Examples:',
    '- "[Priya (Manager)] I\'ll post the new opening hours in the team channel tonight." → task (mattermost_post, Manager).',
    '- "Can the login fix go in before the demo?" "Should be fine." → not a task: product work.',
    '- "When is the delivery due?" "Monday, but I think it moved, so don\'t quote me." → question stays open.',
  ].join('\n');
}

function speakerLabel(line: TranscriptLine, scenario: Scenario): string {
  return line.role === undefined ? line.speaker : `${line.speaker} (${roleLabel(scenario, line.role)})`;
}

function userPrompt(
  scenario: Scenario,
  agendaIndex: number,
  openQuestions: Question[],
  existingTasks: Task[],
  lines: TranscriptLine[],
): string {
  return [
    `Current agenda item: ${agendaIndex}`,
    'Open questions (check each one against the new lines and close the ones they answer):',
    ...(openQuestions.length === 0 ? ['(none)'] : openQuestions.map((q) => `- ${q.id}: ${q.text}`)),
    'Tasks already suggested:',
    ...(existingTasks.length === 0
      ? ['(none)']
      : existingTasks.map(
          (task) => `- ${task.id}: ${task.title} (owner: ${task.suggestedAssignee}) — ${task.context.slice(0, 160)}`,
        )),
    '',
    'New transcript lines:',
    ...lines.map((line) => `[${speakerLabel(line, scenario)}] ${line.text}`),
  ].join('\n');
}

/** Create the notetaker; call `run` every 5–10 s while the meeting is on. */
export function createNotetaker({ scenario, tasks, llm, agendaIndex, onAgendaIndex }: NotetakerOptions): Notetaker {
  let pending: TranscriptLine[] = [];
  let droppedLines = 0;
  let running = false;
  let openQuestions: Question[] = [];
  let questionCount = 0;
  let status: NotetakerStatus = llm === undefined ? 'off' : 'waiting';
  let lastError: string | undefined;
  const talkByItem = new Map<number, Partial<Record<Role, number>>>();
  const talkTotals = new Map<Role, number>();
  let talkTotal = 0;
  const attending = new Set(scenario.attendees.map((attendee) => attendee.role));

  function addTalk(index: number, role: Role, seconds: number): void {
    const item = talkByItem.get(index) ?? {};
    item[role] = (item[role] ?? 0) + seconds;
    talkByItem.set(index, item);
    talkTotals.set(role, (talkTotals.get(role) ?? 0) + seconds);
    talkTotal += seconds;
  }

  function quietRoles(): Role[] {
    if (talkTotal < QUIET_MIN_TOTAL_SECONDS) return [];
    return scenario.roles
      .filter((role) => role.facilitator !== true)
      .map((role) => role.id)
      .filter((role) => attending.has(role) && (talkTotals.get(role) ?? 0) / talkTotal < QUIET_SHARE);
  }

  function keepPending(lines: TranscriptLine[]): void {
    droppedLines += Math.max(0, lines.length - MAX_PENDING_LINES);
    pending = lines.slice(-MAX_PENDING_LINES);
  }

  function apply(reply: NotetakerReply, batch: TranscriptLine[]): void {
    const answered = new Set(reply.answeredQuestionIds);
    for (const { id, evidence } of reply.answeredQuestions ?? []) {
      if (isGrounded(evidence, batch)) answered.add(id);
      else console.warn(`kaki notetaker: kept question ${id} open; its answer is not in the transcript`);
    }
    for (const question of openQuestions) {
      if (answered.has(question.id)) console.warn(`kaki notetaker: closed question "${question.text}" as answered`);
    }
    openQuestions = openQuestions.filter((question) => !answered.has(question.id));

    for (const question of reply.newQuestions) {
      // Something that is not phrased as a question (a note or a fragment) is not worth keeping open.
      if (!question.text.includes('?')) {
        console.warn(`kaki notetaker: dropped question "${question.text}"; it is not phrased as a question`);
        continue;
      }
      if (isLikelyDuplicateQuestion(question.text, openQuestions.map((open) => open.text))) {
        console.warn(`kaki notetaker: dropped question "${question.text}"; it repeats one that is already open`);
        continue;
      }
      questionCount += 1;
      openQuestions.push({ id: `q-${questionCount}`, ...question });
    }

    for (const { evidence, duplicateOf, ...task } of reply.newTasks) {
      if (duplicateOf !== undefined || isLikelyDuplicate(task, tasks.list())) continue;
      const source = groundingLine(evidence, batch);
      if (source === undefined) {
        console.warn(`kaki notetaker: dropped task "${task.title}"; its evidence is not in the transcript`);
        continue;
      }
      // Whoever says "I'll do it" owns it, whatever role the topic seems to belong to.
      const owner = volunteerRole(evidence, source);
      const owned = owner === undefined ? task : { ...task, suggestedAssignee: owner };
      if (owned !== task && isLikelyDuplicate(owned, tasks.list())) continue;
      try {
        tasks.suggest(owned);
      } catch (error) {
        console.error('kaki notetaker: could not suggest a task', error);
      }
    }

    if (reply.agendaIndex !== undefined && reply.agendaIndex > agendaIndex()) onAgendaIndex?.(reply.agendaIndex);
  }

  return {
    addChunk({ speaker, text }) {
      const role = roleForZoomName(scenario, speaker);
      if (role !== undefined) addTalk(agendaIndex(), role, estimateTalkSeconds(text));
      if (llm === undefined) return;
      keepPending([...pending, role === undefined ? { speaker, text } : { speaker, role, text }]);
    },

    async run() {
      if (droppedLines > 0) {
        console.warn(
          `kaki notetaker: dropped the ${droppedLines} oldest transcript lines while the LLM was unavailable; ` +
            'they will not be analysed',
        );
        droppedLines = 0;
      }
      if (llm === undefined || running || pending.length === 0) return;
      running = true;
      const batch = pending;
      pending = [];

      try {
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt(scenario) },
          { role: 'user', content: userPrompt(scenario, agendaIndex(), openQuestions, tasks.list(), batch) },
        ];
        apply(parseNotetakerReply(await llm.complete(messages, { json: true }), scenario), batch);
        status = 'ok';
        lastError = undefined;
      } catch (error) {
        // Keep the last good record and try these lines again on the next pass.
        keepPending([...batch, ...pending]);
        status = 'stale';
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`kaki notetaker: keeping the last good record; ${lastError}`);
      } finally {
        running = false;
      }
    },

    state() {
      return {
        openQuestions: [...openQuestions],
        talkSecondsFor: (index) => ({ ...(talkByItem.get(index) ?? {}) }),
        quietRoles: quietRoles(),
        status,
        lastError,
      };
    },
  };
}
