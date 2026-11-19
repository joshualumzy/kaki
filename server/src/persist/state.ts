import {
  isRoleIn,
  isTask,
  NOTETAKER_STATUSES,
  type NotetakerStatus,
  type Question,
  type Role,
  type Scenario,
  type Task,
} from '@kaki/shared';

/**
 * Bump this whenever `SavedMeetingState` or anything it contains changes shape.
 * The server refuses to load a meeting saved by a different version, so an old row is never
 * guessed at or silently replaced with an empty meeting.
 */
export const MEETING_STATE_SCHEMA_VERSION = 3;

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
  /** The batch the model was analysing when the meeting was saved; it goes back in front of `pending`. */
  inFlight: SavedTranscriptLine[];
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
  /** The identity of this meeting; a reset starts a new one and the runner must not carry state across. */
  meetingId: string;
  /** The agenda titles in the order this meeting was using, so restored indices mean the same topics. */
  agenda: string[];
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isTranscriptLine(value: unknown, scenario: Scenario): value is SavedTranscriptLine {
  return (
    isObject(value) &&
    isNonEmptyString(value.speaker) &&
    typeof value.text === 'string' &&
    (value.role === undefined || isRoleIn(scenario, value.role)) &&
    (value.agendaItemTitle === undefined || isNonEmptyString(value.agendaItemTitle)) &&
    (value.atSeconds === undefined || isNonNegativeFinite(value.atSeconds))
  );
}

function isQuestion(value: unknown, scenario: Scenario): value is Question {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.text) &&
    isNonNegativeInteger(value.agendaIndex) &&
    (value.forRole === undefined || isRoleIn(scenario, value.forRole))
  );
}

function transcriptLinesProblem(value: unknown, scenario: Scenario, label: string): string | undefined {
  if (!Array.isArray(value) || !value.every((line) => isTranscriptLine(line, scenario))) {
    return `its notetaker ${label} is not a list of transcript lines`;
  }
  return undefined;
}

function talkByItemProblem(value: unknown, scenario: Scenario): string | undefined {
  if (!Array.isArray(value)) return 'its notetaker talk by item is not a list';
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isNonNegativeInteger(entry[0]) || !isObject(entry[1])) {
      return 'its notetaker talk by item is not a list';
    }
    const talk = entry[1];
    for (const [role, seconds] of Object.entries(talk)) {
      if (!isRoleIn(scenario, role) || !isNonNegativeFinite(seconds)) {
        return 'its notetaker talk by item names an unknown role or invalid time';
      }
    }
  }
  return undefined;
}

function talkTotalsProblem(value: unknown, scenario: Scenario): string | undefined {
  if (!Array.isArray(value)) return 'its notetaker talk totals are not a list';
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isRoleIn(scenario, entry[0]) || !isNonNegativeFinite(entry[1])) {
      return 'its notetaker talk totals name an unknown role or invalid time';
    }
  }
  return undefined;
}

function notetakerProblem(value: unknown, scenario: Scenario): string | undefined {
  if (!isObject(value)) return 'its notetaker progress is missing';
  for (const [field, label] of [
    ['pending', 'pending lines'],
    ['inFlight', 'in-flight lines'],
    ['recentGrounded', 'grounding lines'],
    ['agendaContext', 'agenda context'],
  ] as const) {
    const problem = transcriptLinesProblem(value[field], scenario, label);
    if (problem !== undefined) return problem;
  }
  if (!isNonNegativeInteger(value.contextAgendaIndex)) return 'its notetaker agenda index is not valid';
  if (!Array.isArray(value.openQuestions) || !value.openQuestions.every((question) => isQuestion(question, scenario))) {
    return 'its notetaker questions are not valid';
  }
  if (!isNonNegativeInteger(value.questionCount)) return 'its notetaker question count is not valid';
  if (typeof value.status !== 'string' || !(NOTETAKER_STATUSES as readonly string[]).includes(value.status)) {
    return 'its notetaker status is not valid';
  }
  if (value.lastError !== undefined && typeof value.lastError !== 'string') {
    return 'its notetaker last error is not text';
  }
  const byItem = talkByItemProblem(value.talkByItem, scenario);
  if (byItem !== undefined) return byItem;
  const totals = talkTotalsProblem(value.talkTotals, scenario);
  if (totals !== undefined) return totals;
  if (!isNonNegativeFinite(value.talkTotal)) return 'its notetaker talk total is not valid';
  return undefined;
}

function clockProblem(value: unknown, agendaLength: number): string | undefined {
  if (!isObject(value)) return 'its clock is missing';
  if (typeof value.started !== 'boolean' || typeof value.ended !== 'boolean' || typeof value.paused !== 'boolean') {
    return 'its clock is not valid';
  }
  if (!isNonNegativeInteger(value.agendaIndex) || value.agendaIndex >= agendaLength) {
    return 'its clock points at an agenda item that is not saved';
  }
  if (!isNonNegativeFinite(value.itemElapsedSeconds) || !isNonNegativeFinite(value.meetingElapsedSeconds)) {
    return 'its clock times are not valid';
  }
  return undefined;
}

function agendaProblem(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    return 'its agenda is not a list of topics';
  }
  if (new Set(value).size !== value.length) return 'its agenda repeats a topic';
  return undefined;
}

/**
 * Describe what is wrong with a saved meeting, or undefined when the whole snapshot can be applied.
 * `scenario` is the scenario this server started with, so a task from another scenario is rejected.
 */
export function savedMeetingProblem(saved: StoredMeeting, scenario: Scenario): string | undefined {
  if (!isObject(saved)) return 'the saved row is not an object';
  if (typeof saved.startedAt !== 'string' || Number.isNaN(Date.parse(saved.startedAt))) {
    return 'its start time is not a date';
  }
  if (typeof saved.savedAt !== 'string' || Number.isNaN(Date.parse(saved.savedAt))) {
    return 'its save time is not a date';
  }
  const state = saved.state as unknown;
  if (!isObject(state)) return 'its meeting state is missing';
  if (!isNonEmptyString(state.meetingId)) return 'its meeting identity is missing';
  const agenda = agendaProblem(state.agenda);
  if (agenda !== undefined) return agenda;
  const clock = clockProblem(state.clock, (state.agenda as string[]).length);
  if (clock !== undefined) return clock;
  if (!Array.isArray(state.tasks)) return 'its task list is not a list';
  for (let index = 0; index < state.tasks.length; index += 1) {
    if (!isTask(state.tasks[index], scenario)) return `task ${index + 1} is not valid for this scenario`;
  }
  return notetakerProblem(state.notetaker, scenario);
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

/** Refuse a saved meeting whose shape is broken before any of it is applied. */
export function assertReadableSavedMeeting(saved: StoredMeeting, scenario: Scenario): void {
  const problem = savedMeetingProblem(saved, scenario);
  if (problem === undefined) return;
  throw new Error(`Saved meeting is unreadable (${problem}). Run \`npm run meeting:reset\` to discard it.`);
}

/** Resolve the saved agenda titles against this build's scenario, refusing topics that no longer exist. */
export function resolveSavedAgenda(saved: StoredMeeting, scenario: Scenario): Scenario['agenda'] {
  const byTitle = new Map(scenario.agenda.map((item) => [item.title, item]));
  const missing = saved.state.agenda.filter((title) => !byTitle.has(title));
  if (missing.length > 0) {
    throw new Error(
      `Saved meeting's agenda has topics this scenario no longer has (${missing.join(', ')}). ` +
        'Run `npm run meeting:reset` to discard it.',
    );
  }
  return saved.state.agenda.map((title) => byTitle.get(title)!);
}
