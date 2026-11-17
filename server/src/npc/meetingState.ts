/**
 * The room's state on one topic at a time, built only from lines that were actually heard.
 *
 * The ledger is append-only: a line starts when playback begins and ends when playback finishes or is cut off.
 * Everything the planner needs is derived from those events, so a line that was written but never played, or a
 * line that was interrupted before its end, can never answer a question or count a fact as told.
 */

import type { AgendaItem } from '@kaki/shared';

export type MeetingPhase =
  | 'handover'
  | 'brief'
  | 'guest first idea'
  | 'catch'
  | 'clarify'
  | 'confirmation'
  | 'card';

/** A briefing fact the room can hear, with its stable id and the people who know it. */
export interface MeetingFactInfo {
  id: string;
  text: string;
  knownBy: readonly string[];
}

/** A real trade-off one colleague can raise as a catch, from the scenario's discussion. */
export interface MeetingCatchInfo {
  id: string;
  attendee: string;
  text: string;
}

/** Everything about one agenda item that the state and planner need. */
export interface MeetingTopicInfo {
  title: string;
  minutes: number;
  canWait: boolean;
  deadline: string;
  facts: readonly MeetingFactInfo[];
  catches: readonly MeetingCatchInfo[];
}

/** The open question a heard line put to one addressee. */
export interface OpenQuestionView {
  from: string;
  to: string;
  text: string;
  askedAt: number;
  eventId: string;
}

/** One line in the derived view, complete or still in progress or interrupted. */
export interface HeardLine {
  eventId: string;
  speaker: string;
  text: string;
  at: number;
  /** True only when playback or reading finished; a partial line is not counted as heard. */
  complete: boolean;
  question?: { to: string; text: string };
  /** The guest offered this line as an idea for the topic. */
  proposal: boolean;
  factId?: string;
  /** The line was marked as raising a catch, whatever speaker said it. */
  catch: boolean;
}

export interface MeetingFactView {
  id: string;
  text: string;
  knownBy: readonly string[];
  told: boolean;
  toldBy?: string;
  eventId?: string;
}

export interface MeetingCatchView {
  id: string;
  attendee: string;
  text: string;
  raised: boolean;
}

export interface MeetingView {
  topic: string | undefined;
  phase: MeetingPhase;
  canWait: boolean;
  deadline: string | undefined;
  remainingMs: number;
  /** Every line heard on the current topic, in order. */
  lines: readonly HeardLine[];
  /** The latest wholly heard line. */
  lastHeard: HeardLine | undefined;
  /** The latest line in the ledger, which may be partial. */
  lastLine: HeardLine | undefined;
  openQuestion: OpenQuestionView | undefined;
  /** The most recent question and whether its addressee has answered it. */
  lastQuestion: (OpenQuestionView & { answered: boolean }) | undefined;
  guestFirstIdea: HeardLine | undefined;
  guestLaterIdeas: readonly HeardLine[];
  guestLastLine: HeardLine | undefined;
  factsTold: readonly string[];
  facts: readonly MeetingFactView[];
  catches: readonly MeetingCatchView[];
  catchRaised: boolean;
  guestInvited: boolean;
  guest: string | undefined;
  host: string | undefined;
  present: readonly string[];
}

export interface MeetingStateOptions {
  topics: readonly MeetingTopicInfo[];
  present: readonly string[];
  host?: string;
  guest?: string;
}

/** The event shape recorded when a line starts; its id makes the end event match it. */
export interface HeardLineStart {
  id: string;
  speaker: string;
  text: string;
  at: number;
  question?: { to: string; text: string };
  proposal?: boolean;
  factId?: string;
  catch?: boolean;
}

type LedgerEvent =
  | ({ kind: 'start' } & HeardLineStart)
  | { kind: 'end'; id: string; complete: boolean; at: number };

interface Ledger {
  events: LedgerEvent[];
  openedAt: number;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'because', 'been', 'before', 'being', 'both', 'could',
  'does', 'doing', 'done', 'down', 'each', 'from', 'have', 'having', 'here', 'into', 'just', 'like',
  'more', 'most', 'much', 'must', 'never', 'only', 'other', 'over', 'same', 'should', 'some', 'such',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'very', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your',
]);

/** Content words shared by two sentences, used only to spot which briefing fact a line is about. */
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? [];
  return new Set(words.filter((word) => word.length >= 4 && !STOP_WORDS.has(word)));
}

