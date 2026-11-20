import type { Role } from './roles';
import { isRoleIn, type Scenario } from './scenario';
import { isRunnerMeetingSnapshot, type RunnerMeetingSnapshot } from './runnerMeeting';
import type { Fact } from './services';
import { isTask, type Task } from './task';

/** Who should receive an event: the shared screen, one role's phone, everyone, or the AI runner only. */
export type Audience =
  | { kind: 'screen' }
  | { kind: 'role'; role: Role }
  | { kind: 'all' }
  | { kind: 'service' };

/** An open question in the meeting record, optionally owned by one role. */
export interface Question {
  id: string;
  text: string;
  forRole?: Role;
  /** The agenda item the question was raised on; consumers act only on the current item's questions. */
  agendaIndex: number;
}

/**
 * How the notetaker's last LLM pass went: still waiting for its first pass, ok, stale (the last
 * pass failed, so questions and tasks may be out of date), or off (no LLM configured).
 */
export type NotetakerStatus = 'waiting' | 'ok' | 'stale' | 'off';

/** Every notetaker status. */
export const NOTETAKER_STATUSES: readonly NotetakerStatus[] = ['waiting', 'ok', 'stale', 'off'];

/**
 * A judgement the notetaker could not make (a reversal, an answer's meaning, or a follow-up assignment)
 * after its one retry. Cards and decisions are left as they were; the room can resolve it later.
 */
export interface ReviewIssue {
  id: string;
  text: string;
  /** The agenda item the doubtful evidence belongs to. */
  agendaIndex: number;
}

/** The event types the meeting protocol knows about. */
export type KakiEventType =
  | 'TRANSCRIPT_CHUNK'
  | 'TRANSCRIPT_LINE_UPDATED'
  | 'MEETING_RECORD_UPDATED'
  | 'HOST_SPEECH_TRIGGERED'
  | 'NUDGE'
  | 'FACT_FOUND'
  | 'TASK_UPDATED'
  | 'MEETING_STARTED'
  | 'MEETING_RESET'
  | 'MEETING_RESTORED'
  | 'RUNNER_STATE'
  | 'SPEECH_RECORDING'
  | 'TOPIC_SETTLED'
  | 'COLLEAGUE_REACTION'
  | 'COMMAND_REJECTED';

type KakiEventOf<T extends KakiEventType, P> = { type: T; payload: P; audience: Audience };

/** One message on the Kaki meeting protocol, with its audience. */
export type KakiEvent =
  | KakiEventOf<
      'TRANSCRIPT_CHUNK',
      {
        speaker: string;
        text: string;
        timestamp: string;
        textOnly?: boolean;
        /** The real catch this line raises, from the scenario's discussion (`<topicIndex>:catch:<i>`). */
        catchId?: string;
        /** A host gate the line itself carries, so tools need not guess it from the wording. */
        gate?: 'lock-offer';
        /** The seat that spoke, so a renamed display name still counts as that role. */
        speakerRole?: Role;
        /** Stable id for one spoken line, so a later update replaces that line instead of adding another. */
        lineId?: string;
        /** When the speech itself began (ISO), so lines can be ordered by when they were said. */
        speechStartedAt?: string;
        /** When the speech itself ended (ISO). */
        speechEndedAt?: string;
        /** True when this person started speaking before the previous human line had finished. */
        overlap?: boolean;
      }
    >
  /**
   * A display-only change to a line already spoken: the words the room heard before an interruption, or
   * the full line once it resumes. Record keepers ignore it, so a cut and resumed line is recorded once.
   */
  | KakiEventOf<
      'TRANSCRIPT_LINE_UPDATED',
      {
        /** The `lineId` of the TRANSCRIPT_CHUNK this replaces. */
        lineId: string;
        speaker: string;
        text: string;
        timestamp: string;
        /** True when the room only heard part of the line before it was interrupted. */
        cut: boolean;
      }
    >
  | KakiEventOf<
      'MEETING_RECORD_UPDATED',
      {
        agendaIndex: number;
        openQuestions: Question[];
        /** Seconds since the current agenda item started (not since the meeting started). */
        elapsedSeconds: number;
        /** Talk time per role during the current agenda item. */
        speakerTalkSeconds: Partial<Record<Role, number>>;
        /** Optional: whether open questions and tasks are up to date. */
        notetakerStatus?: NotetakerStatus;
        /** Optional: attendee roles that have barely spoken so far. */
        quietRoles?: Role[];
        /** Optional: whether the meeting clock is currently paused by the visitor. */
        paused?: boolean;
        /** Why the meeting is paused, so a phone's button reflects an empty-room pause too. */
        pauseKind?: 'empty-room' | 'person';
        /** True once the meeting clock has ended, so a screen that connects after a restart still shows the meeting as over. */
        ended?: boolean;
        /** Judgements the notetaker could not make; cards and questions were left unchanged. */
        reviewIssues?: ReviewIssue[];
      }
    >
  | KakiEventOf<
      'HOST_SPEECH_TRIGGERED',
      {
        kind: 'OPENING' | 'TIMEOUT' | 'CLOSING' | 'DISPATCH';
        text: string;
        /** DISPATCH only: who the task went to and what it is, so the voice can say it differently to an AI colleague. */
        assignee?: string;
        title?: string;
        /** DISPATCH only: the exact task, so cues for two tasks with the same title never collide. */
        taskId?: string;
      }
    >
  | KakiEventOf<'NUDGE', { text: string; agendaIndex: number }>
  | KakiEventOf<'FACT_FOUND', { questionId: string; question: string; facts: Fact[]; agendaIndex: number }>
  | KakiEventOf<'TASK_UPDATED', { task: Task }>
  /**
   * The meeting has started: the agenda clock runs from here and late joiners go straight in.
   * `agendaIndex` and `resumed` let a runner restored after a restart open the saved item without
   * replaying the welcome or resetting to item zero.
   */
  | KakiEventOf<'MEETING_STARTED', { meetingId: string; startedAt: string; agendaIndex?: number; resumed?: boolean }>
  /** A new meeting is starting: pages drop the old record, feed and tasks. */
  | KakiEventOf<'MEETING_RESET', { meetingId: string }>
  /** The server kept this meeting across a restart; the screen says so and offers a fresh start. */
  | KakiEventOf<'MEETING_RESTORED', { startedAt: string }>
  /** The one meeting snapshot the AI runner reads; service-only and retained for reconnects. */
  | KakiEventOf<'RUNNER_STATE', RunnerMeetingSnapshot>
  /** Whether the default server-side recogniser is running, so people know their speech is not being recorded. */
  | KakiEventOf<'SPEECH_RECORDING', { recording: boolean }>
  /** Live demo: the visitor's decision on an agenda item is locked; tasks held for that item may go out, `taskId` first. */
  | KakiEventOf<'TOPIC_SETTLED', { title: string; taskId?: string }>
  | KakiEventOf<'COLLEAGUE_REACTION', { who: string; emoji: '👍' | '😬' | '🤔' | '😅' | '🙌' | '💸' | '🤨' | '⏰'; timestamp: string }>
  | KakiEventOf<'COMMAND_REJECTED', { commandType: string; reason: string }>;

