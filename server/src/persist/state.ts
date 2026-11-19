import type { NotetakerStatus, Question, Role, Task } from '@kaki/shared';

/**
 * Bump this whenever `SavedMeetingState` or anything it contains changes shape.
 * The server refuses to load a meeting saved by a different version, so an old row is never
 * guessed at or silently replaced with an empty meeting.
 */
export const MEETING_STATE_SCHEMA_VERSION = 1;

/** The one saved meeting. A single row: Kaki hosts one meeting at a time. */
export const MEETING_STATE_ID = 'meeting';

/** Where the agenda clock was when the meeting was saved. */
export interface SavedClockState {
  started: boolean;
  ended: boolean;
  paused: boolean;
  agendaIndex: number;
  itemElapsedSeconds: number;
  meetingElapsedSeconds: number;
}

/** One transcript line the notetaker has heard. */
export interface SavedTranscriptLine {
  speaker: string;
  role?: Role;
  text: string;
  /** The agenda item this line was heard on, stamped when it arrives so a queued line keeps its origin. */
  agendaItemTitle?: string;
  /** Seconds since the meeting started when the line was heard, stamped on arrival so a queued line keeps its moment. */
  atSeconds?: number;
}

/** The notetaker's progress: what it has not analysed yet, and what it has made of the meeting so far. */
export interface SavedNotetakerState {
  pending: SavedTranscriptLine[];
  recentGrounded: SavedTranscriptLine[];
  contextAgendaIndex: number;
  agendaContext: SavedTranscriptLine[];
  openQuestions: Question[];
  questionCount: number;
  status: NotetakerStatus;
  lastError?: string;
  talkByItem: Array<[number, Partial<Record<Role, number>>]>;
  talkTotals: Array<[Role, number]>;
  talkTotal: number;
}

/** The meeting record, the notetaker and every task, as one versioned snapshot. */
export interface SavedMeetingState {
  clock: SavedClockState;
  notetaker: SavedNotetakerState;
  tasks: Task[];
}

/** One saved meeting, as stored and loaded. */
export interface StoredMeeting {
  schemaVersion: number;
  /** When the meeting started, shown on the host screen after a restore. */
  startedAt: string;
  savedAt: string;
  state: SavedMeetingState;
}

/** The storage the saver writes through; Postgres in the running server, a fake in tests. */
export interface MeetingStateStore {
  load(): Promise<StoredMeeting | undefined>;
  save(meeting: StoredMeeting): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Refuse a saved meeting this build cannot read. Called before anything is restored, so the server
 * stops with a message the owner can act on instead of starting empty.
 */
export function assertCompatibleSavedMeeting(saved: StoredMeeting): void {
  if (saved.schemaVersion === MEETING_STATE_SCHEMA_VERSION) return;
  const age = saved.schemaVersion < MEETING_STATE_SCHEMA_VERSION ? 'an older' : 'a newer';
  throw new Error(
    `Saved meeting is from ${age} format (v${saved.schemaVersion}, need v${MEETING_STATE_SCHEMA_VERSION}). ` +
      'Run `npm run meeting:reset` to discard it.',
  );
}