function overlapCount(left: string, right: string): number {
  const leftWords = contentWords(left);
  const rightWords = contentWords(right);
  let count = 0;
  for (const word of leftWords) if (rightWords.has(word)) count += 1;
  return count;
}

/** Map a validated agenda item to the state's topic shape. */
export function meetingTopic(item: AgendaItem, index: number): MeetingTopicInfo {
  return {
    title: item.title,
    minutes: item.minutes,
    canWait: item.canWait,
    deadline: item.deadline,
    facts: (item.briefing ?? []).map((fact, factIndex) => ({
      id: `${index}:${factIndex}`,
      text: fact.text,
      knownBy: fact.knownBy.map((knower) => knower.attendee),
    })),
    catches: (item.discussion?.tradeOffs ?? []).map((tradeOff, catchIndex) => ({
      id: `${index}:catch:${catchIndex}`,
      attendee: tradeOff.attendee,
      text: tradeOff.tradeOff,
    })),
  };
}

function emptyView(topic: MeetingTopicInfo | undefined, guest: string | undefined, host: string | undefined, present: readonly string[]): MeetingView {
  return {
    topic: topic?.title,
    phase: 'handover',
    canWait: topic?.canWait ?? true,
    deadline: topic?.deadline,
    remainingMs: 0,
    lines: [],
    lastHeard: undefined,
    lastLine: undefined,
    openQuestion: undefined,
    lastQuestion: undefined,
    guestFirstIdea: undefined,
    guestLaterIdeas: [],
    guestLastLine: undefined,
    factsTold: [],
    facts: [],
    catches: [],
    catchRaised: false,
    guestInvited: false,
    guest,
    host,
    present,
  };
}

function derive(
  topic: MeetingTopicInfo | undefined,
  ledger: Ledger | undefined,
  now: number,
  guest: string | undefined,
  host: string | undefined,
  present: readonly string[],
): MeetingView {
  if (topic === undefined || ledger === undefined) {
    return emptyView(topic, guest, host, present);
  }

  const starts = new Map<string, Extract<LedgerEvent, { kind: 'start' }>>();
  const ends = new Map<string, Extract<LedgerEvent, { kind: 'end' }>>();
  for (const event of ledger.events) {
    if (event.kind === 'start') {
      if (!starts.has(event.id)) starts.set(event.id, event);
    } else {
      ends.set(event.id, event);
    }
  }

  const lines: HeardLine[] = [];
  for (const start of starts.values()) {
    const end = ends.get(start.id);
    lines.push({
      eventId: start.id,
      speaker: start.speaker,
      text: start.text,
      at: start.at,
      complete: end?.complete === true,
      ...(start.question === undefined ? {} : { question: start.question }),
      proposal: start.proposal === true,
      ...(start.factId === undefined ? {} : { factId: start.factId }),
      catch: start.catch === true,
    });
  }

  const facts: MeetingFactView[] = topic.facts.map((fact) => ({
    id: fact.id,
    text: fact.text,
    knownBy: fact.knownBy,
    told: false,
  }));
  const catches: MeetingCatchView[] = topic.catches.map((entry) => ({
    id: entry.id,
    attendee: entry.attendee,
    text: entry.text,
    raised: false,
  }));

  const firstIdeaIndex = lines.findIndex((line) => line.complete && line.speaker === guest && line.proposal);
  let openQuestion: OpenQuestionView | undefined;
  let lastQuestion: (OpenQuestionView & { answered: boolean }) | undefined;
  let guestInvited = false;
  let guestLastLine: HeardLine | undefined;
  let explicitCatch = false;

  lines.forEach((line, index) => {
    if (!line.complete) return;

    if (openQuestion !== undefined && line.speaker === openQuestion.to) {
      openQuestion = undefined;
      if (lastQuestion !== undefined) lastQuestion = { ...lastQuestion, answered: true };
    }

    if (line.question !== undefined) {
      openQuestion = {
        from: line.speaker,
        to: line.question.to,
        text: line.question.text,
        askedAt: line.at,
        eventId: line.eventId,
      };
      lastQuestion = { ...openQuestion, answered: false };
      if (line.speaker === host && line.question.to === guest) guestInvited = true;
    }

    if (line.speaker === guest) guestLastLine = line;

    const speaker = line.speaker;
    const fact = facts.find((candidate) =>
      !candidate.told &&
      speaker !== guest &&
      speaker !== host &&
      candidate.knownBy.includes(speaker) &&
      (line.factId === undefined
        ? overlapCount(candidate.text, line.text) >= Math.max(2, Math.ceil(contentWords(candidate.text).size / 2))
        : candidate.id === line.factId),
    );
    if (fact !== undefined) {
      fact.told = true;
      fact.toldBy = speaker;
      fact.eventId = line.eventId;
    }

    if (line.catch) explicitCatch = true;
    if (firstIdeaIndex >= 0 && index > firstIdeaIndex) {
      for (const raised of catches) {
        if (!raised.raised && raised.attendee === speaker && raised.attendee !== guest && raised.attendee !== host) {
          raised.raised = true;
        }
      }
    }
  });

  const catchRaised = explicitCatch || catches.some((entry) => entry.raised);
  const lastHeard = [...lines].reverse().find((line) => line.complete);
  const lastLine = lines.at(-1);
  const guestIdeas = lines.filter((line) => line.complete && line.speaker === guest && line.proposal);

  const phase: MeetingPhase = lines.length === 0
    ? 'handover'
    : firstIdeaIndex < 0
      ? 'brief'
      : !catchRaised
        ? 'guest first idea'
        : openQuestion !== undefined
          ? 'clarify'
          : 'confirmation';

  return {
    topic: topic.title,
    phase,
    canWait: topic.canWait,
    deadline: topic.deadline,
    remainingMs: Math.max(0, ledger.openedAt + topic.minutes * 60_000 - now),
    lines,
    lastHeard,
    lastLine,
    openQuestion,
    lastQuestion,
    guestFirstIdea: firstIdeaIndex < 0 ? undefined : lines[firstIdeaIndex],
    guestLaterIdeas: firstIdeaIndex < 0 ? [] : guestIdeas.slice(1),
    guestLastLine,
    factsTold: facts.filter((fact) => fact.told).map((fact) => fact.id),
    facts,
    catches,
    catchRaised,
    guestInvited,
    guest,
    host,
    present,
  };
}

