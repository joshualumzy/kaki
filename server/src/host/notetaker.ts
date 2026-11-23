import {
  canTransition,
  isRoleIn,
  roleForDisplayName,
  speakerName,
  type NotetakerStatus,
  type Question,
  type ReviewIssue,
  type Role,
  type Scenario,
  type Task,
} from '@kaki/shared';
import { type ChatMessage, type LlmClient } from '../services/llm';
import type { SavedNotetakerState } from '../persist/state';
import type { TaskStore } from '../meeting/tasks';
import { estimateTalkSeconds, normalize, type TranscriptLine } from './notetakerText';
import {
  answerMatchesQuestion,
  isAffirmativeAnswer,
  isExactDuplicateQuestion,
  isLikelyDuplicateQuestion,
  isRhetoricalTopicHandoff,
  type AnswerCandidate,
  type NewQuestionCandidate,
} from './notetakerQuestions';
import {
  addressedRole,
  decisionSourceLineFrom,
  groundingLine,
  hasTaskAssignment,
  isDuplicateAnnouncement,
  isDuplicateTarget,
  isHypotheticalProposal,
  isLikelyDuplicate,
  recoversMattermostDecision,
  selfVolunteeredAssignment,
  settledFollowUpCard,
  taskMatchesAssignment,
  volunteerRole,
  type ResolvedTaskCandidate,
} from './notetakerTasks';
import {
  exactTranscriptLine,
  notetakerReplySchema,
  parseNotetakerReply,
  systemPrompt,
  userPrompt,
  type NotetakerReply,
  type RevisionRequest,
} from './notetakerPrompt';
import {
  verifyCandidates,
  type TaskVerdict,
  type Verdict,
  type VerifierResult,
} from './notetakerVerifier';

/** A role is quiet when it has under this share of talk time... */
const QUIET_SHARE = 0.1;
/** ...once the meeting has at least this much talk overall. */
const QUIET_MIN_TOTAL_SECONDS = 60;
/** Unsent lines kept while the LLM is down; older ones are dropped. */
const MAX_PENDING_LINES = 200;
/** Earlier lines kept as decision context for the current agenda item. */
const MAX_AGENDA_CONTEXT_LINES = 80;
/** Extra passes allowed when the model leaves out the required `revisions` list; after this it is given up on. */
const REVISION_FAILURE_LIMIT = 2;
/** A pass that takes longer than this while lines wait counts as slow: everyone sees the notes catching up. */
const DEFAULT_SLOW_PASS_MS = 30_000;
/** The notetaker's part of the Meeting Record. */
interface NotetakerState {
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
interface Notetaker {
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
interface NotetakerOptions {
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
  /** Called when the notes start or stop falling behind; the room shows its own plain-words notice. */
  onPausedChange?: (paused: boolean) => void;
  /** How long a pass may run before the notes count as paused; defaults to 30 s. */
  slowPassMs?: number;
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
  onPausedChange,
  slowPassMs = DEFAULT_SLOW_PASS_MS,
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
  // True while a pass has failed or is taking so long that its lines are visibly waiting.
  let paused = false;
  let slowPassTimer: ReturnType<typeof setTimeout> | undefined;
  const talkByItem = new Map<number, Partial<Record<Role, number>>>();
  const talkTotals = new Map<Role, number>();
  let talkTotal = 0;
  const attending = () =>
    attendingRoles?.() ?? new Set(scenario().attendees.map((attendee) => attendee.role));
  const attendeeNamePattern = () =>
    new RegExp(
      `\\s*\\((?:${scenario()
        .attendees.map((attendee) => attendee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\)`,
      'g',
    );

  /** Tell the room when the notes fall behind; the notice is the caller's, so this only reports the state. */
  function setPaused(next: boolean): void {
    if (paused === next) return;
    paused = next;
    try {
      onPausedChange?.(next);
    } catch (error) {
      console.error('kaki notetaker: reporting the notes state failed', error);
    }
  }

  function clearSlowPassTimer(): void {
    if (slowPassTimer === undefined) return;
    clearTimeout(slowPassTimer);
    slowPassTimer = undefined;
  }