const KAKI_EVENT_TYPES: readonly KakiEventType[] = [
  'TRANSCRIPT_CHUNK',
  'TRANSCRIPT_LINE_UPDATED',
  'MEETING_RECORD_UPDATED',
  'HOST_SPEECH_TRIGGERED',
  'NUDGE',
  'FACT_FOUND',
  'TASK_UPDATED',
  'MEETING_STARTED',
  'MEETING_RESET',
  'MEETING_RESTORED',
  'RUNNER_STATE',
  'SPEECH_RECORDING',
  'TOPIC_SETTLED',
  'COLLEAGUE_REACTION',
  'COMMAND_REJECTED',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim() !== '';
}

// True for a finite number that is zero or more.
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// True for a whole-number agenda position, zero or more.
function isAgendaIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// True when every key is a role in the scenario and every value is a finite, non-negative number.
function isSpeakerTalkSeconds(value: unknown, scenario: Scenario): value is Partial<Record<Role, number>> {
  return (
    isObject(value) &&
    Object.entries(value).every(([role, seconds]) => isRoleIn(scenario, role) && isNonNegativeFinite(seconds))
  );
}

function isNotetakerStatus(value: unknown): value is NotetakerStatus {
  return typeof value === 'string' && (NOTETAKER_STATUSES as readonly string[]).includes(value);
}

function isFact(value: unknown): value is Fact {
  return isObject(value) && isString(value.text) && isString(value.source) && isString(value.date);
}

function isReviewIssue(value: unknown): value is ReviewIssue {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.text) &&
    isAgendaIndex(value.agendaIndex)
  );
}

function isQuestion(value: unknown, scenario: Scenario): value is Question {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.text) &&
    isAgendaIndex(value.agendaIndex) &&
    (value.forRole === undefined || isRoleIn(scenario, value.forRole))
  );
}

function isAudience(value: unknown, scenario: Scenario): value is Audience {
  if (!isObject(value)) return false;
  if (value.kind === 'screen' || value.kind === 'all' || value.kind === 'service') return true;
  return value.kind === 'role' && isRoleIn(scenario, value.role);
}

function isKnownEventType(value: unknown): value is KakiEventType {
  return typeof value === 'string' && (KAKI_EVENT_TYPES as readonly string[]).includes(value);
}

type PayloadCheck = (payload: Record<string, unknown>, scenario: Scenario) => boolean;