export class MeetingState {
  private readonly topics = new Map<string, MeetingTopicInfo>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly lineTopics = new Map<string, string>();
  private current: string | undefined;
  private guestName: string | undefined;
  private readonly presentNames: readonly string[];
  private readonly hostName: string | undefined;

  constructor(options: MeetingStateOptions) {
    for (const topic of options.topics) this.topics.set(topic.title, topic);
    this.presentNames = [...options.present];
    this.hostName = options.host;
    this.guestName = options.guest;
  }

  /** The person taking the guest seat. */
  setGuest(name: string | undefined): void {
    this.guestName = name;
  }

  /** A meeting reset: every topic's ledger is forgotten. */
  reset(): void {
    this.ledgers.clear();
    this.lineTopics.clear();
    this.current = undefined;
  }

  /** Start a new topic, or return to an earlier one whose ledger is still here. True when the topic changed. */
  openTopic(title: string | undefined, at: number): boolean {
    if (title === this.current) return false;
    this.current = title;
    if (title !== undefined) {
      const ledger = this.ledgers.get(title);
      if (ledger === undefined) this.ledgers.set(title, { events: [], openedAt: at });
      else ledger.openedAt = at;
    }
    return true;
  }

  /** A line has started playing: it is heard from here, but not yet complete. */
  lineStarted(start: HeardLineStart): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return;
    const exists = ledger.events.some((event) => event.kind === 'start' && event.id === start.id);
    if (exists) return;
    ledger.events.push({ kind: 'start', ...start });
    this.lineTopics.set(start.id, title);
  }

  /** A line finished (`complete`) or was cut off (`complete: false`). Idempotent for the same id. */
  lineEnded(id: string, complete: boolean, at: number): HeardLine | undefined {
    const title = this.lineTopics.get(id);
    if (title === undefined) return undefined;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return undefined;
    const ended = ledger.events.some((event) => event.kind === 'end' && event.id === id);
    if (ended) return undefined;
    ledger.events.push({ kind: 'end', id, complete, at });
    return derive(this.topics.get(title), ledger, at, this.guestName, this.hostName, this.presentNames)
      .lines.find((line) => line.eventId === id);
  }

  /** Record a line that is heard whole straight away (a guest utterance). */
  heard(start: HeardLineStart): HeardLine | undefined {
    this.lineStarted(start);
    return this.lineEnded(start.id, true, start.at);
  }

  view(now: number): MeetingView {
    const topic = this.current === undefined ? undefined : this.topics.get(this.current);
    const ledger = this.current === undefined ? undefined : this.ledgers.get(this.current);
    return derive(topic, ledger, now, this.guestName, this.hostName, this.presentNames);
  }
}