  /** A pass that is still running after the limit is visible as paused, never silently stuck. */
  function startSlowPassTimer(startedIn: number): void {
    clearSlowPassTimer();
    slowPassTimer = setTimeout(() => {
      slowPassTimer = undefined;
      if (startedIn !== generation || !running) return;
      console.warn(
        `kaki notetaker: the model call has not finished after ${Math.round(slowPassMs / 1000)} s; ` +
          'notes are paused and new lines are queued for the next pass',
      );
      setPaused(true);
    }, slowPassMs);
    slowPassTimer.unref?.();
  }

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

    // Exact repeats are settled by the text itself; only the rest need the model's meaning check.
    const openQuestionTexts = openQuestions.map((question) => question.text);
    const newQuestionCandidates: NewQuestionCandidate[] = reply.newQuestions.flatMap((question, index) =>
      isExactDuplicateQuestion(question.text, openQuestionTexts) ? [] : [{ index, text: question.text }],
    );

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
            newQuestionCandidates,
            openQuestions,
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

    for (const [index, question] of reply.newQuestions.entries()) {
      const openTexts = openQuestions.map((open) => open.text);
      // The lexical checks are backstops only: they make a disagreement visible, but meaning decides.
      if (isLikelyDuplicateQuestion(question.text, openTexts)) {
        console.warn(`kaki notetaker: "${question.text}" looks like a question already open; checking before adding`);
      }
      if (isExactDuplicateQuestion(question.text, openTexts)) {
        console.warn(`kaki notetaker: "${question.text}" is word for word a question already open; not adding it again`);
        continue;
      }
      const duplicateOf = verdicts.questionDuplicates?.get(index);
      const repeated =
        typeof duplicateOf === 'string' ? openQuestions.find((open) => open.id === duplicateOf) : undefined;
      if (repeated !== undefined) {
        console.warn(
          `kaki notetaker: "${question.text}" asks the same thing as open question ${repeated.id}; not adding it again`,
        );
        continue;
      }
      if (!question.text.includes('?')) {
        console.warn(`kaki notetaker: "${question.text}" was listed without a question mark; keeping it open`);
      }
      if (isRhetoricalTopicHandoff(question.text)) {
        console.warn(`kaki notetaker: "${question.text}" looks like a discussion prompt; keeping it open`);
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
          const visitorName = speakerName(visitorLine.speaker);
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
      // One decision gives one follow-up per deliverable and owner. The settlement card already is that follow-up
      // for this topic, so a later suggestion of the same kind for the same owner is the same card however the
      // decision was worded (a self-correction can change the quote without changing the follow-up).
      const occupied = settledFollowUpCard(withOrigin, existingTasks);
      if (occupied !== undefined) {
        console.warn(
          `kaki notetaker: dropped task "${task.title}"; ${occupied.id} already covers ${withOrigin.actionKind} ` +
            `on this topic for ${withOrigin.suggestedAssignee}`,
        );
        continue;
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
          : roleForDisplayName(scenario(), speaker);
      if (role !== undefined) addTalk(agendaIndex(), role, estimateTalkSeconds(text));
      if (llm === undefined) return;
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
      startSlowPassTimer(startedIn);
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
            setPaused(true);
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
            // The lines no longer wait; the review issue on the record is the visible outcome.
            setPaused(false);
            succeeded = true;
          }
        } else {
          await apply(reply, batch, startedIn);
          if (startedIn !== generation) return;
          status = 'ok';
          lastError = undefined;
          revisionFailures = 0;
          setPaused(false);
          succeeded = true;
        }
      } catch (error) {
        if (startedIn !== generation) return;
        // Keep the last good record and try these lines again on the next pass.
        keepPending([...batch, ...pending]);
        status = 'stale';
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(`kaki notetaker: keeping the last good record; ${lastError}`);
        setPaused(true);
      } finally {
        clearSlowPassTimer();
        running = false;
        inFlight = undefined;
      }
      if (succeeded && startedIn === generation && pending.length > 0) {
        void this.run();
      }
    },

    reset() {
      generation += 1;
      clearSlowPassTimer();
      setPaused(false);
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
      clearSlowPassTimer();
      setPaused(false);
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
