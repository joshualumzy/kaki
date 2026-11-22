import {
  demoPackNpcProfileIds,
  deriveMeetingScenario,
  isBlankMeetingDraft,
  isNonEmptyString,
  isNonNegativeFinite,
  isObject,
  isQuestion,
  isReviewIssue,
  isRoleIn,
  isString,
  isTask,
  normalizeMeetingCode,
  NOTETAKER_STATUSES,
  parseMeetingSetup,
  type MeetingSetup,
  type NotetakerStatus,
  type OffTheRecordSpan,
  type Question,
  type ReviewIssue,
  type Role,
  type Scenario,
  type Task,
} from '@kaki/shared';

/**
 * Bump this whenever `SavedMeetingState` or anything it contains changes shape.
 * The server refuses to load a meeting saved by a different version, so an old row is never
 * guessed at or silently replaced with an empty meeting.
 */
export const MEETING_STATE_SCHEMA_VERSION = 8;

/** The one saved meeting. A single row: Kaki hosts one meeting at a time. */
export const MEETING_STATE_ID = 'meeting';

/** Why the meeting clock is paused: an empty room (auto) or a person's explicit Stop. */
export type MeetingPauseKind = 'empty-room' | 'person';

/** Where the agenda clock was when the meeting was saved. */
export interface SavedClockState {
  started: boolean;
  ended: boolean;
  paused: boolean;
  /** Present while paused; older saves without it are treated as a person's pause. */
  pauseKind?: MeetingPauseKind;
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
  /** True when this person started speaking before the previous line had finished. */
  overlap?: boolean;
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
  /** Judgements the notetaker could not make; optional so an older saved meeting still loads. */
  reviewIssues?: ReviewIssue[];
  reviewIssueCount?: number;
  status: NotetakerStatus;
  lastError?: string;
  /** Consecutive passes whose reply lacked a usable `revisions` list; optional so an older save still loads. */
  revisionFailures?: number;
  talkByItem: Array<[number, Partial<Record<Role, number>>]>;
  talkTotals: Array<[Role, number]>;
  talkTotal: number;
}

/** A saved meeting's phase. A Start in flight is saved as `lobby`, never as `running`. */
export type SavedMeetingPhase = 'lobby' | 'starting' | 'running' | 'ended';

/** The meeting record, the notetaker and every task, as one versioned snapshot. */
export interface SavedMeetingState {
  clock: SavedClockState;
  notetaker: SavedNotetakerState;
  tasks: Task[];
}

/** Which person name holds which human seat, so a restart recognises the same people. */
export interface SavedSeatAssignment {
  name: string;
  seat: string;
  displayName?: string;
  /** The person's Google photo, so a restart keeps the same avatars. */
  photoUrl?: string;
  /** The person's Google address, so a restart can still email them the minutes. */
  email?: string;
}

/**
 * Everything the session owns at a save point. The draft is always saved; the sealed setup is saved
 * only for a meeting that has one (running or ended), so an edit made after END cannot lose the
 * meeting that ran, and the next meeting's draft cannot lose its edit.
 */
export interface SavedMeetingDetails {
  meetingId: string;
  phase: SavedMeetingPhase;
  /** The journey that opened the meeting; absent for a meeting saved before kinds existed. */
  kind?: 'real' | 'practice';
  draft: MeetingSetup;
  draftTouched: boolean;
  /** An owner edit made after the seal: the next meeting must keep this draft. */
  draftEditedSinceSeal?: boolean;
  /** Present iff `phase` is `starting`, `running` or `ended`. */
  sealed?: MeetingSetup;
  /**
   * Which journey sealed it. A practice seal never consumes the owner's draft; absent on older
   * saves, where an ended seal is treated as the owner's.
   */
  sealedKind?: 'real' | 'practice';
  holders: SavedSeatAssignment[];
  meetingCode: string;
  /** Absent while the meeting is still a pre-Start setup draft. */
  startedAt?: string;
  /**
   * The agenda a lobby's untouched draft will actually run (the shaped pick), so a restart keeps it.
   * Only present for a lobby whose draft still follows the demo pack, never an owner-edited one.
   */
  lobbyAgenda?: string[];
  /** The grace ended with nobody back: the meeting is over and the next arrival starts a new one. */
  abandoned?: boolean;
  /** Closed off-the-record spans, kept for the minutes with no content. */
  offTheRecordSpans?: OffTheRecordSpan[];
  /** Set while the room is still off the record across a restart. */
  offTheRecordSince?: string;
}

