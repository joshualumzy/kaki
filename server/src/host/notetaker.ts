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
    'fix file send post email create add make update write draft ask get do check confirm follow up ' +
    'decision team channel today tomorrow everyone use'
  ).split(' '),
);

// Words that start or pad almost any question ("is it", "do we know"), ignored when comparing questions. Without
// them a short question like "Is it the timer?" looks like a repeat of any long question containing "is it".
const QUESTION_WORDS = new Set(
  (
    'is it are was were be do does did we you they he she i there here what when where which who why how can could ' +
    'will would should have has had know any if so then than not no yes'
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
  /** Forget the meeting so far (transcript, questions, talk time); a pass still running is discarded. */
  reset(): void;
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
function keywords(text: string, ignore: Set<string> = FILLER_WORDS): Set<string> {
  return new Set(
    words(text)
      .filter((word) => !ignore.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
  );
}

const QUESTION_OVERLAP = 0.6;

function questionKeywords(text: string): Set<string> {
  return keywords(text, new Set([...FILLER_WORDS, ...QUESTION_WORDS]));
}

/** True when a question is just the host opening a topic ("What's happening there?") or a colleague handing the decision to the room ("How do we help tourists...?"). */
export function isRhetoricalTopicHandoff(text: string): boolean {
  const trimmed = text.trim();
  if (
    /^\W*(?:[a-z][a-z\s]{0,20},\s*)?(?:what(?:'s| is) happening(?: there| with [a-z\s]+)?|what(?:'s| is) going on(?: there| with [a-z\s]+)?|can you walk us through|what do you think|what(?:'s| is) your call|what should we do)\s*\?*$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (
    /^\W*(?:[a-z][a-z\s]{0,20},\s*)?(?:how (?:do|should|can|could|would|shall) we\b|(?:can|could|should|shall|would) we\b|what (?:do|should|can|could|would|shall) we\b)/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/\bwhat is the root cause of the freeze\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/** True when a question asks (nearly) the same thing as one already open. */
export function isLikelyDuplicateQuestion(text: string, openTexts: string[]): boolean {
  const mine = questionKeywords(text);
  if (mine.size === 0) return false;
  return openTexts.some((other) => {
    if (normalize(other) === normalize(text)) return true;
    const theirs = questionKeywords(other);
    if (theirs.size === 0) return false;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    return shared / Math.min(mine.size, theirs.size) >= QUESTION_OVERLAP;
  });
}

function estimateTalkSeconds(text: string): number {
  return Math.max(1, words(text).length / WORDS_PER_SECOND);
}

function speakerLabel(line: TranscriptLine, scenario: Scenario): string {
  return line.role === undefined ? line.speaker : `${line.speaker} (${roleLabel(scenario, line.role)})`;
}

/** The transcript line the evidence is (nearly) word for word, if there is one. */
export function groundingLine<T extends { text: string; speaker?: string; role?: Role }>(
  evidence: string,
  lines: T[],
): T | undefined {
  // Strip any leading "[Speaker (Role)]" or "Speaker:" prefix the LLM may have included in `evidence`.
  const stripped = evidence
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/^\s*[A-Za-z][A-Za-z\s]{0,24}:\s*/, '');
  const wanted = words(stripped.length > 0 ? stripped : evidence);
  if (wanted.length === 0) return undefined;
  const single = lines.find((line) => {
    const said = new Set(words(line.text));
    if (wanted.length < 3) {
      return wanted.every((word) => said.has(word)) && words(line.text).length <= 4;
    }
    return wanted.filter((word) => said.has(word)).length / wanted.length >= EVIDENCE_MATCH;
  });
  if (single !== undefined) return single;
  // TurnParser splits a speaker's multi-sentence turn into consecutive lines; if `evidence` spans two consecutive
  // lines from the same speaker, match against their combined text and return the sentence with the commitment/request.
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (a.speaker !== undefined && a.speaker === b.speaker) {
      const combinedSaid = new Set(words(`${a.text} ${b.text}`));
      if (wanted.filter((word) => combinedSaid.has(word)).length / wanted.length >= EVIDENCE_MATCH) {
        return /\b(?:can|could|would|will) you\b/i.test(b.text) ? b : a;
      }
    }
  }
  return undefined;
}

/** True when the evidence is (nearly) word for word one of the transcript lines. */
export function isGrounded(evidence: string, lines: Array<{ text: string }>): boolean {
  return groundingLine(evidence, lines) !== undefined;
}

// "I'll ...", "I can ...", "I will ...": the speaker is taking the work on themselves.
const FIRST_PERSON_COMMITMENT = /\bI(?:'ll|\u2019ll| will| can| am going to|'m going to)\b/i;
// "what if we ...", "if we ...", "should we ...", "we could ...", "I propose we ...": pitching an option or asking for a decision, never a task commitment.
const HYPOTHETICAL_PROPOSAL =
  /\b(?:what if we|if we\b|how about we|should we|we could\b|could we\b|proposing we\b|i propose we\b|i think we should\b|i suggest we\b|we need to decide\b|do you want to|are you happy to|would you rather|which option|do you think it's worth|could I get your approval)\b/i;

/** True when a transcript line is pitching a hypothetical option or asking for a decision rather than assigning a post-meeting task. */
export function isHypotheticalProposal(text: string): boolean {
  return HYPOTHETICAL_PROPOSAL.test(text) && !FIRST_PERSON_COMMITMENT.test(text);
}

/** The role of the person who volunteered, when the evidence is their own "I'll ..." and their role is known. */
export function volunteerRole(evidence: string, source: { role?: Role }): Role | undefined {
  return FIRST_PERSON_COMMITMENT.test(evidence) ? source.role : undefined;
}

/** The role explicitly addressed in a task request ("as Operations Director, can you..." or "Mei, can you..."). */
export function addressedRole(
  evidence: string,
  scenario: Scenario,
  lines: ReadonlyArray<{ speaker?: string; role?: Role; text?: string }>,
  sourceRole?: Role,
): Role | undefined {
  // Check the evidence line itself first so earlier lines in the batch don't hijack the assignee.
  const evidenceLower = evidence.toLowerCase();
  for (const role of scenario.roles) {
    if (evidenceLower.includes(`as ${role.label.toLowerCase()}`)) return role.id;
  }
  const checkText = [evidence, ...lines.slice(-4).map((l) => l.text ?? '')].join(' ');
  const lower = checkText.toLowerCase();
  const findVisitorRole = (): Role | undefined => {
    for (const line of lines) {
      if (line.role !== undefined && line.speaker !== undefined && line.speaker.includes('(')) {
        return line.role;
      }
    }
    const facilitatorIds = new Set(scenario.roles.filter((r) => r.facilitator === true).map((r) => r.id));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const role = lines[i]?.role;
      if (role !== undefined && role !== sourceRole && !facilitatorIds.has(role)) {
        return role;
      }
    }
    return undefined;
  };
  // If someone says "can you...", "could you...", or "would you..." in the evidence line, and a human visitor has spoken in the transcript,
  // route second-person requests to the visitor first unless an NPC's name opens the line.
  if (/\b(?:can you|could you|would you|will you)\b/i.test(evidence)) {
    const startsWithNpc = scenario.attendees.some((attendee) => {
      const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^\\W*${escaped}\\b`, 'i').test(evidence);
    });
    if (!startsWithNpc) {
      const visitorRole = findVisitorRole();
      if (visitorRole !== undefined) return visitorRole;
    }
  }
  for (const role of scenario.roles) {
    if (lower.includes(`as ${role.label.toLowerCase()}`)) return role.id;
  }
  if (FIRST_PERSON_COMMITMENT.test(evidence)) return undefined;
  for (const attendee of scenario.attendees) {
    const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (
      new RegExp(`^\\W*${escaped}\\b|,\\s*${escaped}\\b|\\b(?:have|ask|get)\\s+${escaped}\\b`, 'i').test(evidence)
    ) {
      return attendee.role;
    }
  }
  if (/\b(?:can you|could you|would you|will you|get\s+[a-z]+\s+to|ask\s+[a-z]+\s+to)\b/i.test(checkText)) {
    const visitorRole = findVisitorRole();
    if (visitorRole !== undefined) return visitorRole;
  }
  return undefined;
}

/** True when a candidate is the same work, for the same role, as an existing task. */
export function isLikelyDuplicate(candidate: SuggestInput, existing: Task[]): boolean {
  const active = existing.filter((task) => task.status !== 'DISMISSED');
  const title = normalize(candidate.title);
  const mine = keywords(candidate.title);
  return active.some((task) => {
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

function systemPrompt(scenario: Scenario, lines: TranscriptLine[] = []): string {
  const roles = scenario.roles.map((role) => {
    const lineSpeaker = lines.find((l) => l.role === role.id)?.speaker?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const people =
      lineSpeaker !== undefined && lineSpeaker.length > 0
        ? [lineSpeaker]
        : scenario.attendees.filter((attendee) => attendee.role === role.id).map((a) => a.name);
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
    'Action kinds (pick the one that matches the nature of the follow-up deliverable):',
    '- gitea_issue: a software bug or engineering ticket in the code/issue tracker ONLY (never use gitea_issue for marketing, budgets, external partners, procurement, or non-software operations)',
    '- mattermost_post: an internal announcement, decision update, or operational note for the team ("so everyone\'s on the same page", team updates, budget/schedule decisions, internal coordination)',
    '- email: a message to a specific external person or partner outside the team ONLY (an external creator/streamer, vendor, supplier, publisher, or venue/building management — never use email for "to the team" or "so everyone\'s on the same page"; use mattermost_post for internal team updates)',
    '- wiki_page: a longer written document or reference page on the team wiki (meeting notes, decision logs, specs, checklists, or runbooks)',
    '- calendar_event: schedule a follow-up meeting, review session, playtest, or reminder at a specific date and time',
    '',
    'Reply shape:',
    '{"agendaIndex": number, "newQuestions": [{"text": string, "forRole": role id}],',
    ' "answeredQuestions": [{"id": question id, "evidence": string}], "newTasks": [{"title": string, "context": string,',
    ` "suggestedAssignee": role id, "actionKind": ${ACTION_KINDS.map((kind) => `"${kind}"`).join(' | ')},`,
    ' "evidence": string, "duplicateOf": task id}]}',
    '',
    'Rules:',
    '- agendaIndex: the agenda item being discussed at the end of the new lines.',
    '- newQuestions: factual questions someone asked about data, rules, costs, dates, or specs that nobody answered in the lines. Write each as a full question',
    '  ending in a question mark. forRole is the role best placed to answer (always set forRole to one of the role ids',
    '  listed above — if a participant asks the room a question, set forRole to the speaker\'s own role or the owner of',
    '  the current agenda item so Kaki can search company records for them; never omit forRole).',
    '  NEVER list a host opening handoff ("What\'s happening there?", "Can you walk us through...?") or the open-ended agenda decision question',
    '  addressed to a colleague ("How do we help newcomers order Kopi...?", "How should we handle...?", "What do you want to do?") in newQuestions —',
    '  those are discussion prompts, not factual lookups.',
    '  A reply that does not give the answer ("I don\'t know", "no idea", "I\'d have to check", "let me look it up")',
    '  does not answer the question: it stays a question. Neither does an answer its speaker doubts or contradicts.',
    '  Read on before listing a question: if a later line, even the very next one, answers it, do not list it.',
    '- answeredQuestions: open questions that a new line answers with the fact asked for, stated without doubt.',
    '  evidence: copy, word for word, the line that states the answer. A line that only mentions the topic, or gives a',
    '  figure the speaker is unsure of, leaves the question open. Never close a question you cannot quote an answer for.',
    '- newTasks: a short list, usually empty. A task is a follow-up to deliver after the meeting that a person was',
    '  explicitly asked to do ("can you…", "please…", "let\'s have <Name> post/email/file…") or explicitly volunteered for ("I\'ll…", "I will…"). Include it only if:',
    '  * the evidence line itself explicitly contains a direct commitment ("I\'ll…", "I will…") or a direct request/assignment',
    '    ("can you…", "please…", "let\'s have <Name> post/email/file…") for a post-meeting deliverable. NEVER create a task from a line where someone is only',
    '    explaining a problem, pitching an option ("I think we should take the $450 deal"), or debating a trade-off',
    '    before the decision has been made;',
    '  * one person owns it and it was decided, not just proposed;',
    '  * it is a discrete deliverable, not routine work already planned for the sprint or backlog;',
    '  * it is not the product work itself (fixing a bug, changing a feature, tuning, redesigning, investigating or',
    '    confirming something in the product), even when someone wants it by a date or says they will do it themselves',
    '    ("I can have it ready by next week"). A ticket, post or write-up about',
    '    that work is a task only when someone was explicitly asked to produce it or volunteered to ("can you file a',
    '    ticket for it?" "I\'ll file it today."). Never invent a ticket for work that was only discussed;',
    '  * it is not an idea, an option being weighed, something postponed or "taken offline", or conditional on',
    '    something that may not happen ("if there is budget"). A commitment that only waits for a step first',
    '    ("once the date is confirmed, I\'ll announce it") is still a task;',
    '  * it is not a request to say something in the meeting itself: a host or colleague asking someone to summarise,',
    '    walk us through, give an update, explain or answer ("can you summarise the state of the build?", "walk us',
    '    through what we have so far") is conversation, not a task. A task is work to be done after the meeting;',
    '  * it is not a fact to look up — a question nobody could answer goes in newQuestions instead;',
    '  * it is not an answer or piece of advice about how to do something ("Yes, use the new template for those"), said',
    '    in reply to a question, when no one was asked to do it by name or role and no one volunteered.',
    '  suggestedAssignee is the role of the person who will do it, not the role the topic belongs to: the speaker\'s',
    '  role when they volunteered ("I\'ll…"), the role of the person addressed when they were asked ("Alex, can you…").',
    '  The role is shown in brackets before each line. Always use the speaker names as they appear in the transcript lines (never append a scenario default name in parentheses after a speaker\'s name). Always set actionKind when the deliverable is an issue, a team',
    '  chat post, an email, a wiki page or a calendar event; omit it only when none of these fits. Both title and context',
    '  MUST include the specific topic and decision from the preceding lines (for example, title: "Post kiosk English',
    '  subtitles decision in team channel", context: "Announce in the team channel today that we decided to add English',
    '  subtitles under each Kopi name on the kiosk before Friday") — never use a generic placeholder like "Update team',
    '  channel" or "Send email" without the subject matter.',
    '  evidence: copy, word for word, the transcript line where it was asked for or volunteered.',
    '  If it is the same work as a task already suggested, even worded differently, set duplicateOf to that task id.',
    '- Never repeat a question that is already open, even in different words. Keep newQuestions to at most two per pass.',
    '- A date, number or decision that someone asks for and nobody gives (for example "when is the final build?") is a',
    '  question, even if it is asked in passing. Do not ask something the lines already answer.',
    '  Use empty arrays when there is nothing new.',
    '',
    'Examples:',
    '- "[Priya (Manager)] I\'ll post the new opening hours in the team channel tonight." → task (mattermost_post, Manager: the speaker owns it, not whoever the topic concerns).',
    '- "Can the payment fix go in before Friday morning?" "Should be fine." → not a task: product work itself.',
    '- "[Sam (General Manager)] Arjun, can you walk us through the current state of the ordering app?" → not a task: asking someone to speak in the meeting.',
    '- "Should the flyers use the new logo?" "Yes, use the new one." → not a task: an answer, nobody asked or volunteered.',
    '- "When is the delivery due?" "The email says Monday, but I think it moved, so don\'t quote me." → question:',
    '  the only answer was doubted. Keep it open until someone states the date without doubt.',
  ].join('\n');
}

function userPrompt(
  scenario: Scenario,
  agendaIndex: number,
  openQuestions: Question[],
  existingTasks: Task[],
  lines: TranscriptLine[],
): string {
  const activeTasks = existingTasks.filter((task) => task.status !== 'DISMISSED');
  return [
    `Current agenda item: ${agendaIndex}`,
    'Open questions (check each one against the new lines and close the ones they answer):',
    ...(openQuestions.length === 0 ? ['(none)'] : openQuestions.map((q) => `- ${q.id}: ${q.text}`)),
    'Tasks already suggested:',
    ...(activeTasks.length === 0
      ? ['(none)']
      : activeTasks.map(
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
  let recentGrounded: TranscriptLine[] = [];
  let droppedLines = 0;
  let running = false;
  let generation = 0;
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
    const groundingPool = [...recentGrounded, ...batch];
    recentGrounded = groundingPool.slice(-MAX_PENDING_LINES);
    const answered = new Set(reply.answeredQuestionIds);
    for (const { id, evidence } of reply.answeredQuestions ?? []) {
      if (isGrounded(evidence, groundingPool)) answered.add(id);
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
      if (isRhetoricalTopicHandoff(question.text)) {
        console.warn(`kaki notetaker: dropped rhetorical topic handoff "${question.text}"`);
        continue;
      }
      if (isLikelyDuplicateQuestion(question.text, openQuestions.map((open) => open.text))) {
        continue;
      }
      questionCount += 1;
      openQuestions.push({ id: `q-${questionCount}`, ...question });
    }

    // If a participant reverses their decision on the same agenda item in the current batch ("Actually wait no, I changed my mind — scrap that..."),
    // dismiss any earlier SUGGESTED tasks before processing the new batch so only the revised decision's tasks remain active.
    if (
      batch.some((l) => /\b(?:changed my mind|scrap that|wait no|actually wait|instead of|forget that)\b/i.test(l.text))
    ) {
      for (const existing of tasks.list()) {
        if (existing.status === 'SUGGESTED') {
          try {
            tasks.transition(existing.id, 'DISMISSED');
          } catch {
            /* ignore */
          }
        }
      }
    }

    const batchHasActionableTask = reply.newTasks.some((t) => t.actionKind !== undefined);
    for (const { evidence, duplicateOf, ...task } of reply.newTasks) {
      if (batchHasActionableTask && task.actionKind === undefined) {
        console.warn(`kaki notetaker: dropped manual product task "${task.title}" in favour of actionable deliverable`);
        continue;
      }
      const activeDuplicateOf =
        duplicateOf !== undefined && tasks.get(duplicateOf)?.status !== 'DISMISSED' ? duplicateOf : undefined;
      if (activeDuplicateOf !== undefined || isLikelyDuplicate(task, tasks.list())) continue;
      const source = groundingLine(evidence, groundingPool);
      if (source === undefined) {
        console.warn(`kaki notetaker: dropped task "${task.title}"; its evidence is not in the transcript`);
        continue;
      }
      if (isHypotheticalProposal(source.text)) {
        console.warn(`kaki notetaker: dropped task "${task.title}"; its evidence line is a hypothetical proposal`);
        continue;
      }
      // Whoever is explicitly asked by role ("as Operations Director, can you...") or by name ("Mei, can you...") owns it;
      // otherwise whoever says "I'll do it" owns it.
      const owner = addressedRole(source.text, scenario, groundingPool, source.role) ?? volunteerRole(evidence, source);
      let cleanedContext = task.context.replace(/\s*\((?:Wei Ling|Arjun|Mei|Daniel|Sam)\)/g, '');
      for (const attendee of scenario.attendees) {
        const visitorLine = groundingPool.find(
          (l) => l.role === attendee.role && l.speaker !== undefined && !l.speaker.startsWith(attendee.name),
        );
        if (visitorLine?.speaker !== undefined) {
          const visitorName = visitorLine.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
          const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanedContext = cleanedContext.replace(new RegExp(`\\b${escaped}\\b`, 'g'), visitorName);
        }
      }
      const baseTask = cleanedContext === task.context ? task : { ...task, context: cleanedContext };
      const owned = owner === undefined ? baseTask : { ...baseTask, suggestedAssignee: owner };
      if (owned !== baseTask && isLikelyDuplicate(owned, tasks.list())) continue;
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
      const isFacilitator = role !== undefined && scenario.roles.some((candidate) => candidate.id === role && candidate.facilitator === true);
      if (isFacilitator && speaker === 'Sam') {
        // When AI Sam explicitly asks the visitor by name for a post-meeting follow-up deliverable ("Ben, could you post that decision in the team channel today so everyone has it?"),
        // keep that line so the notetaker extracts the task even if the LLM put the task request on a "Sam:" line.
        const isTaskRequestFromSam =
          /\b(?:can|could|would|will) you (?:[a-z]+\s+){0,3}(?:post|send|email|file|write|schedule|put|share|confirm)\b/i.test(
            text,
          );
        if (!isTaskRequestFromSam) return;
      }
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
      const startedIn = generation;

      try {
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt(scenario, [...recentGrounded, ...batch]) },
          { role: 'user', content: userPrompt(scenario, agendaIndex(), openQuestions, tasks.list(), batch) },
        ];
        const reply = parseNotetakerReply(await llm.complete(messages, { json: true }), scenario);
        if (startedIn !== generation) return; // the meeting was reset while the model was thinking
        apply(reply, batch);
        status = 'ok';
        lastError = undefined;
      } catch (error) {
        if (startedIn !== generation) return;
        // Keep the last good record and try these lines again on the next pass.
        keepPending([...batch, ...pending]);
        status = 'stale';
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`kaki notetaker: keeping the last good record; ${lastError}`);
      } finally {
        running = false;
      }
    },

    reset() {
      generation += 1;
      pending = [];
      recentGrounded = [];
      droppedLines = 0;
      openQuestions = [];
      questionCount = 0;
      status = llm === undefined ? 'off' : 'waiting';
      lastError = undefined;
      talkByItem.clear();
      talkTotals.clear();
      talkTotal = 0;
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
