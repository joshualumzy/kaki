import {
  ACTION_KINDS,
  isActionKind,
  isObject,
  isRoleIn,
  isSuggestInput,
  speakerName,
  type Question,
  type Role,
  type Scenario,
  type Task,
} from '@kaki/shared';
import { LlmError, parseJsonReply } from '../services/llm';
import { normalize, transcriptLineText, words, type TranscriptLine } from './notetakerText';
import type { TaskCandidate } from './notetakerTasks';

/** A withdrawal or replacement of an accepted decision the model reports, with the cards it says depend on it. */
export interface RevisionRequest {
  oldDecisionEvidence: string;
  changeEvidence: string;
  taskIds: string[];
}

/** What one notetaker reply may contain: new questions and tasks, answers it closes, and reported revisions. */
export interface NotetakerReply {
  agendaIndex?: number;
  newQuestions: Array<{ text: string; forRole?: Role }>;
  answeredQuestionIds: string[];
  /** Questions the new lines answer, each with the line that states the answer. */
  answeredQuestions?: Array<{ id: string; evidence: string }>;
  newTasks: TaskCandidate[];
  /**
   * Actual reversals only. A missing or malformed list is a failed judgement (`revisionsError`), never an empty
   * success: otherwise a broken reply would silently keep a withdrawn decision and its cards.
   */
  revisions: RevisionRequest[];
  revisionsError?: string;
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

  // Every list the reply shape promises is required. A missing list is a failed pass, never an empty success:
  // a silently empty newTasks would look like "nothing happened" when the model simply did not answer.
  const list = (value: unknown, name: string): unknown[] => {
    if (!Array.isArray(value)) throw new LlmError(`Notetaker reply is missing its ${name} list`);
    return value;
  };

  const newQuestions = list(json.newQuestions, 'newQuestions').flatMap((question) => {
    if (!isObject(question) || typeof question.text !== 'string' || question.text.trim() === '') return [];
    return [isRoleIn(scenario, question.forRole) ? { text: question.text, forRole: question.forRole } : { text: question.text }];
  });

  // Legacy replies named answered questions by id only; keep reading them, but they cannot close anything.
  const answeredQuestionIds = (Array.isArray(json.answeredQuestionIds) ? json.answeredQuestionIds : []).filter(
    (id): id is string => typeof id === 'string',
  );

  const answeredQuestions = list(json.answeredQuestions, 'answeredQuestions').flatMap((answer) =>
    isObject(answer) && typeof answer.id === 'string' && typeof answer.evidence === 'string'
      ? [{ id: answer.id, evidence: answer.evidence }]
      : [],
  );

  // A reversal is only usable when every entry is complete. Missing or malformed is a failed judgement, which the
  // caller retries once; it must never read as "no revisions".
  let revisionsError: string | undefined;
  const revisions: RevisionRequest[] = [];
  if (!Array.isArray(json.revisions)) {
    revisionsError = 'its revisions list is missing';
  } else {
    for (const entry of json.revisions) {
      if (
        !isObject(entry) ||
        typeof entry.oldDecisionEvidence !== 'string' ||
        entry.oldDecisionEvidence.trim() === '' ||
        typeof entry.changeEvidence !== 'string' ||
        entry.changeEvidence.trim() === '' ||
        !Array.isArray(entry.taskIds) ||
        !entry.taskIds.every((id) => typeof id === 'string' && id.trim() !== '')
      ) {
        revisionsError = 'its revisions list is malformed';
        break;
      }
      revisions.push({
        oldDecisionEvidence: entry.oldDecisionEvidence,
        changeEvidence: entry.changeEvidence,
        taskIds: [...entry.taskIds] as string[],
      });
    }
  }

