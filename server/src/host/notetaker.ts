import {
  ACTION_KINDS,
  canTransition,
  hostIdentityOf,
  isActionKind,
  isRoleIn,
  isSuggestInput,
  roleForZoomName,
  roleLabel,
  type AssignmentEvidence,
  type NotetakerStatus,
  type Question,
  type ReviewIssue,
  type Role,
  type Scenario,
  type SuggestInput,
  type Task,
} from '@kaki/shared';
import { LlmError, parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { SavedNotetakerState, SavedTranscriptLine } from '../persist/state';
import type { TaskStore } from '../tasks';

/** Rough speaking rate used to turn transcript words into talk time. */
const WORDS_PER_SECOND = 2.5;
/** A role is quiet when it has under this share of talk time... */
const QUIET_SHARE = 0.1;
/** ...once the meeting has at least this much talk overall. */
const QUIET_MIN_TOTAL_SECONDS = 60;
/** Unsent lines kept while the LLM is down; older ones are dropped. */
const MAX_PENDING_LINES = 200;
/** Earlier lines kept as decision context for the current agenda item. */
const MAX_AGENDA_CONTEXT_LINES = 80;
/** Share of a task's evidence words that must appear in one transcript line. */
const EVIDENCE_MATCH = 0.8;
/** Share of keywords two tasks for the same role must share to count as the same task. */
const DUPLICATE_OVERLAP = 0.6;
/** Extra passes allowed when the model leaves out the required `revisions` list; after this it is given up on. */
const REVISION_FAILURE_LIMIT = 2;

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

type TranscriptLine = SavedTranscriptLine;

/** The notetaker's part of the Meeting Record. */
export interface NotetakerState {
  openQuestions: Question[];
  /** Judgements the notetaker could not make; everyone can see these on the shared record. */
  reviewIssues: ReviewIssue[];
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
  addChunk(chunk: { speaker: string; text: string; speakerRole?: Role; overlap?: boolean }): void;
  /** Send transcript added since the last pass to the LLM; does nothing if a pass is running. */
  run(): Promise<void>;
  state(): NotetakerState;
  /** Forget the meeting so far (transcript, questions, talk time); a pass still running is discarded. */
  reset(): void;
  /** Everything needed to carry on after a restart. */
  snapshot(): SavedNotetakerState;
  /** Take up a saved notetaker; anything already heard is replaced. */
  restore(saved: SavedNotetakerState): void;
}

/** What the notetaker needs; without `llm` it only keeps talk time. */
export interface NotetakerOptions {
  /** The meeting's scenario, read through a getter because a Start commit or reset replaces it. */
  scenario: () => Scenario;
  tasks: TaskStore;
  llm?: LlmClient;
  /**
   * The model that checks meaning for answered questions and assignments. Defaults to `llm`; tests inject a
   * scripted one so their notetaker replies keep their own call sequence.
   */
  verifier?: LlmClient;
  /**
   * Test seam: judge the grounded candidates directly instead of asking the verifier model. Production leaves
   * this unset and uses the batched semantic verifier above.
   */
  verify?: (answers: AnswerCandidate[], tasks: ResolvedTaskCandidate[]) => Promise<VerifierResult>;
  /** The agenda item the meeting is on now. */
  agendaIndex: () => number;
  /** Seconds since the meeting started; omit when there is no meeting clock. */
  meetingElapsedSeconds?: () => number;
  /** Called when the LLM hears the meeting move on to a later agenda item; omit to ignore it. */
  onAgendaIndex?: (agendaIndex: number) => void;
  /**
   * Whether an unaddressed "can you..." may fall back to the one human in the room. In a meeting
   * with two or more people that shortcut cannot know who was asked, so it is off and the model's
   * own owner stays. Defaults to on, which keeps the single-human demo exactly as it was.
   */
  visitorOwnerShortcut?: () => boolean;
  /**
   * The roles actually in the room: every AI seat plus each person seat someone currently holds.
   * Omit to use the scenario's attendees, which is right for a standalone notetaker or the demo.
   */
  attendingRoles?: () => ReadonlySet<Role> | undefined;
}

/** A task the LLM proposes, with the words it heard it in. */
export interface TaskCandidate extends SuggestInput {
  evidence: string;
  /** The accepted decision line the LLM says this task announces, if any; it is checked against the transcript. */
  decisionEvidence?: string;
  duplicateOf?: string;
}

/** A withdrawal or replacement of an accepted decision the model reports, with the cards it says depend on it. */
export interface RevisionRequest {
  oldDecisionEvidence: string;
  changeEvidence: string;
  taskIds: string[];
}

interface NotetakerReply {
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

type Verdict = 'yes' | 'no' | 'unclear';

export interface AnswerCandidate {
  id: string;
  question: Question;
  source: TranscriptLine;
}

export interface ResolvedTaskCandidate {
  index: number;
  task: Omit<TaskCandidate, 'evidence' | 'decisionEvidence' | 'duplicateOf'>;
  source: TranscriptLine;
  decisionLine: TranscriptLine | undefined;
  ownershipEvidence: string;
  /** The old lexical owner check, kept so the verifier's owner can be compared and tests can reuse it. */
  lexicalOwner?: Role;
  duplicateOf?: string;
}

export interface TaskVerdict {
  verdict: Verdict;
  assigneeRole: Role | null;
}

export interface VerifierResult {
  answers: Map<string, Verdict>;
  tasks: Map<number, TaskVerdict>;
  /** Specific issues for candidates the verifier could not decide. */
  issues: string[];
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

// The wh-word a question starts with. Two questions on the same topic but asking different unknowns ("who runs cash?"
// versus "how is the float balanced?") must not be treated as repeats just because they share topic words.
function questionHead(text: string): string | undefined {
  return normalize(text).match(/^(?:[a-z]+\s+){0,2}(who|what|when|where|why|how)\b/)?.[1];
}

// A line that reports missing data, doubts the answer, or leaves the point open does not answer the question.
const UNCERTAIN_ANSWER =
  /\b(?:(?:i|we|they|he|she)\s+)?(?:don'?t|do not|doesn'?t|does not|didn'?t|did not)\s+know\b|\bno idea\b|\bnot sure\b|\bunsure\b|\bnot certain\b|\bcan'?t\s+(?:say|remember|confirm|tell)\b|\bcannot\s+(?:say|remember|confirm|tell)\b|\b(?:haven'?t|hasn'?t|hadn'?t|not|never)\s+(?:looked|checked|seen)\b|\bstill open\b|\b(?:not|haven'?t|hasn'?t)\s+settled\b|\bnot decided\b|\bunresolved\b|\bkeeps?\s+(?:[a-z'-]+\s+){0,3}open\b|\bdon'?t quote me\b|\bnot yet\b|\bto be confirmed\b|\b(?:won'?t|doesn'?t|does not|can'?t|cannot)\s+tell\s+(?:us|me|you)\b/i;

// A line that only offers or promises to look something up still has not stated the fact. "We can confirm <fact>"
// does state it, so plain "can confirm" is deliberately absent here.
const DEFERRED_ANSWER =
  /\b(?:(?:i|we|they|he|she)\s+)?(?:would|could|might|may|need to|needs to|have to|has to|will|shall)\s+(?:have to\s+)?(?:check|look|find out|verify|confirm|test|try|ask|pull|show|count|measure|investigate)\b|\b(?:i|we)\s+can\s+(?:check|look|find out|verify|test|try|ask|pull|show|count|measure|investigate)\b|\blet me\s+(?:check|look|find out|verify|confirm|test|try|ask|pull|show|count|measure|investigate)\b/i;

// An instruction or plan for what to do next ("put it on the list", "let's not decide blind") is not an answer.
const DIRECTIVE_ANSWER =
  /^\W*(?:(?:okay|ok|right|so|well|alright|fine|now)\s*[,.]?\s*)*(?:let'?s|put|keep|leave|hold|move on|defer|park|come back to)\b/i;

/** True when a transcript line states the answer itself, rather than repeating the topic, hedging, or promising to look. */
export function isAffirmativeAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) return false;
  return !UNCERTAIN_ANSWER.test(trimmed) && !DEFERRED_ANSWER.test(trimmed) && !DIRECTIVE_ANSWER.test(trimmed);
}

// Conservative topic check: a true quote about a different subject is not evidence for this question.
// Short contextual replies without a topic word remain open rather than being closed on guesswork.
const ANSWER_NON_TOPICS = new Set(
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty hundred thousand more less'.split(' '),
);

// Verbs and generic nouns that say nothing about which unknown a question asks. "We change the menu every week" must
// not look like an answer to "How is change counted and balanced at close?" just because both contain "change".
const GENERIC_TOPIC_WORDS = new Set(
  (
    'change changes changed need needs needed make makes made get gets got take takes took use uses used work works ' +
    'show shows showed give gives gave put puts run runs ran say says said think thinks know knows want wants like ' +
    'likes help helps find finds look looks looking go goes going come comes keep keeps see sees tell tells'
  ).split(' '),
);

// Two shared topic words are the minimum: one is a coincidence ("delivery" in a question and in "the delivery van broke
// down"). They must also cover half the question's topics, so a line that only names the subject ("solo diners get a
// discount") does not answer a different unknown about it ("how many solo diners need a table..."). A paraphrase or a
// terse answer that shares less stays open: this is a conservative filter, not a proof that the answer is correct.
const MIN_SHARED_ANSWER_WORDS = 2;
const MIN_ANSWER_COVERAGE = 0.5;

// A "who" answer can be short: "The floor managers will enforce it" names the actor and repeats the question's action
// even though it shares few of its topic words. Keep this exception narrow: the reply must repeat the action AND put an
// actor before it, so "The rule is enforced every morning" (no actor) and "Enforce it" (no actor) still stay open.
const ACTOR_PRONOUNS = new Set('i we they he she you me us them him her'.split(' '));
const NON_ACTOR_WORDS = new Set('it this that there here'.split(' '));

function stemTopicWord(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function whoQuestionAction(question: string): string | undefined {
  if (questionHead(question) !== 'who') return undefined;
  for (const word of words(question).slice(1)) {
    if (
      QUESTION_WORDS.has(word) ||
      FILLER_WORDS.has(word) ||
      ANSWER_NON_TOPICS.has(word) ||
      NON_ACTOR_WORDS.has(word) ||
      GENERIC_TOPIC_WORDS.has(word) ||
      /^\d+$/.test(word)
    ) {
      continue;
    }
    return stemTopicWord(word);
  }
  return undefined;
}

function answerNamesWho(question: string, answer: string): boolean {
  const action = whoQuestionAction(question);
  if (action === undefined) return false;
  const answerWords = words(answer);
  const at = answerWords.findIndex((word) => stemTopicWord(word) === action);
  if (at < 0) return false;
  return answerWords.slice(0, at).some(
    (word) =>
      ACTOR_PRONOUNS.has(word) ||
      (!QUESTION_WORDS.has(word) &&
        !FILLER_WORDS.has(word) &&
        !ANSWER_NON_TOPICS.has(word) &&
        !NON_ACTOR_WORDS.has(word) &&
        !/^\d+$/.test(word)),
  );
}

/** True when an answer line shares enough of the question's topic words to identify what it is about. */
export function answerMatchesQuestion(question: string, answer: string): boolean {
  const topicWords = [...questionKeywords(question)].filter(
    (word) =>
      word.length > 2 &&
      !/^\d+$/.test(word) &&
      !ANSWER_NON_TOPICS.has(word) &&
      !GENERIC_TOPIC_WORDS.has(word),
  );
  const answerWords = questionKeywords(answer);
  const shared = topicWords.filter((word) => answerWords.has(word));
  if (shared.length >= MIN_SHARED_ANSWER_WORDS && shared.length / topicWords.length >= MIN_ANSWER_COVERAGE) {
    return true;
  }
  return answerNamesWho(question, answer);
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
  return /^\W*(?:[a-z][a-z\s]{0,20},\s*)?(?:how (?:do|should|can|could|would|shall) we\b|(?:can|could|should|shall|would) we\b|what (?:do|should|can|could|would|shall) we\b)/i.test(
    trimmed,
  );
}

/** True when a question asks (nearly) the same thing as one already open. */
export function isLikelyDuplicateQuestion(text: string, openTexts: string[]): boolean {
  const mine = questionKeywords(text);
  if (mine.size === 0) return false;
  const head = questionHead(text);
  return openTexts.some((other) => {
    if (normalize(other) === normalize(text)) return true;
    const otherHead = questionHead(other);
    if (head !== undefined && otherHead !== undefined && head !== otherHead) return false;
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
export function groundingLine<T extends { text: string; speaker?: string; role?: Role; agendaItemTitle?: string }>(
  evidence: string,
  lines: T[],
  preferredAgendaItemTitle?: string,
): T | undefined {
  // Strip any leading "[Speaker (Role)]" or "Speaker:" prefix the LLM may have included in `evidence`.
  const stripped = evidence
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/^\s*[A-Za-z][A-Za-z\s]{0,24}:\s*/, '');
  const wanted = words(stripped.length > 0 ? stripped : evidence);
  if (wanted.length === 0) return undefined;
  // Prefer the closest line: two assignments that differ only by owner and subject ("Mei, can you post the seating
  // decision" vs "Wei Ling, can you post the cash decision") both pass a loose threshold, and the first one is not
  // necessarily the one that was quoted. An exact match still wins, so the wrong neighbour cannot hijack the evidence.
  let best: T | undefined;
  let bestScore = 0;
  for (const line of lines) {
    const said = new Set(words(line.text));
    if (wanted.length < 3) {
      if (wanted.every((word) => said.has(word)) && words(line.text).length <= 4) return line;
      continue;
    }
    const score = wanted.filter((word) => said.has(word)).length / wanted.length;
    if (score >= EVIDENCE_MATCH) {
      // Generic handover lines ("Wei Ling, can you post this plan...") repeat across agenda items and tie on score.
      // A unique decision source pinned to an agenda item breaks the tie without overriding a better textual match.
      const preferred =
        preferredAgendaItemTitle !== undefined && line.agendaItemTitle === preferredAgendaItemTitle;
      if (
        score > bestScore ||
        (score === bestScore && preferred && best?.agendaItemTitle !== preferredAgendaItemTitle)
      ) {
        best = line;
        bestScore = score;
      }
    }
  }
  if (best !== undefined) return best;
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

/**
 * The verbatim transcript line a model-selected decision quote resolves to, or undefined when the quote is missing or
 * not in the allowed decision pool. The quote is grounded, but the model still chose it: this does not prove it picked
 * the right decision, so a decision source is context for the draft, never a guarantee that the draft is complete.
 */
function decisionSourceLineFrom(
  evidence: string | undefined,
  decisionPool: TranscriptLine[],
): TranscriptLine | undefined {
  if (evidence === undefined) return undefined;
  return groundingLine(evidence, decisionPool);
}

// A speaker can identify themselves between "I" and the commitment ("I, Booth Playtest, will post..."). Keep the name
// short and comma-delimited so ordinary prose cannot bridge the two halves into a false commitment.
const SELF_IDENTIFICATION = String.raw`(?:\s*,\s*[\w'\u2019 -]{1,40}?,\s*|\s+)`;
// "I'll ...", "I will ...", "I'm going to ...": the speaker is taking the work on themselves. A capability offer
// ("I can file a ticket") only says the work is possible, so it is not a commitment and cannot create a task.
const FIRST_PERSON_COMMITMENT_SOURCE = String.raw`\b(?:I(?:'ll|\u2019ll|'m going to|${SELF_IDENTIFICATION}(?:will|am going to))|count on me to|leave it (?:with|to) me to|I(?:'ll| will) handle|I(?:'ll| will) take care of)\b`;
const FIRST_PERSON_COMMITMENT = new RegExp(FIRST_PERSON_COMMITMENT_SOURCE, 'i');
// "what if we ...", "if we ...", "should we ...", "we could ...", "I propose we ...": pitching an option or asking for a decision, never a task commitment.
const HYPOTHETICAL_PROPOSAL =
  /\b(?:what if we|if we\b|how about we|should we|we could\b|could we\b|proposing we\b|i propose we\b|i think we should\b|i suggest we\b|we need to decide\b|do you want to|are you happy to|would you rather|which option|do you think it's worth|could I get your approval)\b/i;
// A first-person sentence that hands the work to somebody else ("I'll ask Mei to post it") is delegation, not a promise
// to do it themselves, so it must not become their own commitment evidence.
const EXPLICIT_DELEGATION = /\b(?:ask|get|have|tell)\s+(?:[\w'-]+\s+){0,4}to\b/i;

/**
 * True when the line is the speaker's own first-person commitment, not a request to someone else or a delegation.
 * When the scenario and speaker are known, naming another attendee also disqualifies it: the sentence no longer says
 * unambiguously that this speaker is doing the work.
 */
export function isSelfVolunteerCommitment(text: string, scenario?: Scenario, speaker?: string): boolean {
  // Only a direct opening statement can authorize automatic acceptance. Other lines may still become tasks,
  // but their assignee decides through the normal responder path.
  const directCommitment = new RegExp(
    `^(?:(?:sure|okay|ok|yes|yep|yeah|alright|all right|certainly|absolutely)[,.!]?\\s+)*${FIRST_PERSON_COMMITMENT_SOURCE}`,
    'i',
  );
  if (!directCommitment.test(text.trim())) return false;
  if (/[?"“”]/.test(text) || EXPLICIT_DELEGATION.test(text)) return false;
  if (/\b(?:not|never|no|won't|wouldn't|can't|cannot|don't|refuse|decline)\b/i.test(text)) return false;
  if (/\b(?:if|unless|assuming|provided|maybe|perhaps|might|would|could|should|suppose|imagine)\b|\b(?:subject to|pending approval|depending on|in case)\b/i.test(text)) return false;
  if (/\b(?:said|says|claimed|quoted|told|reportedly|according to)\b/i.test(text)) return false;
  if (scenario === undefined || speaker === undefined) return true;
  const self = speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  return scenario.attendees.every((attendee) => {
    if (attendee.name.trim().toLowerCase() === self) return true;
    const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}

/** True when a transcript line is pitching a hypothetical option or asking for a decision rather than assigning a post-meeting task. */
export function isHypotheticalProposal(text: string): boolean {
  return HYPOTHETICAL_PROPOSAL.test(text) && !FIRST_PERSON_COMMITMENT.test(text);
}

// The kinds of deliverable someone can be asked for or volunteer to produce after the meeting. Routine product work
// ("I can check", "I can try") is deliberately absent: the prompt keeps that out of tasks.
const DELIVERABLE_VERB =
  'file|post|email|send|write|draft|prepare|schedule|book|create|update|publish|announce|share|order|arrange|set up|confirm|call|submit|raise|log|print|circulate|distribute|organise|organize|review|configure|test|switch|turn off|cut|clean|sanitize|run|use|pause|brief|hand out|set|install|put up|keep|hold';

// The same deliverables in the forms ordinary speech uses for assignments ("I'll be emailing", "get it published").
const DELIVERABLE_FORM =
  `${DELIVERABLE_VERB}|filing|posting|emailing|sending|writing|drafting|preparing|scheduling|booking|creating|` +
  'updating|publishing|announcing|sharing|ordering|arranging|setting up|confirming|calling|submitting|raising|logging|' +
  'printing|circulating|distributing|organising|organizing|reviewing|configuring|testing|switching|turning off|cutting|' +
  'cleaning|sanitizing|running|using|pausing|briefing|handing out|setting|installing|putting up|keeping|holding|' +
  'filed|posted|emailed|sent|written|drafted|prepared|scheduled|booked|created|updated|published|announced|shared|' +
  'ordered|arranged|set up|confirmed|called|submitted|raised|logged|printed|circulated|distributed|organised|organized|' +
  'reviewed|configured|tested|switched|turned off|cut|cleaned|sanitized|ran|used|paused|briefed|handed out|installed|kept|held';

const TASK_ASSIGNMENT = new RegExp(
  [
    `${FIRST_PERSON_COMMITMENT_SOURCE}\\s+(?:be\\s+)?(?:[\\w'-]+,?\\s+){0,6}(?:${DELIVERABLE_FORM}|take on|taking on)\\b`,
    `\\b(?:can|could|would|will)\\s+you\\s+(?:[\\w'-]+,?\\s+){0,8}(?:${DELIVERABLE_FORM}|take on|taking on)\\b`,
    `\\bplease\\s+(?:[\\w'-]+,?\\s+){0,5}(?:${DELIVERABLE_FORM}|take on|taking on)\\b`,
    `\\blet'?s have\\s+[\\w'-]+\\s+(?:[\\w'-]+,?\\s+){0,4}(?:${DELIVERABLE_FORM}|take on|taking on)\\b`,
    `\\b(?:leave it (?:with|to) me|count on me|consider it done|I'll take care of it)\\b`,
  ].join('|'),
  'i',
);

/** True when a line itself assigns or volunteers for a post-meeting deliverable, not just discusses rates or options. */
export function hasTaskAssignment(text: string): boolean {
  return TASK_ASSIGNMENT.test(text);
}

// MVP recovery: the only fallback allowed when the model's evidence line is missing or not an assignment is a verified
// decision line that explicitly promises, in the first person, to post or share that decision in Mattermost or the
// team channel. Other deliverables (Gitea, email, wiki, calendar) never recover from this fallback, and a decision
// quote without an actual posting promise is not a task.
const MATTERMOST_FIRST_PERSON_PROMISE = new RegExp(
  `${FIRST_PERSON_COMMITMENT_SOURCE}\\s+(?:post|share|announce|publish|circulate|distribute)\\b[^.!?]*\\b(?:mattermost|team channel)\\b`,
  'i',
);

function recoversMattermostDecision(
  task: Pick<Task, 'title' | 'context' | 'actionKind'>,
  decisionLine: TranscriptLine | undefined,
): decisionLine is TranscriptLine {
  return (
    task.actionKind === 'mattermost_post' &&
    decisionLine !== undefined &&
    hasTaskAssignment(decisionLine.text) &&
    !isHypotheticalProposal(decisionLine.text) &&
    MATTERMOST_FIRST_PERSON_PROMISE.test(decisionLine.text) &&
    taskMatchesAssignment(task, decisionLine)
  );
}

// Task terms that carry meaning in an assignment ("the decision", "the team channel") even though they are filler
// when comparing two task titles. Keep them for matching against the evidence line.
const ASSIGNMENT_TOPIC_WORDS = new Set('decision team channel today tomorrow everyone'.split(' '));
const DELIVERABLE_WORD = new RegExp(`^(?:${DELIVERABLE_FORM})$`, 'i');
// Words that identify no deliverable: pure filler, generic action verbs, and pronouns/auxiliaries.
const ASSIGNMENT_IGNORED_WORDS = new Set([
  ...[...FILLER_WORDS].filter((word) => !ASSIGNMENT_TOPIC_WORDS.has(word)),
  'set',
  'could',
  'would',
  'should',
  'can',
  'will',
  'shall',
  'please',
  'let',
  'us',
  'you',
  'we',
  'they',
  'he',
  'she',
  'i',
  'me',
  'my',
  'your',
  'our',
]);

function deliverableKeywords(text: string): Set<string> {
  return new Set(
    [...keywords(text, ASSIGNMENT_IGNORED_WORDS)].filter(
      (word) => (word.length >= 3 || /^\d{2,}$/.test(word)) && !DELIVERABLE_WORD.test(word),
    ),
  );
}

// A generic topic word ("decision", "team channel") says where the work lives, not which decision it concerns. When
// both the task and the evidence name a different subject for the same topic word ("butter decision" vs "cash
// decision"), they are not the same work. An anaphor ("that decision") names no subject, so it stays compatible.
const QUALIFIER_WINDOW = 2;
const GENERIC_STATUS_QUALIFIERS = new Set(['final', 'agreed', 'new', 'updated', 'current', 'corrected', 'latest', 'team', 'official']);

function qualifiersBefore(text: string, noun: string): Set<string> {
  const ws = words(text).map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
  const qualifiers = new Set<string>();
  for (let i = 0; i < ws.length; i += 1) {
    if (ws[i] !== noun) continue;
    let remaining = QUALIFIER_WINDOW;
    for (let j = i - 1; j >= 0 && remaining > 0; j -= 1, remaining -= 1) {
      const word = ws[j]!;
      if (ASSIGNMENT_IGNORED_WORDS.has(word) || DELIVERABLE_WORD.test(word) || GENERIC_STATUS_QUALIFIERS.has(word)) continue;
      qualifiers.add(word);
    }
  }
  return qualifiers;
}

function hasConflictingQualifier(a: string, b: string, nouns: Iterable<string>): boolean {
  for (const noun of nouns) {
    const mine = qualifiersBefore(a, noun);
    const theirs = qualifiersBefore(b, noun);
    if (mine.size === 0 || theirs.size === 0) continue;
    if ([...mine].some((word) => theirs.has(word))) continue;
    return true;
  }
  return false;
}

/**
 * True when the task's title/context names the same deliverable as the line that was quoted as its evidence.
 * Only that line counts: a neighbouring speaker's "butter plan" must not lend its words to an unrelated email task,
 * and a task with no concrete words ("Send the update", "Post it") has nothing to verify, so it is dropped rather
 * than waved through. This is a conservative filter; it can reject a valid paraphrase, but never treats it as proof.
 */
export function taskMatchesAssignment(
  task: { title: string; context: string },
  source: TranscriptLine,
  _lines: TranscriptLine[] = [],
): boolean {
  const taskWords = new Set([...deliverableKeywords(task.title), ...deliverableKeywords(task.context)]);
  if (taskWords.size === 0) return false;
  const sourceWords = deliverableKeywords(source.text);
  const shared = [...sourceWords].filter((word) => taskWords.has(word));
  if (shared.length === 0) return false;
  // A shared word that identifies the subject is enough; shared meeting vocabulary alone is not, because it may hide
  // a different subject ("butter decision" against "cash decision").
  if (shared.some((word) => !ASSIGNMENT_TOPIC_WORDS.has(word))) return true;
  return !hasConflictingQualifier(`${task.title} ${task.context}`, source.text, shared);
}

/** The role of the person who volunteered, when the evidence is their own "I'll ..." and their role is known. */
export function volunteerRole(evidence: string, source: { role?: Role }): Role | undefined {
  return FIRST_PERSON_COMMITMENT.test(evidence) ? source.role : undefined;
}

function baseSpeakerName(speaker: string): string {
  return speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

/**
 * The task snapshot to trust when the transcript speaker personally volunteered for it. The speaker must map exactly
 * to the task's assignee and the line must be their own direct commitment; a request to someone else, a delegation,
 * a question or a hypothetical is never evidence. The caller passes the final, cleaned task so the snapshot matches
 * the work that was actually suggested, and any later change to that work falls outside this evidence.
 */
export function selfVolunteeredAssignment(
  source: TranscriptLine,
  task: Pick<Task, 'title' | 'context' | 'actionKind' | 'suggestedAssignee'>,
  scenario: Scenario,
): AssignmentEvidence | undefined {
  if (source.speaker === undefined || !isSelfVolunteerCommitment(source.text, scenario, source.speaker)) return undefined;
  const speakerName = baseSpeakerName(source.speaker);
  const attendee = scenario.attendees.find((candidate) => baseSpeakerName(candidate.name) === speakerName);
  if (attendee === undefined || attendee.role !== task.suggestedAssignee) return undefined;
  return {
    speaker: source.speaker,
    quote: source.text,
    scope: {
      title: task.title,
      context: task.context,
      ...(task.actionKind === undefined ? {} : { actionKind: task.actionKind }),
    },
  };
}

/** The role explicitly addressed in a task request ("as Operations Director, can you..." or "<colleague name>, can you..."). */
export function addressedRole(
  evidence: string,
  scenario: Scenario,
  lines: ReadonlyArray<{ speaker?: string; role?: Role; text?: string }>,
  sourceRole?: Role,
  { visitorShortcut = true }: { visitorShortcut?: boolean } = {},
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
  // route second-person requests to the visitor first unless an NPC's name opens the sentence that asks
  // ("Right, four seats. Daniel, can you print the signs?" is Daniel's).
  const request = /\b(?:can you|could you|would you|will you)\b/i;
  const sentences = evidence.split(/(?<=[.!?])\s+/);
  if (visitorShortcut && request.test(evidence)) {
    const asking = sentences.filter((sentence) => request.test(sentence));
    const startsWithNpc = scenario.attendees.some((attendee) => {
      const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return asking.some((sentence) => new RegExp(`^\\W*${escaped}\\b`, 'i').test(sentence));
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
    const named = new RegExp(`^\\W*${escaped}\\b|,\\s*${escaped}\\b|\\b(?:have|ask|get)\\s+${escaped}\\b`, 'i');
    if (sentences.some((sentence) => named.test(sentence))) {
      return attendee.role;
    }
  }
  if (
    visitorShortcut &&
    /\b(?:can you|could you|would you|will you|get\s+[a-z]+\s+to|ask\s+[a-z]+\s+to)\b/i.test(checkText)
  ) {
    const visitorRole = findVisitorRole();
    if (visitorRole !== undefined) return visitorRole;
  }
  return undefined;
}

/**
 * True when a candidate is the same work, for the same role, as an existing task on the same agenda item. Two tasks
 * on different agenda items are separate work even when their wording overlaps: a delivery follow-up is not a repeat
 * of the food-safety follow-up that happened to share a template.
 */
export function isLikelyDuplicate(candidate: SuggestInput, existing: Task[]): boolean {
  const active = existing.filter((task) => task.status !== 'DISMISSED');
  const title = normalize(candidate.title);
  const mine = keywords(candidate.title);
  return active.some((task) => {
    if (task.agendaItemTitle !== candidate.agendaItemTitle) return false;
    if (task.suggestedAssignee !== candidate.suggestedAssignee) return false;
    if (normalize(task.title) === title) return true;
    if (
      task.actionKind !== undefined &&
      candidate.actionKind !== undefined &&
      task.actionKind !== candidate.actionKind
    ) {
      return false;
    }
    if (mine.size < 2) return false;
    const theirs = keywords(task.title);
    if (theirs.size < 2) return false;
    const shared = [...mine].filter((word) => theirs.has(word)).length;
    return shared / Math.min(mine.size, theirs.size) >= DUPLICATE_OVERLAP;
  });
}

/**
 * True when a candidate announces the same accepted decision as an existing task, even when a different role would
 * own it. Both sides must carry a grounded decision source and the same action kind: two distinct decisions never
 * share a source, so they are never merged, and a post and an email are different deliverables. This is conservative
 * by design: a candidate with no established source falls back to the per-owner duplicate check instead.
 */
export function isDuplicateAnnouncement(
  candidate: Pick<Task, 'decisionSource' | 'actionKind' | 'agendaItemTitle'>,
  existing: Task[],
): boolean {
  if (candidate.decisionSource === undefined) return false;
  const decision = normalize(candidate.decisionSource);
  if (decision === '') return false;
  return existing.some(
    (task) =>
      task.status !== 'DISMISSED' &&
      task.agendaItemTitle === candidate.agendaItemTitle &&
      task.decisionSource !== undefined &&
      normalize(task.decisionSource) === decision &&
      task.actionKind === candidate.actionKind,
  );
}

/**
 * True when a model-supplied duplicateOf target is the same work. The model makes that call by naming the id; only
 * clear conflicts refuse it: a card on another agenda item or for a different deliverable, or two grounded sources
 * that state different decisions. Wording is not compared, because the model may recognise a paraphrase the
 * keyword check cannot.
 */
export function isDuplicateTarget(
  candidate: Pick<Task, 'title' | 'suggestedAssignee' | 'decisionSource' | 'actionKind' | 'agendaItemTitle'>,
  target: Task,
): boolean {
  if (target.status === 'DISMISSED' || target.status === 'SUPERSEDED') return false;
  if (target.agendaItemTitle !== candidate.agendaItemTitle) return false;
  if (
    target.actionKind !== undefined &&
    candidate.actionKind !== undefined &&
    target.actionKind !== candidate.actionKind
  ) {
    return false;
  }
  if (
    target.decisionSource !== undefined &&
    candidate.decisionSource !== undefined &&
    normalize(target.decisionSource) !== normalize(candidate.decisionSource)
  ) {
    return false;
  }
  return true;
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
function notetakerReplySchema(scenario: Scenario): { name: string; schema: Record<string, unknown> } {
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

function userPrompt(
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

/** One prompt line; an overlap marker tells the model the two people spoke at the same time. */
function transcriptLineText(line: TranscriptLine, scenario: Scenario): string {
  const overlap = line.overlap === true ? ', overlapping speech' : '';
  return `[${speakerLabel(line, scenario)}${overlap}] ${line.text}`;
}

/**
 * Resolve a model quote to a line only when the words are exactly the line, not merely a fuzzy overlap. A reversal
 * can move cards, so near-matches are not enough here. A voice turn can hold several sentences and the model may
 * quote just the one it means, so an exact contiguous phrase inside a single line is also accepted, provided it is
 * long enough to identify the line and only one line contains it.
 */
const MIN_REVISION_QUOTE_WORDS = 4;
function exactTranscriptLine(evidence: string, lines: TranscriptLine[]): TranscriptLine | undefined {
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

const VERIFIER_MARKER = '[KAKI_SEMANTIC_VERIFIER]';

function isVerdict(value: unknown): value is Verdict {
  return value === 'yes' || value === 'no' || value === 'unclear';
}

function verifierMessages(
  scenario: Scenario,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
): ChatMessage[] {
  const roles = scenario.roles.map((role) => `- ${role.id}: ${role.label}`);
  const system = [
    VERIFIER_MARKER,
    'You check meeting evidence by meaning, not word overlap.',
    'For each exact question/quote pair, judge meaning rather than word overlap. Answer "yes" only when the line gives the requested fact without material uncertainty. Return "no" for unrelated, hypothetical, deferred, or different information; "unclear" when evidence is insufficient.',
    'For each deliverable/quote pair, answer "yes" only when the line assigns that same after-meeting deliverable to its owner, asks that named person to do it (for example "Ben, can you email the supplier?"), or the owner volunteers for it. The card is a suggestion the owner can still accept or decline, so a direct request counts. Return "no" for unrelated, hypothetical, deferred, or different work, or a request to nobody in particular; "unclear" when evidence is insufficient.',
    'Roles (use the id on the left):',
    ...roles,
    'Reply with one JSON object only.',
    'Shape: {"answers":[{"id":"q-1","verdict":"yes|no|unclear"}],"tasks":[{"index":0,"verdict":"yes|no|unclear","assigneeRole":"role-id" or null}]}.',
    'Include exactly one entry for every candidate under judgement. assigneeRole must name the role of the person who will do the work: for a request, the person who was asked (by name or role), never the speaker who asked. Check the suggested owner against the quote and correct it when the quote names someone else.',
  ].join('\n');
  const user = [
    'Questions to judge:',
    ...(answers.length === 0
      ? ['(none)']
      : answers.map((answer) => `- ${answer.id}: ${answer.question.text}\n  Quote: "${answer.source.text}"`)),
    'Deliverables to judge:',
    ...(tasks.length === 0
      ? ['(none)']
      : tasks.map((candidate) => {
          const action = candidate.task.actionKind === undefined ? '' : ` (${candidate.task.actionKind})`;
          return `- index ${candidate.index}: ${candidate.task.title} — ${candidate.task.context}${action}\n  Quote (${candidate.source.speaker ?? 'unknown'}): "${candidate.source.text}"\n  Suggested owner (verify it): ${candidate.task.suggestedAssignee}`;
        })),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Parse the verifier's reply, requiring exactly one typed verdict for every candidate. */
function parseVerifierReply(
  text: string,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
  scenario: Scenario,
): { answers: Map<string, Verdict>; tasks: Map<number, TaskVerdict> } | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch {
    return undefined;
  }
  if (!isObject(json) || !Array.isArray(json.answers) || !Array.isArray(json.tasks)) return undefined;

  const answerVerdicts = new Map<string, Verdict>();
  for (const entry of json.answers) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !isVerdict(entry.verdict)) return undefined;
    if (!answers.some((candidate) => candidate.id === entry.id)) return undefined;
    if (answerVerdicts.has(entry.id)) return undefined;
    answerVerdicts.set(entry.id, entry.verdict);
  }
  if (answerVerdicts.size !== answers.length) return undefined;

  const taskVerdicts = new Map<number, TaskVerdict>();
  for (const entry of json.tasks) {
    if (!isObject(entry) || !Number.isInteger(entry.index) || !isVerdict(entry.verdict)) return undefined;
    const index = entry.index as number;
    if (!tasks.some((candidate) => candidate.index === index)) return undefined;
    if (taskVerdicts.has(index)) return undefined;
    if (entry.verdict === 'yes' && !isRoleIn(scenario, entry.assigneeRole)) return undefined;
    const assigneeRole = isRoleIn(scenario, entry.assigneeRole) ? entry.assigneeRole : null;
    taskVerdicts.set(index, { verdict: entry.verdict, assigneeRole });
  }
  if (taskVerdicts.size !== tasks.length) return undefined;
  return { answers: answerVerdicts, tasks: taskVerdicts };
}

/**
 * One batched, meaning-based judgement for every grounded candidate in this pass. A failed call or unreadable
 * reply is retried once; if both fail it throws, so the caller keeps the batch pending for the next tick instead of
 * treating a transport problem as a model verdict. Only a parsed `unclear` verdict is the model's own judgement.
 */
async function verifyCandidates(
  verifier: LlmClient,
  scenario: Scenario,
  answers: AnswerCandidate[],
  tasks: ResolvedTaskCandidate[],
  log: (message: string) => void,
): Promise<VerifierResult> {
  if (answers.length === 0 && tasks.length === 0) {
    return { answers: new Map(), tasks: new Map(), issues: [] };
  }
  const messages = verifierMessages(scenario, answers, tasks);
  let lastFailure: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = await verifier.complete(messages, { json: true, temperature: 0 });
      const parsed = parseVerifierReply(reply, answers, tasks, scenario);
      if (parsed !== undefined) return { ...parsed, issues: [] };
      lastFailure = 'its reply could not be read';
      log(`could not read the semantic verifier reply (attempt ${attempt + 1})`);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      log(`the semantic verifier failed (attempt ${attempt + 1}): ${lastFailure}`);
    }
  }
  throw new Error(
    `the semantic verifier could not judge this batch after 2 attempts (${lastFailure ?? 'no reason given'})`,
  );
}

/** Create the notetaker; call `run` every 5–10 s while the meeting is on. */
export function createNotetaker({
  scenario,
  tasks,
  llm,
  verifier: verifierClient,
  verify,
  agendaIndex,
  meetingElapsedSeconds,
  onAgendaIndex,
  visitorOwnerShortcut = () => true,
  attendingRoles,
}: NotetakerOptions): Notetaker {
  const verifier = verifierClient ?? llm;
  let pending: TranscriptLine[] = [];
  // The batch being analysed right now; saved with the notetaker so a restart does not lose it.
  let inFlight: TranscriptLine[] | undefined;
  let recentGrounded: TranscriptLine[] = [];
  // Lines already heard on the current agenda item. They carry the accepted decision into later batches, where the
  // line that assigns the follow-up often arrives on its own and would otherwise lose the decision's details.
  let contextAgendaIndex = agendaIndex();
  let agendaContext: TranscriptLine[] = [];
  let running = false;
  let generation = 0;
  let openQuestions: Question[] = [];
  let questionCount = 0;
  let reviewIssues: ReviewIssue[] = [];
  let reviewIssueCount = 0;
  let status: NotetakerStatus = llm === undefined ? 'off' : 'waiting';
  let lastError: string | undefined;
  // How many passes in a row have failed only because the reply had no usable `revisions` list.
  let revisionFailures = 0;
  const talkByItem = new Map<number, Partial<Record<Role, number>>>();
  const talkTotals = new Map<Role, number>();
  let talkTotal = 0;
  const attending = () =>
    attendingRoles?.() ?? new Set(scenario().attendees.map((attendee) => attendee.role));
  // The effective host follows the facilitator seat, so moving or assigning that seat moves the name too.
  const facilitatorName = () => hostIdentityOf(scenario()).name;
  const attendeeNamePattern = () =>
    new RegExp(
      `\\s*\\((?:${scenario()
        .attendees.map((attendee) => attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\)`,
      'g',
    );

  function addTalk(index: number, role: Role, seconds: number): void {
    const item = talkByItem.get(index) ?? {};
    item[role] = (item[role] ?? 0) + seconds;
    talkByItem.set(index, item);
    talkTotals.set(role, (talkTotals.get(role) ?? 0) + seconds);
    talkTotal += seconds;
  }

  function quietRoles(): Role[] {
    if (talkTotal < QUIET_MIN_TOTAL_SECONDS) return [];
    return scenario()
      .roles.filter((role) => role.facilitator !== true)
      .map((role) => role.id)
      .filter((role) => attending().has(role) && (talkTotals.get(role) ?? 0) / talkTotal < QUIET_SHARE);
  }

  function keepPending(lines: TranscriptLine[]): void {
    const overflow = Math.max(0, lines.length - MAX_PENDING_LINES);
    if (overflow > 0) {
      // The queue is full because passes keep failing. Never pretend those lines were analysed: say so at the
      // moment they are lost, not on some later pass that may never come.
      console.error(
        `kaki notetaker: ${overflow} old transcript line(s) cannot be kept for a later pass (limit ${MAX_PENDING_LINES}); ` +
          'the newest lines are kept, the dropped ones will not be analysed',
      );
    }
    pending = lines.slice(-MAX_PENDING_LINES);
  }

  function raiseReviewIssue(text: string, agendaIndex: number): void {
    reviewIssueCount += 1;
    reviewIssues.push({ id: `review-${reviewIssueCount}`, text, agendaIndex });
  }

  /** Resolve a reported reversal to two exact lines that sit on the same agenda item. */
  function resolveRevision(
    revision: RevisionRequest,
    pool: TranscriptLine[],
    itemTitle: string | undefined,
  ): { oldLine: TranscriptLine; changeLine: TranscriptLine } | string {
    const oldLine = exactTranscriptLine(revision.oldDecisionEvidence, pool);
    if (oldLine === undefined) return 'its earlier decision quote is not an exact transcript line';
    const changeLine = exactTranscriptLine(revision.changeEvidence, pool);
    if (changeLine === undefined) return 'its changing line is not an exact transcript line';
    const oldTitle = oldLine.agendaItemTitle ?? itemTitle;
    const changeTitle = changeLine.agendaItemTitle ?? itemTitle;
    if (oldTitle === undefined || changeTitle === undefined || oldTitle !== changeTitle) {
      return 'its quotes are not on the same agenda item';
    }
    return { oldLine, changeLine };
  }

  /**
   * Resolve the cards the model names, without changing anything yet. The plan is committed only after the semantic
   * verifier has answered, so a failed verifier call leaves the batch (and every card) exactly as it was for a retry.
   */
  function planRevisions(
    revisions: RevisionRequest[],
    pool: TranscriptLine[],
    itemTitle: string | undefined,
  ): { removals: Array<{ oldLine: TranscriptLine; targets: Task[] }>; issues: string[] } {
    const removals: Array<{ oldLine: TranscriptLine; targets: Task[] }> = [];
    const issues: string[] = [];
    for (const revision of revisions) {
      const resolved = resolveRevision(revision, pool, itemTitle);
      if (typeof resolved === 'string') {
        issues.push(`A decision reversal was not applied: ${resolved}. Every card was left as it was.`);
        continue;
      }
      const oldDecision = normalize(resolved.oldLine.text);
      const oldTitle = resolved.oldLine.agendaItemTitle ?? itemTitle;
      const targets: Task[] = [];
      let problem: string | undefined;
      for (const id of revision.taskIds) {
        const task = tasks.get(id);
        if (task === undefined) {
          problem = `task ${id} does not exist`;
          break;
        }
        // A card the room already dispatched, claimed or started may still be retired: the decision it carried
        // has been withdrawn, so leaving it would keep sending people to act on the old decision.
        if (!canTransition(task.status, 'SUPERSEDED')) {
          problem = `task ${id} cannot be retired from ${task.status}`;
          break;
        }
        if (task.decisionSource !== undefined) {
          if (normalize(task.decisionSource) !== oldDecision) {
            problem = `task ${id} is linked to a different decision`;
            break;
          }
        } else if (task.agendaItemTitle !== oldTitle) {
          problem = `task ${id} is on a different agenda item`;
          break;
        }
        targets.push(task);
      }
      if (problem !== undefined) {
        issues.push(`A decision reversal was not applied: ${problem}. Every card was left as it was.`);
        continue;
      }
      removals.push({ oldLine: resolved.oldLine, targets });
    }
    return { removals, issues };
  }

  /**
   * Apply a revision plan after a successful pass. A card that cannot be retired leaves its decision in the context.
   */
  function commitRevisions(
    plan: { removals: Array<{ oldLine: TranscriptLine; targets: Task[] }>; issues: string[] },
    atAgendaIndex: number,
  ): Set<TranscriptLine> {
    const removed = new Set<TranscriptLine>();
    for (const issue of plan.issues) raiseReviewIssue(issue, atAgendaIndex);
    for (const { oldLine, targets } of plan.removals) {
      let failed = false;
      for (const task of targets) {
        try {
          tasks.transition(task.id, 'SUPERSEDED');
        } catch (error) {
          failed = true;
          raiseReviewIssue(
            `Could not retire task "${task.title}" after a decision reversal: ${error instanceof Error ? error.message : String(error)}.`,
            atAgendaIndex,
          );
        }
      }
      // The withdrawn decision leaves the context even when no card depended on it, unless a card could not be retired.
      if (!failed) removed.add(oldLine);
    }
    return removed;
  }

  async function apply(
    reply: NotetakerReply,
    batch: TranscriptLine[],
    startedIn: number,
    failedJudgement?: string,
  ): Promise<void> {
    const groundingPool = [...recentGrounded, ...batch];
    const movedTo =
      reply.agendaIndex !== undefined && reply.agendaIndex > agendaIndex()
        ? reply.agendaIndex
        : undefined;
    // A batch that moves the meeting on raises its questions after the hand-over, so they belong to the new item.
    const questionAgendaIndex = movedTo ?? agendaIndex();

    // A reply whose reversal list could not be read is not applied at all: keep every card and decision, publish a
    // specific issue, and still let the agenda move on.
    if (failedJudgement !== undefined) {
      recentGrounded = groundingPool.slice(-MAX_PENDING_LINES);
      raiseReviewIssue(failedJudgement, agendaIndex());
      if (movedTo !== undefined) {
        contextAgendaIndex = movedTo;
        agendaContext = batch.slice(-MAX_AGENDA_CONTEXT_LINES);
        onAgendaIndex?.(movedTo);
      } else {
        agendaContext = [...agendaContext, ...batch].slice(-MAX_AGENDA_CONTEXT_LINES);
      }
      return;
    }

    // Answers are grounded first; only grounded pairs go to the meaning-based verifier.
    const answerCandidates: AnswerCandidate[] = [];
    for (const { id, evidence } of reply.answeredQuestions ?? []) {
      const question = openQuestions.find((item) => item.id === id);
      if (question === undefined) continue;
      const source = groundingLine(evidence, groundingPool);
      if (source === undefined) {
        console.warn(`kaki notetaker: kept question ${id} open; its answer is not in the transcript`);
        continue;
      }
      answerCandidates.push({ id, question, source });
    }
    for (const id of reply.answeredQuestionIds) {
      if (!(reply.answeredQuestions ?? []).some((answer) => answer.id === id)) {
        console.warn(`kaki notetaker: kept question ${id} open; the reply gave no quoted answer`);
      }
    }

    // A withdrawal only retires the cards the model names, and only after both quotes resolve exactly.
    const revisionPool = [...agendaContext, ...batch];
    const itemTitle = scenario().agenda[agendaIndex()]?.title;
    // Plan the reversal now so a withdrawn decision cannot ground a new card, but change nothing until the verifier
    // has answered: a verifier transport failure must leave the batch retryable exactly as it arrived.
    const revisionPlan = planRevisions(reply.revisions, revisionPool, itemTitle);
    const plannedRemoved = new Set(revisionPlan.removals.map((entry) => entry.oldLine));
    const decisionPool =
      movedTo !== undefined
        ? batch.filter((line) => !plannedRemoved.has(line))
        : revisionPool.filter((line) => !plannedRemoved.has(line));

    // Ground each task's line first. The lexical checks below are now only logged backstops; meaning decides.
    const taskCandidates: ResolvedTaskCandidate[] = [];
    for (const [index, candidate] of reply.newTasks.entries()) {
      const { evidence, decisionEvidence, duplicateOf, ...task } = candidate;
      // A verified decision source pins the task to its agenda item, so a generic handover line repeated across items
      // resolves to the copy on the decision's item. Queued lines keep their own stamped origin when this is absent.
      const decisionLine = decisionSourceLineFrom(decisionEvidence, decisionPool);
      let source = groundingLine(evidence, groundingPool, decisionLine?.agendaItemTitle);
      // When the model quotes a line that is missing or makes no assignment (for example an NPC acknowledgement of a
      // promise), fall back to the accepted decision line only on the narrow Mattermost-post path above.
      let ownershipEvidence = evidence;
      if (source === undefined || !hasTaskAssignment(source.text)) {
        if (recoversMattermostDecision(task, decisionLine)) {
          source = decisionLine;
          ownershipEvidence = decisionLine.text;
        }
      }
      if (source === undefined) {
        console.warn(`kaki notetaker: dropped task "${task.title}"; its evidence is not in the transcript`);
        continue;
      }
      // These lexical verdicts no longer gate a card: they are kept only so a disagreement with the model is visible.
      if (!hasTaskAssignment(source.text)) {
        console.warn(
          `kaki notetaker: the lexical check says the evidence line does not assign or volunteer for "${task.title}"; the verifier decides`,
        );
      }
      if (isHypotheticalProposal(source.text)) {
        console.warn(`kaki notetaker: the lexical check sees a hypothetical proposal for "${task.title}"; the verifier decides`);
      }
      if (!taskMatchesAssignment(task, source, groundingPool)) {
        console.warn(
          `kaki notetaker: the lexical check says "${task.title}" does not match the assignment in the transcript; the verifier decides`,
        );
      }
      const lexicalOwner =
        addressedRole(source.text, scenario(), groundingPool, source.role, {
          visitorShortcut: visitorOwnerShortcut(),
        }) ?? volunteerRole(ownershipEvidence, source);
      taskCandidates.push({
        index,
        task,
        source,
        decisionLine,
        ownershipEvidence,
        ...(lexicalOwner === undefined ? {} : { lexicalOwner }),
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
      });
    }

    const verdicts =
      verify !== undefined
        ? await verify(answerCandidates, taskCandidates)
        : verifier === undefined
        ? {
            answers: new Map<string, Verdict>(answerCandidates.map((answer) => [answer.id, 'unclear'])),
            tasks: new Map<number, TaskVerdict>(
              taskCandidates.map((candidate) => [candidate.index, { verdict: 'unclear', assigneeRole: null }]),
            ),
            issues: [],
          }
        : await verifyCandidates(
            verifier,
            scenario(),
            answerCandidates,
            taskCandidates,
            (message) => console.warn(`kaki notetaker: ${message}`),
          );
    if (startedIn !== generation) return; // the meeting was reset while the verifier was thinking

    // The pass is usable now: commit the planned revisions and keep this batch as context for later grounding.
    recentGrounded = groundingPool.slice(-MAX_PENDING_LINES);
    const retired = commitRevisions(revisionPlan, agendaIndex());

    // Close a question only when the verifier says the line states the answer.
    const answered = new Set<string>();
    for (const candidate of answerCandidates) {
      const verdict = verdicts.answers.get(candidate.id) ?? 'unclear';
      const lexicalOk =
        isAffirmativeAnswer(candidate.source.text) &&
        answerMatchesQuestion(candidate.question.text, candidate.source.text);
      if (verdict === 'yes' && !lexicalOk) {
        console.warn(
          `kaki notetaker: the verifier closed ${candidate.id} on a line the lexical backstop would not: "${candidate.source.text}"`,
        );
      } else if (verdict !== 'yes' && lexicalOk) {
        console.warn(
          `kaki notetaker: the verifier answered ${verdict} for ${candidate.id} where the lexical backstop would close it`,
        );
      }
      if (verdict === 'yes') {
        answered.add(candidate.id);
      } else if (verdict === 'unclear') {
        raiseReviewIssue(
          `Could not confirm whether the question "${candidate.question.text}" was answered.`,
          questionAgendaIndex,
        );
      }
    }
    for (const question of openQuestions) {
      if (answered.has(question.id)) console.warn(`kaki notetaker: closed question "${question.text}" as answered`);
    }
    openQuestions = openQuestions.filter((question) => !answered.has(question.id));

    for (const question of reply.newQuestions) {
      // The model decides what is a real question and whether it repeats one already open. These checks are
      // backstops that make a disagreement visible; they never throw away something a person asked.
      if (!question.text.includes('?')) {
        console.warn(`kaki notetaker: "${question.text}" was listed without a question mark; keeping it open`);
      }
      if (isRhetoricalTopicHandoff(question.text)) {
        console.warn(`kaki notetaker: "${question.text}" looks like a discussion prompt; keeping it open`);
      }
      if (isLikelyDuplicateQuestion(question.text, openQuestions.map((open) => open.text))) {
        console.warn(`kaki notetaker: "${question.text}" looks like a question already open; keeping it open`);
      }
      questionCount += 1;
      openQuestions.push({ id: `q-${questionCount}`, agendaIndex: questionAgendaIndex, ...question });
    }

    for (const candidate of taskCandidates) {
      const { task, source, decisionLine } = candidate;
      const verdict = verdicts.tasks.get(candidate.index) ?? { verdict: 'unclear' as const, assigneeRole: null };
      if (verdict.verdict === 'no') {
        console.warn(`kaki notetaker: dropped task "${task.title}"; the verifier says the line does not assign it`);
        continue;
      }
      if (verdict.verdict !== 'yes' || verdict.assigneeRole === null) {
        raiseReviewIssue(
          `Could not confirm whether "${task.title}" was agreed or assigned.`,
          questionAgendaIndex,
        );
        continue;
      }
      // The verifier names the owner. The old lexical owner check is kept only so a disagreement is visible.
      if (candidate.lexicalOwner !== verdict.assigneeRole) {
        console.warn(
          `kaki notetaker: the verifier gives "${task.title}" to ${verdict.assigneeRole}, the lexical backstop says ${candidate.lexicalOwner ?? 'no one'}`,
        );
      }
      const owner = verdict.assigneeRole;
      const duplicateTarget = candidate.duplicateOf === undefined ? undefined : tasks.get(candidate.duplicateOf);
      const activeDuplicateOf =
        duplicateTarget !== undefined && duplicateTarget.status !== 'DISMISSED' ? duplicateTarget : undefined;
      const namePattern = attendeeNamePattern();
      let cleanedTitle = task.title.replace(namePattern, '');
      let cleanedContext = task.context.replace(namePattern, '');
      for (const attendee of scenario().attendees) {
        const visitorLine = groundingPool.find(
          (line) => line.role === attendee.role && line.speaker !== undefined && !line.speaker.startsWith(attendee.name),
        );
        if (visitorLine?.speaker !== undefined) {
          const visitorName = visitorLine.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
          const escaped = attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\b${escaped}\\b`, 'g');
          cleanedTitle = cleanedTitle.replace(re, visitorName);
          cleanedContext = cleanedContext.replace(re, visitorName);
        }
      }
      const baseTask =
        cleanedTitle === task.title && cleanedContext === task.context
          ? task
          : { ...task, title: cleanedTitle, context: cleanedContext };
      const owned = { ...baseTask, suggestedAssignee: owner };
      const decisionSource = decisionLine?.text;
      const withDecision = decisionSource === undefined ? owned : { ...owned, decisionSource };
      const withOrigin =
        source.agendaItemTitle === undefined
          ? withDecision
          : { ...withDecision, agendaItemTitle: source.agendaItemTitle };
      // Only the model decides that a new card is the same work as an existing one, by naming it in duplicateOf.
      // Word overlap and shared decision quotes are backstops; they log a disagreement but never merge people's work.
      const existingTasks = tasks.list();
      if (isLikelyDuplicate(withOrigin, existingTasks)) {
        console.warn(
          `kaki notetaker: "${task.title}" looks like a reworded card for the same owner; keeping it because the model decides duplicates`,
        );
      }
      if (isDuplicateAnnouncement(withOrigin, existingTasks)) {
        console.warn(
          `kaki notetaker: "${task.title}" announces a decision another card covers; keeping it because the model decides duplicates`,
        );
      }
      if (activeDuplicateOf !== undefined) {
        if (isDuplicateTarget(withOrigin, activeDuplicateOf)) {
          console.warn(`kaki notetaker: dropped task "${task.title}"; it duplicates ${activeDuplicateOf.id}`);
          continue;
        }
        console.warn(
          `kaki notetaker: ignored duplicateOf ${activeDuplicateOf.id} for "${task.title}"; it names a different task`,
        );
      }
      try {
        tasks.suggest(
          withOrigin,
          selfVolunteeredAssignment(source, withOrigin, scenario()),
          source.atSeconds,
        );
      } catch (error) {
        console.error('kaki notetaker: could not suggest a task', error);
      }
    }

    // Keep the current item's lines for the next pass. A withdrawn decision's own line is dropped, and nothing else.
    if (movedTo !== undefined) {
      contextAgendaIndex = movedTo;
      agendaContext = batch.filter((line) => !retired.has(line)).slice(-MAX_AGENDA_CONTEXT_LINES);
    } else {
      agendaContext = revisionPool.filter((line) => !retired.has(line)).slice(-MAX_AGENDA_CONTEXT_LINES);
    }
    if (movedTo !== undefined) onAgendaIndex?.(movedTo);
  }

  return {
    addChunk({ speaker, text, speakerRole, overlap }) {
      const role =
        speakerRole !== undefined
          ? isRoleIn(scenario(), speakerRole)
            ? speakerRole
            : undefined
          : roleForZoomName(scenario(), speaker);
      if (role !== undefined) addTalk(agendaIndex(), role, estimateTalkSeconds(text));
      if (llm === undefined) return;
      const isFacilitator = role !== undefined && scenario().roles.some((candidate) => candidate.id === role && candidate.facilitator === true);
      const speakerName = speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const hostName = facilitatorName();
      if (isFacilitator && hostName !== undefined && speakerName === hostName) {
        // When the AI facilitator explicitly asks the visitor by name for a post-meeting follow-up deliverable ("Ben, could you post that decision in the team channel today so everyone has it?"),
        // keep that line so the notetaker extracts the task even if the LLM put the task request on the facilitator's line.
        const isTaskRequestFromSam = new RegExp(
          `\\b(?:(?:can|could|would|will)\\s+you|(?:do\\s+you\\s+)?mind|let'?s\\s+have\\s+you)\\s+(?:[\\w'-]+,?\\s+){0,8}(?:${DELIVERABLE_FORM}|handle|handling|sort out|sorting out|take care of|taking care of|take on|taking on|take the lead on|taking the lead on)\\b`,
          'i',
        ).test(text);
        if (!isTaskRequestFromSam) return;
      }
      const agendaItemTitle = scenario().agenda[agendaIndex()]?.title;
      const atSeconds = meetingElapsedSeconds?.();
      keepPending([
        ...pending,
        {
          ...(role === undefined ? {} : { role }),
          speaker,
          text,
          ...(agendaItemTitle === undefined ? {} : { agendaItemTitle }),
          ...(atSeconds === undefined ? {} : { atSeconds }),
          ...(overlap === true ? { overlap: true } : {}),
        },
      ]);
    },

    async run() {
      if (llm === undefined || running || pending.length === 0) return;
      running = true;
      const batch = pending;
      pending = [];
      inFlight = batch;
      const startedIn = generation;
      const currentAgendaIndex = agendaIndex();
      if (currentAgendaIndex !== contextAgendaIndex) {
        contextAgendaIndex = currentAgendaIndex;
        agendaContext = [];
      }

      let succeeded = false;
      try {
        const replySchema = notetakerReplySchema(scenario());
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt(scenario(), [...recentGrounded, ...batch]) },
          {
            role: 'user',
            content: userPrompt(scenario(), currentAgendaIndex, openQuestions, tasks.list(), agendaContext, batch),
          },
        ];
        let reply = parseNotetakerReply(await llm.complete(messages, { json: true, schema: replySchema }), scenario());
        if (startedIn !== generation) return; // the meeting was reset while the model was thinking
        if (reply.revisionsError !== undefined) {
          // A broken reversal list is retried once before the pass counts as failed.
          console.warn(`kaki notetaker: ${reply.revisionsError}; asking once more`);
          reply = parseNotetakerReply(await llm.complete(messages, { json: true, schema: replySchema }), scenario());
          if (startedIn !== generation) return;
        }
        if (reply.revisionsError !== undefined) {
          revisionFailures += 1;
          if (revisionFailures < REVISION_FAILURE_LIMIT) {
            // Never consume a batch whose reversals could not be read: keep its lines and try them again.
            keepPending([...batch, ...pending]);
            status = 'stale';
            lastError = reply.revisionsError;
            console.warn(
              `kaki notetaker: ${reply.revisionsError}; keeping these lines for another pass ` +
                `(${revisionFailures}/${REVISION_FAILURE_LIMIT})`,
            );
          } else {
            // Give the lines a visible exit so the meeting can never stall on them. Today's behaviour:
            // no card or decision changes, one review issue goes on the record, and the agenda may move on.
            await apply(
              reply,
              batch,
              startedIn,
              `The notetaker could not tell whether a decision was withdrawn or replaced (${reply.revisionsError}). Every card and decision was left as it was.`,
            );
            if (startedIn !== generation) return;
            status = 'stale';
            lastError = reply.revisionsError;
            revisionFailures = 0;
            console.warn(
              `kaki notetaker: giving up on these lines after ${REVISION_FAILURE_LIMIT} failed passes; ${reply.revisionsError}`,
            );
            succeeded = true;
          }
        } else {
          await apply(reply, batch, startedIn);
          if (startedIn !== generation) return;
          status = 'ok';
          lastError = undefined;
          revisionFailures = 0;
          succeeded = true;
        }
      } catch (error) {
        if (startedIn !== generation) return;
        // Keep the last good record and try these lines again on the next pass.
        keepPending([...batch, ...pending]);
        status = 'stale';
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`kaki notetaker: keeping the last good record; ${lastError}`);
      } finally {
        running = false;
        inFlight = undefined;
      }
      if (succeeded && startedIn === generation && pending.length > 0) {
        void this.run();
      }
    },

    reset() {
      generation += 1;
      pending = [];
      inFlight = undefined;
      recentGrounded = [];
      contextAgendaIndex = agendaIndex();
      agendaContext = [];
      openQuestions = [];
      questionCount = 0;
      reviewIssues = [];
      reviewIssueCount = 0;
      status = llm === undefined ? 'off' : 'waiting';
      lastError = undefined;
      revisionFailures = 0;
      talkByItem.clear();
      talkTotals.clear();
      talkTotal = 0;
    },

    snapshot() {
      return {
        pending: pending.map((line) => ({ ...line })),
        inFlight: (inFlight ?? []).map((line) => ({ ...line })),
        recentGrounded: recentGrounded.map((line) => ({ ...line })),
        contextAgendaIndex,
        agendaContext: agendaContext.map((line) => ({ ...line })),
        openQuestions: openQuestions.map((question) => ({ ...question })),
        questionCount,
        reviewIssues: reviewIssues.map((issue) => ({ ...issue })),
        reviewIssueCount,
        status,
        ...(lastError === undefined ? {} : { lastError }),
        revisionFailures,
        talkByItem: [...talkByItem.entries()].map(
          ([index, talk]): [number, Partial<Record<Role, number>>] => [index, { ...talk }],
        ),
        talkTotals: [...talkTotals.entries()],
        talkTotal,
      };
    },

    restore(saved) {
      generation += 1;
      // The saved batch was older than anything still pending, so it is analysed first again.
      pending = [...saved.inFlight, ...saved.pending].map((line) => ({ ...line }));
      inFlight = undefined;
      recentGrounded = saved.recentGrounded.map((line) => ({ ...line }));
      contextAgendaIndex = saved.contextAgendaIndex;
      agendaContext = saved.agendaContext.map((line) => ({ ...line }));
      openQuestions = saved.openQuestions.map((question) => ({ ...question }));
      questionCount = saved.questionCount;
      reviewIssues = (saved.reviewIssues ?? []).map((issue) => ({ ...issue }));
      reviewIssueCount = saved.reviewIssueCount ?? reviewIssues.length;
      status = llm === undefined ? 'off' : saved.status;
      lastError = saved.lastError;
      revisionFailures = saved.revisionFailures ?? 0;
      talkByItem.clear();
      for (const [index, talk] of saved.talkByItem) talkByItem.set(index, { ...talk });
      talkTotals.clear();
      for (const [role, seconds] of saved.talkTotals) talkTotals.set(role, seconds);
      talkTotal = saved.talkTotal;
      running = false;
    },

    state() {
      return {
        openQuestions: [...openQuestions],
        reviewIssues: [...reviewIssues],
        talkSecondsFor: (index) => ({ ...(talkByItem.get(index) ?? {}) }),
        quietRoles: quietRoles(),
        status,
        lastError,
      };
    },
  };
}