const PAYLOAD_CHECKS: Record<KakiEventType, PayloadCheck> = {
  TRANSCRIPT_CHUNK: (payload, scenario) =>
    isString(payload.speaker) &&
    isString(payload.text) &&
    isString(payload.timestamp) &&
    (payload.textOnly === undefined || typeof payload.textOnly === 'boolean') &&
    (payload.catchId === undefined || isString(payload.catchId)) &&
    (payload.gate === undefined || payload.gate === 'lock-offer') &&
    (payload.speakerRole === undefined || isRoleIn(scenario, payload.speakerRole)) &&
    (payload.lineId === undefined || isString(payload.lineId)) &&
    (payload.speechStartedAt === undefined ||
      (isString(payload.speechStartedAt) && Number.isFinite(Date.parse(payload.speechStartedAt)))) &&
    (payload.speechEndedAt === undefined ||
      (isString(payload.speechEndedAt) && Number.isFinite(Date.parse(payload.speechEndedAt)))) &&
    (payload.overlap === undefined || typeof payload.overlap === 'boolean'),
  TRANSCRIPT_LINE_UPDATED: (payload) =>
    isNonEmptyString(payload.lineId) &&
    isString(payload.speaker) &&
    isString(payload.text) &&
    isString(payload.timestamp) &&
    Number.isFinite(Date.parse(payload.timestamp)) &&
    typeof payload.cut === 'boolean',
  MEETING_RECORD_UPDATED: (payload, scenario) =>
    Number.isInteger(payload.agendaIndex) &&
    Array.isArray(payload.openQuestions) &&
    payload.openQuestions.every((question) => isQuestion(question, scenario)) &&
    isNonNegativeFinite(payload.elapsedSeconds) &&
    isSpeakerTalkSeconds(payload.speakerTalkSeconds, scenario) &&
    (payload.notetakerStatus === undefined || isNotetakerStatus(payload.notetakerStatus)) &&
    (payload.quietRoles === undefined ||
      (Array.isArray(payload.quietRoles) && payload.quietRoles.every((role) => isRoleIn(scenario, role)))) &&
    (payload.paused === undefined || typeof payload.paused === 'boolean') &&
    (payload.pauseKind === undefined || payload.pauseKind === 'empty-room' || payload.pauseKind === 'person') &&
    (payload.reviewIssues === undefined ||
      (Array.isArray(payload.reviewIssues) && payload.reviewIssues.every(isReviewIssue))),
  HOST_SPEECH_TRIGGERED: (payload) =>
    (payload.kind === 'OPENING' ||
      payload.kind === 'TIMEOUT' ||
      payload.kind === 'CLOSING' ||
      payload.kind === 'DISPATCH') &&
    isString(payload.text) &&
    (payload.taskId === undefined || isNonEmptyString(payload.taskId)),
  NUDGE: (payload) => isString(payload.text) && isAgendaIndex(payload.agendaIndex),
  FACT_FOUND: (payload) =>
    isString(payload.questionId) &&
    isString(payload.question) &&
    Array.isArray(payload.facts) &&
    payload.facts.every(isFact) &&
    isAgendaIndex(payload.agendaIndex),
  TASK_UPDATED: (payload, scenario) => isTask(payload.task, scenario),
  MEETING_STARTED: (payload) =>
    isNonEmptyString(payload.meetingId) &&
    isString(payload.startedAt) &&
    Number.isFinite(Date.parse(payload.startedAt)) &&
    (payload.agendaIndex === undefined || isAgendaIndex(payload.agendaIndex)) &&
    (payload.resumed === undefined || typeof payload.resumed === 'boolean'),
  MEETING_RESET: (payload) => isNonEmptyString(payload.meetingId),
  MEETING_RESTORED: (payload) => isString(payload.startedAt) && Number.isFinite(Date.parse(payload.startedAt)),
  RUNNER_STATE: (payload) => isRunnerMeetingSnapshot(payload),
  SPEECH_RECORDING: (payload) => typeof payload.recording === 'boolean',
  TOPIC_SETTLED: (payload) => isString(payload.title) && (payload.taskId === undefined || isString(payload.taskId)),
  COLLEAGUE_REACTION: (payload, scenario) =>
    isString(payload.who) && scenario.npcs?.some((npc) => npc.attendee === payload.who) === true &&
    isString(payload.emoji) && ['👍', '😬', '🤔', '😅', '🙌', '💸', '🤨', '⏰'].includes(payload.emoji) &&
    isString(payload.timestamp) && Number.isFinite(Date.parse(payload.timestamp)),
  COMMAND_REJECTED: (payload) => isString(payload.commandType) && isString(payload.reason),
};

/** Validate unknown data (such as JSON from a socket) as a complete KakiEvent for the scenario. */
export function isKakiEvent(value: unknown, scenario: Scenario): value is KakiEvent {
  if (!isObject(value)) return false;
  const { type, payload, audience } = value;
  if (!isKnownEventType(type) || !isObject(payload) || !isAudience(audience, scenario)) return false;
  if (!PAYLOAD_CHECKS[type](payload, scenario)) return false;
  if ((type === 'NUDGE' || type === 'FACT_FOUND') && audience.kind !== 'role') return false;
  if (type === 'COLLEAGUE_REACTION' && audience.kind !== 'all') return false;
  if (type === 'RUNNER_STATE' && audience.kind !== 'service') return false;
  return true;
}