  const newTasks = list(json.newTasks, 'newTasks').flatMap((task): TaskCandidate[] => {
    if (!isObject(task) || typeof task.evidence !== 'string' || task.evidence.trim() === '') return [];
    // An unknown action kind still leaves a task the assignee can do by hand.
    const candidate = { ...task, actionKind: isActionKind(task.actionKind) ? task.actionKind : undefined };
    if (!isSuggestInput(candidate, scenario)) return [];
    const { title, context, suggestedAssignee, actionKind } = candidate;
    const duplicateOf = typeof task.duplicateOf === 'string' && task.duplicateOf.trim() !== '' ? task.duplicateOf : undefined;
    const decisionEvidence =
      typeof task.decisionEvidence === 'string' && task.decisionEvidence.trim() !== '' ? task.decisionEvidence : undefined;
    return [
      {
        title,
        context,
        suggestedAssignee,
        ...(actionKind === undefined ? {} : { actionKind }),
        evidence: task.evidence,
        ...(decisionEvidence === undefined ? {} : { decisionEvidence }),
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
    revisions,
    ...(revisionsError === undefined ? {} : { revisionsError }),
  };
}

/**
 * The strict JSON schema for one notetaker reply. Optional item fields are nullable because a strict schema
 * must require every property; `parseNotetakerReply` reads null exactly like an absent field.
 */
export function notetakerReplySchema(scenario: Scenario): { name: string; schema: Record<string, unknown> } {
  const roles = scenario.roles.map((role) => role.id);
  const nullableRole = { type: ['string', 'null'], enum: [...roles, null] };
  const nullableActionKind = { type: ['string', 'null'], enum: [...ACTION_KINDS, null] };
  const nullableString = { type: ['string', 'null'] };
  return {
    name: 'notetaker_reply',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['agendaIndex', 'newQuestions', 'answeredQuestions', 'newTasks', 'revisions'],
      properties: {
        agendaIndex: { type: 'integer' },
        newQuestions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'forRole'],
            properties: {
              text: { type: 'string' },
              forRole: nullableRole,
            },
          },
        },
        answeredQuestions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'evidence'],
            properties: {
              id: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
        newTasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'context', 'suggestedAssignee', 'actionKind', 'evidence', 'decisionEvidence', 'duplicateOf'],
            properties: {
              title: { type: 'string' },
              context: { type: 'string' },
              suggestedAssignee: { type: 'string', enum: roles },
              actionKind: nullableActionKind,
              evidence: { type: 'string' },
              decisionEvidence: nullableString,
              duplicateOf: nullableString,
            },
          },
        },
        revisions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['oldDecisionEvidence', 'changeEvidence', 'taskIds'],
            properties: {
              oldDecisionEvidence: { type: 'string' },
              changeEvidence: { type: 'string' },
              taskIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  };
}