/** Everything one save point writes: the session's details plus the running record. */
export interface MeetingSnapshot extends SavedMeetingDetails {
  state: SavedMeetingState;
}

/** One saved meeting, as stored and loaded. */
export interface StoredMeeting extends MeetingSnapshot {
  schemaVersion: number;
  savedAt: string;
}

/** The storage the saver writes through; Postgres in the running server, a fake in tests. */
export interface MeetingStateStore {
  load(): Promise<StoredMeeting | undefined>;
  save(meeting: StoredMeeting): Promise<void>;
  clear(): Promise<void>;
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
    (value.atSeconds === undefined || isNonNegativeFinite(value.atSeconds)) &&
    (value.overlap === undefined || typeof value.overlap === 'boolean')
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
  if (
    !Array.isArray(value.openQuestions) ||
    !value.openQuestions.every((question) => isQuestion(question, scenario, { requireNonEmptyText: true }))
  ) {
    return 'its notetaker questions are not valid';
  }
  if (!isNonNegativeInteger(value.questionCount)) return 'its notetaker question count is not valid';
  if (value.reviewIssues !== undefined) {
    if (!Array.isArray(value.reviewIssues) || !value.reviewIssues.every((issue) => isReviewIssue(issue))) {
      return 'its notetaker review issues are not valid';
    }
  }
  if (value.reviewIssueCount !== undefined && !isNonNegativeInteger(value.reviewIssueCount)) {
    return 'its notetaker review issue count is not valid';
  }
  if (typeof value.status !== 'string' || !(NOTETAKER_STATUSES as readonly string[]).includes(value.status)) {
    return 'its notetaker status is not valid';
  }
  if (value.lastError !== undefined && typeof value.lastError !== 'string') {
    return 'its notetaker last error is not text';
  }
  if (value.revisionFailures !== undefined && !isNonNegativeInteger(value.revisionFailures)) {
    return 'its notetaker revision failure count is not valid';
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
  if (
    value.pauseKind !== undefined &&
    value.pauseKind !== 'empty-room' &&
    value.pauseKind !== 'person'
  ) {
    return 'its clock pause kind is not valid';
  }
  if (!isNonNegativeInteger(value.agendaIndex) || value.agendaIndex >= agendaLength) {
    return 'its clock points at an agenda item that is not saved';
  }
  if (!isNonNegativeFinite(value.itemElapsedSeconds) || !isNonNegativeFinite(value.meetingElapsedSeconds)) {
    return 'its clock times are not valid';
  }
  return undefined;
}

/** Name the first field `parseMeetingSetup` rejects, so the owner knows what to fix or reset. */
function setupProblem(
  value: unknown,
  scenario: Scenario,
  allowBlank = false,
  allowEmptyAgenda = false,
): string | undefined {
  if (allowBlank && isBlankMeetingDraft(value)) return undefined;
  const parsed = parseMeetingSetup(value, { npcProfileIds: demoPackNpcProfileIds(scenario) });
  if (parsed.ok) return undefined;
  // A real meeting may have no agenda at all; an empty agenda is valid, not a broken save.
  const errors = allowEmptyAgenda
    ? parsed.errors.filter((problem) => problem.field !== 'agenda')
    : parsed.errors;
  const first = errors[0];
  if (first === undefined) return undefined;
  return `setup is invalid at ${first.field}: ${first.message}`;
}

function meetingCodeProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || normalizeMeetingCode(value) === '') return 'its meeting code is missing';
  return undefined;
}

function offTheRecordSpansProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'its off-the-record spans are not a list';
  for (const span of value) {
    if (!isObject(span)) return 'its off-the-record spans are not a list of times';
    if (
      !isString(span.from) ||
      !isString(span.to) ||
      !Number.isFinite(Date.parse(span.from)) ||
      !Number.isFinite(Date.parse(span.to)) ||
      Date.parse(span.to) < Date.parse(span.from)
    ) {
      return 'its off-the-record spans are not a list of times';
    }
  }
  return undefined;
}

function holdersProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'its seat holders are not a list';
  const seats = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry) || !isNonEmptyString(entry.name) || !isNonEmptyString(entry.seat)) {
      return 'its seat holders are not a list of names and seats';
    }
    if (entry.photoUrl !== undefined && !isString(entry.photoUrl)) {
      return 'its seat holders have an invalid photo';
    }
    if (entry.displayName !== undefined && !isString(entry.displayName)) {
      return 'its seat holders have an invalid display name';
    }
    if (entry.email !== undefined && !isString(entry.email)) {
      return 'its seat holders have an invalid email';
    }
    const seat = entry.seat.trim().toLowerCase();
    if (seats.has(seat)) return 'its seat holders repeat a seat';
    seats.add(seat);
  }
  return undefined;
}

