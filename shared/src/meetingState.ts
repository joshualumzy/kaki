import { isNonEmptyString, isObject, isString } from './guards';

/** A stretch of a real meeting that was off the record, with no content kept. */
export interface OffTheRecordSpan {
  /** ISO time the room went off the record. */
  from: string;
  /** ISO time the room came back on the record. */
  to: string;
}

/** Set while the room is off the record. */
export interface OffTheRecordState {
  /** ISO time the room went off the record. */
  since: string;
}

/** One person in the meeting, as the shared state snapshot shows them. */
export interface MeetingStateParticipant {
  /** The identity the transcript uses (lowercase, canonical). */
  name: string;
  /** The name exactly as the person joined with. */
  displayName: string;
  /** The seat they hold. */
  seat: string;
  /** Their Google photo, or null when they have none. */
  photoUrl: string | null;
}

/** A quiet note about the agenda clock, for real meetings where Kaki never speaks aloud. */
export interface MeetingStateCue {
  text: string;
  at: string;
}

/** The one meeting state every participant receives; the server replaces it wholesale on changes. */
export interface MeetingStateSnapshot {
  meetingId: string;
  phase: 'lobby' | 'starting' | 'running' | 'ended';
  kind?: 'real' | 'practice';
  started: boolean;
  /** True for a real meeting before its owner or a workspace admin presses Start. */
  waitingForOwner: boolean;
  /** The owner's display name, when the server knows it. */
  ownerName: string | null;
  /** Set while the room is off the record; anyone in the meeting may resume. */
  offTheRecord: OffTheRecordState | null;
  participants: MeetingStateParticipant[];
  /** A loud, plain-words notice while notes are paused: the runner cannot hear, or the notetaker is catching up. */
  notesPaused: string | null;
  /** The latest quiet agenda-clock note (a real meeting has no spoken time cues). */
  cue: MeetingStateCue | null;
}

function isOffTheRecordState(value: unknown): value is OffTheRecordState {
  return isObject(value) && isString(value.since) && Number.isFinite(Date.parse(value.since));
}

function isParticipant(value: unknown): value is MeetingStateParticipant {
  return (
    isObject(value) &&
    isNonEmptyString(value.name) &&
    isString(value.displayName) &&
    isNonEmptyString(value.seat) &&
    (value.photoUrl === null || isString(value.photoUrl))
  );
}

function isCue(value: unknown): value is MeetingStateCue {
  return (
    isObject(value) &&
    isNonEmptyString(value.text) &&
    isString(value.at) &&
    Number.isFinite(Date.parse(value.at))
  );
}

/** Validate a state snapshot received over the meeting socket. */
export function isMeetingStateSnapshot(value: unknown): value is MeetingStateSnapshot {
  if (!isObject(value)) return false;
  const phase = value.phase;
  if (phase !== 'lobby' && phase !== 'starting' && phase !== 'running' && phase !== 'ended') return false;
  return (
    isNonEmptyString(value.meetingId) &&
    (value.kind === undefined || value.kind === 'real' || value.kind === 'practice') &&
    typeof value.started === 'boolean' &&
    typeof value.waitingForOwner === 'boolean' &&
    (value.ownerName === null || isString(value.ownerName)) &&
    (value.offTheRecord === null || isOffTheRecordState(value.offTheRecord)) &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    (value.notesPaused === null || isString(value.notesPaused)) &&
    (value.cue === null || isCue(value.cue))
  );
}