/** The system prompt that gives the model the scenario, roles and agenda plus the reply rules. */
export function systemPrompt(scenario: Scenario, lines: TranscriptLine[] = []): string {
  const roles = scenario.roles.map((role) => {
    const line = lines.find((candidate) => candidate.role === role.id);
    const lineSpeaker = line === undefined ? undefined : speakerName(line.speaker);
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
    `You are the notetaker for "${scenario.meetingTitle}"${scenario.organisation === undefined ? '' : ` at ${scenario.organisation}`}.`,
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
    ' "evidence": string, "decisionEvidence": string, "duplicateOf": task id}],',
    ' "revisions": [{"oldDecisionEvidence": string, "changeEvidence": string, "taskIds": [task id]}]}',
    '',
    'Rules:',
    '- agendaIndex: the agenda item being discussed at the end of the new lines.',
    '- newQuestions: factual questions someone asked about data, rules, costs, dates, or specs that nobody answered in the lines. Write each as a full,',
    '  self-contained question ending in a question mark that explicitly names the current agenda topic (for example "What supplier lead time do we need to confirm?" rather than just "What lead time do you need me to confirm?").',
    '  forRole is the role best placed to answer (always set forRole to one of the role ids listed above — if a participant asks the room a question, set forRole to the speaker\'s own role or the owner of the current agenda item so Kaki can search company records for them; never omit forRole).',
    '  NEVER list a host opening handoff ("What\'s happening there?", "Can you walk us through...?") or the open-ended agenda decision question',
    '  addressed to a colleague ("How do we fix this for our customers...?", "How should we handle...?", "What do you want to do?", "What do you think from your side?") in newQuestions —',
    '  those are discussion prompts, not factual lookups.',
    '  NEVER invent a question out of a declarative statement: if a speaker is simply stating a fact or explaining a problem during the briefing (for example "a thirty percent price rise would cut demand"), do NOT turn their statement into a question in newQuestions. A question in newQuestions must come from someone actually asking about an unknown figure, policy, or option.',
    '  A reply that does not give the answer ("I don\'t know", "no idea", "I\'d have to check", "let me look it up",',
    '  "I haven\'t looked", "not per hour", "that is still open") does not answer the question: it stays a question.',
    '  Neither does an answer its speaker doubts or contradicts.',
    '  Read on before listing a question: if a later line, even the very next one, answers it, do not list it.',
    '  One topic can hold several separate unknowns: list each as its own question (for example "who signs off the',
    '  budget?" and "how is the budget reconciled at month end?"), even when they share the word budget. Only treat a',
    '  question as a repeat when it asks the same unknown, not merely because it is about the same topic. Use the',
    '  transcript\'s own nouns so each question names the unknown precisely.',
    '- answeredQuestions: open questions that a new line answers with the fact asked for, stated without doubt.',
    '  evidence: copy, word for word, the line that states the answer. A line that only mentions the topic, says the data',
    '  exists somewhere ("the report has that split"), gives a figure the speaker is unsure of, or promises to look',
    '  ("I would have to check", "I haven\'t looked") leaves the question open. Never close a question you cannot quote an',
    '  affirmative answer for, and never close one by id alone.',
    '- newTasks: a short list, usually empty. A task is a follow-up to deliver after the meeting that a person was',
    '  explicitly asked to do ("can you…", "please…", "let\'s have <Name> post/email/file…") or explicitly volunteered for ("I\'ll…", "I will…"). Include it only if:',
    '  * the evidence line itself explicitly contains a direct commitment ("I\'ll…", "I will…") or a direct request/assignment',
    '    ("can you…", "please…", "let\'s have <Name> post/email/file…") for a post-meeting deliverable. NEVER create a task from a line where someone is only',
    '    explaining a problem, quoting a price, pitching an option ("I think we should take the $450 deal"), or debating a trade-off',
    '    before the decision has been made;',
    '  * the title and context name the same deliverable as that commitment or request. Do not borrow one grounded',
    '    commitment (for example "I\'ll post the final plan in the team channel") for a different, invented deliverable',
    '    (for example "confirm the partner\'s rate and delivery dates"): if the line does not ask for it or volunteer it, there',
    '    is no task;',
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
    '  MUST include the specific topic and decision from the preceding lines (for example, title: "Post the pricing',
    '  decision in the team channel", context: "Announce in the team channel today that we decided to move to',
    '  monthly billing before Friday") — never use a generic placeholder like "Update team',
    '  channel" or "Send email" without the subject matter.',
    '  When the new lines refer back to a decision made earlier ("post that decision", "the plan"), take the decision',
    '  from the earlier lines on this agenda item and keep its concrete details in Context: the exact time of day',
    '  including AM or PM, who enforces or owns it, and how it will be measured. Never use a decision that a later',
    '  line corrected, reversed or replaced.',
    '  evidence: copy, word for word, the transcript line where it was asked for or volunteered.',
    '  decisionEvidence: when the task announces or communicates a decision the team already accepted on this agenda',
    '  item ("post that decision", "announce the plan"), quote the exact accepted decision line word for word, from the',
    '  earlier lines or the new lines. Quote the decision itself, not the line that asks for the task, and never a line',
    '  that a later line corrected, reversed or replaced. Keep its time of day (including AM or PM), who owns or',
    '  enforces it, and how it will be measured. Omit decisionEvidence when there is no accepted decision line. The',
    '  server checks the quote against the current agenda item; it is a model-selected quote, not a guarantee, and an',
    '  unmatched quote is ignored rather than trusted.',
    '  If it is the same work as a task already suggested, even worded differently, set duplicateOf to that task id. A',
    '  different person asked to do the work, a different decision, or a different deliverable (tool/actionKind) is a',
    '  separate task. However, if a speaker asks the assignee for TWO distinct follow-up deliverables across DIFFERENT',
    '  tools/actionKinds in the same turn (for example, an email AND a wiki_page, or a gitea_issue AND a mattermost_post,',
    '  or a calendar_event), extract BOTH deliverables as separate entries in newTasks with their respective actionKinds',
    '  (up to 2 tasks per turn).',
    '- revisions: report only an actual withdrawal or replacement of an accepted decision. Quote the earlier decision',
    '  and the changing line verbatim. Name only existing suggested task IDs that depend on that decision. Ordinary',
    '  "instead of" discussion is not a revision. Use [] when none.',
    '- Never repeat a question that is already open, even in different words. Keep newQuestions to at most two per pass.',
    '  Sharing topic words is not a repeat: keep distinct unknowns (who owns the budget vs how it is reconciled at close)',
    '  as separate questions.',
    '- A date, number or decision that someone asks for and nobody gives (for example "when is the final build?") is a',
    '  question, even if it is asked in passing. Do not ask something the lines already answer.',
    '  Use empty arrays when there is nothing new.',
    '',
    'Examples:',
    '- "[Priya (Manager)] I\'ll post the revised rota in the team channel tonight." → task (mattermost_post, Manager: the speaker owns it, not whoever the topic concerns).',
    '- "Can the login fix go in before Friday morning?" "Should be fine." → not a task: product work itself.',
    '- "[Alex (Manager)] Priya, can you walk us through the current state of the project?" → not a task: asking someone to speak in the meeting.',
    '- "Should the report use the new template?" "Yes, use the new one." → not a task: an answer, nobody asked or volunteered.',
    '- "He will run the workshop for $600, or $450 plus 20 printed guides." → not a task: a price quote and options, nobody was asked or volunteered for a follow-up.',
    '- "When is the supplier delivery due?" "The email says Monday, but I think it moved, so don\'t quote me." → question:',
    '  the only answer was doubted. Keep it open until someone states the date without doubt.',
  ].join('\n');
}

/** The user prompt with the current item, open questions, existing tasks and the earlier and new lines. */
export function userPrompt(
  scenario: Scenario,
  agendaIndex: number,
  openQuestions: Question[],
  existingTasks: Task[],
  earlier: TranscriptLine[],
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
          (task) =>
            `- ${task.id}: ${task.title} (owner: ${task.suggestedAssignee}) — ${task.context.slice(0, 160)}` +
            (task.decisionSource === undefined ? '' : ` [accepted decision: "${task.decisionSource}"]`),
        )),
    '',
    'Earlier lines on this agenda item, oldest first. They are context only: do not list them as new questions or',
    'tasks. The new lines may refer back to a decision made here.',
    ...(earlier.length === 0 ? ['(none)'] : earlier.map((line) => transcriptLineText(line, scenario))),
    '',
    'New transcript lines:',
    ...lines.map((line) => transcriptLineText(line, scenario)),
  ].join('\n');
}
/**
 * Resolve a model quote to a line only when the words are exactly the line, not merely a fuzzy overlap. A reversal
 * can move cards, so near-matches are not enough here. A voice turn can hold several sentences and the model may
 * quote just the one it means, so an exact contiguous phrase inside a single line is also accepted, provided it is
 * long enough to identify the line and only one line contains it.
 */
const MIN_REVISION_QUOTE_WORDS = 4;
/** The one transcript line an evidence quote exactly matches, or one unique phrase inside it; undefined otherwise. */
export function exactTranscriptLine(evidence: string, lines: TranscriptLine[]): TranscriptLine | undefined {
  const stripped = evidence
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/^\s*[A-Za-z][A-Za-z\s]{0,24}:\s*/, '');
  const wanted = normalize(stripped.length > 0 ? stripped : evidence);
  if (wanted === '') return undefined;
  let match: TranscriptLine | undefined;
  for (const line of lines) {
    if (normalize(line.text) === wanted) match = line;
  }
  if (match !== undefined) return match;
  if (words(wanted).length < MIN_REVISION_QUOTE_WORDS) return undefined;
  const contained = lines.filter((line) => ` ${normalize(line.text)} `.includes(` ${wanted} `));
  return contained.length === 1 ? contained[0] : undefined;
}
