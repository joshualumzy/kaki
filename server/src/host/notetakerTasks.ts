import {
  speakerName,
  type AssignmentEvidence,
  type Role,
  type Scenario,
  type SuggestInput,
  type Task,
} from '@kaki/shared';
import { FILLER_WORDS, keywords, normalize, words, type TranscriptLine } from './notetakerText';

/** Share of a task's evidence words that must appear in one transcript line. */
const EVIDENCE_MATCH = 0.8;
/** Share of keywords two tasks for the same role must share to count as the same task. */
const DUPLICATE_OVERLAP = 0.6;
/** A task the LLM proposes, with the words it heard it in. */
export interface TaskCandidate extends SuggestInput {
  evidence: string;
  /** The accepted decision line the LLM says this task announces, if any; it is checked against the transcript. */
  decisionEvidence?: string;
  duplicateOf?: string;
}
/** A proposed task matched to its evidence line and checked owner, ready for the verifier. */
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
export function decisionSourceLineFrom(
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
  const self = speakerName(speaker).toLowerCase();
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
export const DELIVERABLE_FORM =
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

/** True when a verified decision line lets a Mattermost post task stand without its own assignment evidence. */
export function recoversMattermostDecision(
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
  return speakerName(speaker).toLowerCase();
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