const SAVED_PHASES: readonly SavedMeetingPhase[] = ['lobby', 'starting', 'running', 'ended'];

function phaseProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !(SAVED_PHASES as readonly string[]).includes(value)) {
    return 'its phase is not valid';
  }
  return undefined;
}

/** The agenda titles the saved meeting ran or was set up with: the seal first, then the draft. */
function savedAgendaTitles(saved: Pick<StoredMeeting, 'sealed' | 'draft'>): string[] {
  const setup = saved.sealed ?? saved.draft;
  return setup.agenda.map((item) => item.title);
}

/**
 * Describe what is wrong with a saved meeting, or undefined when the whole snapshot can be applied.
 * `scenario` is the scenario this server started with, so a task from another scenario is rejected.
 */
export function savedMeetingProblem(
  saved: StoredMeeting,
  scenario: Scenario,
  allowEmptyAgenda = false,
): string | undefined {
  if (!isObject(saved)) return 'the saved row is not an object';
  if (saved.startedAt !== undefined && (typeof saved.startedAt !== 'string' || Number.isNaN(Date.parse(saved.startedAt)))) {
    return 'its start time is not a date';
  }
  if (typeof saved.savedAt !== 'string' || Number.isNaN(Date.parse(saved.savedAt))) {
    return 'its save time is not a date';
  }
  if (!isNonEmptyString(saved.meetingId)) return 'its meeting identity is missing';
  const phase = phaseProblem((saved as { phase?: unknown }).phase);
  if (phase !== undefined) return phase;
  const kind = (saved as { kind?: unknown }).kind;
  if (kind !== undefined && kind !== 'real' && kind !== 'practice') return 'its meeting kind is not valid';
  const blankDraft = isBlankMeetingDraft((saved as { draft?: unknown }).draft);
  const draft = setupProblem(
    (saved as { draft?: unknown }).draft,
    scenario,
    blankDraft,
    allowEmptyAgenda,
  );
  if (draft !== undefined) return `its draft ${draft}`;
  if (typeof saved.draftTouched !== 'boolean') return 'its setup edit mark is not valid';
  if (saved.draftEditedSinceSeal !== undefined && typeof saved.draftEditedSinceSeal !== 'boolean') {
    return 'its setup edit mark is not valid';
  }
  const lobbyAgenda = (saved as { lobbyAgenda?: unknown }).lobbyAgenda;
  if (lobbyAgenda !== undefined) {
    if (saved.phase !== 'lobby') return 'its lobby agenda is not valid for this phase';
    if (!Array.isArray(lobbyAgenda) || lobbyAgenda.length === 0 || !lobbyAgenda.every(isNonEmptyString)) {
      return 'its lobby agenda is not a list of topics';
    }
    const known = new Set(scenario.agenda.map((item) => item.title));
    const missing = lobbyAgenda.filter((title) => !known.has(title));
    if (missing.length > 0) {
      return `its lobby agenda has topics this scenario no longer has (${missing.join(', ')})`;
    }
  }
  const abandoned = (saved as { abandoned?: unknown }).abandoned;
  if (abandoned !== undefined) {
    if (typeof abandoned !== 'boolean') return 'its abandoned mark is not valid';
    if (abandoned && saved.phase !== 'running') return 'its abandoned mark is not valid for this phase';
  }
  const sealedKind = (saved as { sealedKind?: unknown }).sealedKind;
  if (sealedKind !== undefined && sealedKind !== 'real' && sealedKind !== 'practice') {
    return 'its sealed meeting kind is not valid';
  }
  const sealedPhase = saved.phase === 'starting' || saved.phase === 'running' || saved.phase === 'ended';
  if (sealedPhase) {
    if (saved.sealed === undefined) return 'its sealed setup is missing';
    const sealed = setupProblem(
      (saved as { sealed?: unknown }).sealed,
      scenario,
      false,
      allowEmptyAgenda,
    );
    if (sealed !== undefined) return `its sealed ${sealed}`;
  } else if (saved.sealed !== undefined) {
    return 'its sealed setup is not valid for this phase';
  }
  if (sealedKind !== undefined && !sealedPhase) return 'its sealed meeting kind is not valid for this phase';
  const meetingCode = meetingCodeProblem((saved as { meetingCode?: unknown }).meetingCode);
  if (meetingCode !== undefined) return meetingCode;
  const holders = holdersProblem((saved as { holders?: unknown }).holders);
  if (holders !== undefined) return holders;
  const spans = (saved as { offTheRecordSpans?: unknown }).offTheRecordSpans;
  if (spans !== undefined) {
    const problem = offTheRecordSpansProblem(spans);
    if (problem !== undefined) return problem;
  }
  const since = (saved as { offTheRecordSince?: unknown }).offTheRecordSince;
  if (since !== undefined && (!isString(since) || !Number.isFinite(Date.parse(since)))) {
    return 'its off-the-record start is not a date';
  }
  if ((saved.phase === 'running' || saved.phase === 'ended') && saved.startedAt === undefined) {
    return 'its start time is missing';
  }
  const state = saved.state as unknown;
  if (!isObject(state)) return 'its meeting state is missing';
  const agendaTitles = savedAgendaTitles(saved);
  // A blank plan has no agenda yet; its clock still rests at the first item.
  const clock = clockProblem(
    state.clock,
    agendaTitles.length === 0 && (blankDraft || allowEmptyAgenda) ? 1 : agendaTitles.length,
  );
  if (clock !== undefined) return clock;
  // A started meeting boots from the scenario its sealed setup describes, so refuse one that cannot
  // run with the same friendly message instead of crashing while the boot scenario is validated.
  if ((saved.phase === 'running' || saved.phase === 'ended') && saved.sealed !== undefined) {
    const derived = deriveMeetingScenario(scenario, saved.sealed, {
      agendaOrder: agendaTitles,
      ...(allowEmptyAgenda ? { allowEmptyAgenda: true, allowEmptyRoles: true } : {}),
    });
    if (!derived.ok) {
      const first = derived.errors[0];
      return first === undefined
        ? 'its setup describes a meeting that cannot run'
        : `its setup describes a meeting that cannot run at ${first.field}: ${first.message}`;
    }
  }
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

function unreadableSavedMeeting(problem: string): Error {
  return new Error(`Saved meeting is unreadable (${problem}). Run \`npm run meeting:reset\` to discard it.`);
}

/**
 * Refuse a saved setup before its roles are derived and applied. A malformed setup must fail with the
 * friendly saved-meeting message, not an exception from building roles out of broken data.
 */
export function assertReadableSavedSetup(
  saved: StoredMeeting,
  scenario: Scenario,
  allowEmptyAgenda = false,
): void {
  const draft = setupProblem(
    (saved as { draft?: unknown }).draft,
    scenario,
    isBlankMeetingDraft((saved as { draft?: unknown }).draft),
    allowEmptyAgenda,
  );
  if (draft !== undefined) throw unreadableSavedMeeting(`its draft ${draft}`);
  if (typeof saved.draftTouched !== 'boolean') {
    throw unreadableSavedMeeting('its setup edit mark is not valid');
  }
  if (saved.draftEditedSinceSeal !== undefined && typeof saved.draftEditedSinceSeal !== 'boolean') {
    throw unreadableSavedMeeting('its setup edit mark is not valid');
  }
  if (saved.sealed !== undefined) {
    const sealed = setupProblem(
      (saved as { sealed?: unknown }).sealed,
      scenario,
      false,
      allowEmptyAgenda,
    );
    if (sealed !== undefined) throw unreadableSavedMeeting(`its sealed ${sealed}`);
  }
  const sealedKind = (saved as { sealedKind?: unknown }).sealedKind;
  if (sealedKind !== undefined && sealedKind !== 'real' && sealedKind !== 'practice') {
    throw unreadableSavedMeeting('its sealed meeting kind is not valid');
  }
}

/** Refuse a saved meeting whose shape is broken before any of it is applied. */
export function assertReadableSavedMeeting(
  saved: StoredMeeting,
  scenario: Scenario,
  allowEmptyAgenda = false,
): void {
  const problem = savedMeetingProblem(saved, scenario, allowEmptyAgenda);
  if (problem === undefined) return;
  throw unreadableSavedMeeting(problem);
}

/** Resolve the saved agenda titles against this build's scenario, refusing topics that no longer exist. */
export function resolveSavedAgenda(saved: StoredMeeting, scenario: Scenario): Scenario['agenda'] {
  const byTitle = new Map(scenario.agenda.map((item) => [item.title, item]));
  const missing = savedAgendaTitles(saved).filter((title) => !byTitle.has(title));
  if (missing.length > 0) {
    throw new Error(
      `Saved meeting's agenda has topics this scenario no longer has (${missing.join(', ')}). ` +
        'Run `npm run meeting:reset` to discard it.',
    );
  }
  return savedAgendaTitles(saved).map((title) => byTitle.get(title)!);
}
