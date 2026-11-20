/**
 * The room's state on one topic at a time, built only from lines that were actually heard.
 *
 * The ledger is append-only: a line starts when playback begins and ends when playback finishes or is cut off.
 * Everything the planner needs is derived from those events, so a line that was written but never played can
 * never answer a question or count a fact as told. A cut-off line still counts the complete sentences the room
 * actually heard: it can close a question its addressee began answering, and a fact told before the cut stands.
 */

import type { AgendaItem } from '@kaki/shared';
import type { GuestReading } from './guestReader';

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
  /** The guest idea this catch reacts to, in the scenario's own plain words. */
  idea: string;
  text: string;
}

/** Everything about one agenda item that the state and planner need. */
export interface MeetingTopicInfo {
  title: string;
  minutes: number;
  canWait: boolean;
  deadline: string;
  /** The call the host puts to the guest once the briefing is done. */
  decision?: string;
  /** The colleague whose role owns this topic, who explains an urgent deadline. */
  owner?: string;
  /** Realistic ways the topic could be handled, used only as a plain proposal when the guest leaves a gap. */
  directions?: readonly string[];
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
  /** Every briefing fact this line was written to tell, marked only when the whole line is heard. */
  factIds?: readonly string[];
  /** The real catch this line raises, marked only when the whole line is heard. */
  catchId?: string;
  /** The line was marked as raising a catch, whatever speaker said it. */
  catch: boolean;
  /** The briefing facts the room actually heard before this line was cut off. */
  heardFactIds?: readonly string[];
  /** How many complete sentences of this line the room heard before it was cut off. */
  sentencesHeard?: number;
  /** The structured reading of this guest line, once the reader has returned it. */
  reading?: GuestReading;
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
  idea: string;
  text: string;
  raised: boolean;
}

/** The exact call or choices Sam put to the guest, kept so a later yes can only commit what was offered. */
export interface MeetingOffer {
  proposal?: string;
  choices?: readonly string[];
  openAsk?: boolean;
  /** The exact plain sentence Sam spoke for this offer, repeated verbatim on a silence re-ask. */
  spoken?: string;
}

export interface MeetingView {
  topic: string | undefined;
  phase: MeetingPhase;
  canWait: boolean;
  deadline: string | undefined;
  decision: string | undefined;
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
  /** Realistic ways this topic could be handled, for a plain proposal when the guest leaves a gap. */
  directions: readonly string[];
  /** The reader's readings on this topic, oldest first. */
  readings: readonly { eventId: string; reading: GuestReading }[];
  catchRaised: boolean;
  guestInvited: boolean;
  /** The host has asked the guest to confirm the call and the guest has not answered yet. */
  confirmationAsked: boolean;
  /** Sam has offered a concrete call and is waiting for the guest to agree or correct it. */
  offerAsked: boolean;
  /** The exact call or choices Sam put in that offer. */
  offer: MeetingOffer | undefined;
  /** The specific call Sam asked the guest to confirm, when a confirmation is open. */
  confirmationCall: string | undefined;
  /** The exact plain sentence Sam spoke to read that call back, repeated verbatim on a silence re-ask. */
  confirmationSpoken: string | undefined;
  /** Sam has already asked "which one?" after a bare yes to a choice offer. */
  whichOneAsked: boolean;
  /** How many concrete offers Sam has made on this topic; a topic gets at most two. */
  offers: number;
  /** Colleague questions asked for a missing decision detail on this topic. */
  followUps: number;
  /** The colleague whose role owns this topic. */
  owner: string | undefined;
  guest: string | undefined;
  host: string | undefined;
  present: readonly string[];
  /** What each colleague's role, worries and knowledge are about, for choosing who a point touches. */
  colleagues: readonly { name: string; text: string }[];
}

export interface MeetingStateOptions {
  topics: readonly MeetingTopicInfo[];
  present: readonly string[];
  host?: string;
  guest?: string;
  colleagues?: readonly { name: string; text: string }[];
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
  factIds?: readonly string[];
  catchId?: string;
  catch?: boolean;
}

type LedgerEvent =
  | ({ kind: 'start' } & HeardLineStart)
  | {
    kind: 'end';
    id: string;
    complete: boolean;
    at: number;
    /** Facts carried by the sentences actually heard, even when the whole line was cut off. */
    heardFactIds?: readonly string[];
    /** Complete sentences heard before the line was cut off. */
    sentencesHeard?: number;
  };

interface Ledger {
  events: LedgerEvent[];
  openedAt: number;
  /** The reader's structured reading of each guest line, by event id. */
  readings: Map<string, GuestReading>;
  /** Questions heard before a settle or close: they can never be the open gate again. */
  clearedQuestions: Set<string>;
  confirmationAsked: boolean;
  confirmationCall: string | undefined;
  confirmationSpoken: string | undefined;
  offerAsked: boolean;
  offer: MeetingOffer | undefined;
  whichOneAsked: boolean;
  offers: number;
  followUps: number;
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

/**
 * True when a heard line still carries a catch after a paraphrase: at least two of its content words and
 * a third of them survive. Used only for lines the planner did not tag with an exact catch id, such as the
 * legacy multi-speaker path; a line whose owner merely speaks must not raise a catch.
 */
export function carriesCatchText(line: string, catchText: string): boolean {
  const catchWords = contentWords(catchText);
  if (catchWords.size === 0) return false;
  const lineWords = contentWords(line);
  let shared = 0;
  for (const word of catchWords) if (lineWords.has(word)) shared += 1;
  return shared >= Math.min(2, catchWords.size) && shared / catchWords.size >= 1 / 3;
}

/** Map a validated agenda item to the state's topic shape. */
export function meetingTopic(item: AgendaItem, index: number): MeetingTopicInfo {
  return {
    title: item.title,
    minutes: item.minutes,
    canWait: item.canWait,
    deadline: item.deadline,
    decision: item.decision,
    ...(item.directions === undefined ? {} : { directions: item.directions }),
    facts: (item.briefing ?? []).map((fact, factIndex) => ({
      id: `${index}:${factIndex}`,
      text: fact.text,
      knownBy: fact.knownBy.map((knower) => knower.attendee),
    })),
    catches: (item.discussion?.tradeOffs ?? []).map((tradeOff, catchIndex) => ({
      id: `${index}:catch:${catchIndex}`,
      attendee: tradeOff.attendee,
      idea: tradeOff.idea,
      text: tradeOff.tradeOff,
    })),
  };
}

function emptyView(topic: MeetingTopicInfo | undefined, guest: string | undefined, host: string | undefined, present: readonly string[], colleagues: readonly { name: string; text: string }[]): MeetingView {
  return {
    topic: topic?.title,
    phase: 'handover',
    canWait: topic?.canWait ?? true,
    deadline: topic?.deadline,
    decision: topic?.decision,
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
    directions: topic?.directions ?? [],
    readings: [],
    catchRaised: false,
    guestInvited: false,
    confirmationAsked: false,
    offerAsked: false,
    offer: undefined,
    confirmationCall: undefined,
    confirmationSpoken: undefined,
    whichOneAsked: false,
    offers: 0,
    followUps: 0,
    owner: topic?.owner,
    guest,
    host,
    present,
    colleagues,
  };
}

function derive(
  topic: MeetingTopicInfo | undefined,
  ledger: Ledger | undefined,
  now: number,
  guest: string | undefined,
  host: string | undefined,
  present: readonly string[],
  colleagues: readonly { name: string; text: string }[],
): MeetingView {
  if (topic === undefined || ledger === undefined) {
    return emptyView(topic, guest, host, present, colleagues);
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
    const reading = ledger.readings.get(start.id);
    lines.push({
      eventId: start.id,
      speaker: start.speaker,
      text: start.text,
      at: start.at,
      complete: end?.complete === true,
      ...(start.question === undefined ? {} : { question: start.question }),
      proposal: start.proposal === true || reading?.kind === 'idea',
      ...(start.factId === undefined ? {} : { factId: start.factId }),
      ...(start.factIds === undefined ? {} : { factIds: start.factIds }),
      ...(start.catchId === undefined ? {} : { catchId: start.catchId }),
      catch: start.catch === true,
      ...(end?.heardFactIds === undefined ? {} : { heardFactIds: end.heardFactIds }),
      ...(end?.sentencesHeard === undefined ? {} : { sentencesHeard: end.sentencesHeard }),
      ...(reading === undefined ? {} : { reading }),
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
    idea: entry.idea,
    text: entry.text,
    raised: false,
  }));

  const firstIdeaIndex = lines.findIndex((line) =>
    line.complete && line.speaker === guest && (line.reading?.kind === 'idea' || line.proposal));
  let openQuestion: OpenQuestionView | undefined;
  let lastQuestion: (OpenQuestionView & { answered: boolean }) | undefined;
  let guestInvited = false;
  let guestLastLine: HeardLine | undefined;
  let explicitCatch = false;

  lines.forEach((line, index) => {
    // The guest counts as answering only when the reader says the line answers the open question. A
    // colleague answers only with a whole line that does not put its own question back: a cut-off line
    // or a clarification is not an answer, so the gate stays open until the real answer is heard.
    const answersOpenQuestion = (heardSomething: boolean): boolean => {
      if (line.speaker === guest) {
        return (line.reading === undefined || line.reading.answersOpenQuestion) && heardSomething;
      }
      return line.complete && line.question === undefined;
    };
    if (!line.complete) {
      if (openQuestion !== undefined && line.speaker === openQuestion.to && answersOpenQuestion((line.sentencesHeard ?? 0) > 0)) {
        openQuestion = undefined;
        if (lastQuestion !== undefined) lastQuestion = { ...lastQuestion, answered: true };
      }
      // The sentences the room actually heard still tell their facts when the rest of the line is lost.
      const canNarrate = line.speaker !== guest && line.speaker !== host;
      if (canNarrate && line.heardFactIds !== undefined) {
        for (const id of line.heardFactIds) {
          const fact = facts.find((candidate) =>
            !candidate.told && candidate.id === id && candidate.knownBy.includes(line.speaker));
          if (fact !== undefined) {
            fact.told = true;
            fact.toldBy = line.speaker;
            fact.eventId = line.eventId;
          }
        }
      }
      return;
    }

    if (openQuestion !== undefined && line.speaker === openQuestion.to && answersOpenQuestion(true)) {
      openQuestion = undefined;
      if (lastQuestion !== undefined) lastQuestion = { ...lastQuestion, answered: true };
    }

    if (line.question !== undefined) {
      if (!ledger.clearedQuestions.has(line.eventId)) {
        openQuestion = {
          from: line.speaker,
          to: line.question.to,
          text: line.question.text,
          askedAt: line.at,
          eventId: line.eventId,
        };
      }
      lastQuestion = {
        from: line.speaker,
        to: line.question.to,
        text: line.question.text,
        askedAt: line.at,
        eventId: line.eventId,
        answered: false,
      };
      if (line.speaker === host && line.question.to === guest) guestInvited = true;
    }

    if (line.speaker === guest) guestLastLine = line;

    const speaker = line.speaker;
    const canNarrate = speaker !== guest && speaker !== host;
    if (line.factIds !== undefined) {
      if (canNarrate) {
        for (const id of line.factIds) {
          const fact = facts.find((candidate) => !candidate.told && candidate.id === id && candidate.knownBy.includes(speaker));
          if (fact !== undefined) {
            fact.told = true;
            fact.toldBy = speaker;
            fact.eventId = line.eventId;
          }
        }
      }
    } else {
      const fact = facts.find((candidate) =>
        !candidate.told &&
        canNarrate &&
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
    }

    if (line.catch) explicitCatch = true;
    const canRaiseCatch = speaker !== guest && speaker !== host;
    if (canRaiseCatch && line.catchId !== undefined) {
      const raised = catches.find((entry) => entry.id === line.catchId);
      if (raised !== undefined) raised.raised = true;
    } else if (canRaiseCatch && firstIdeaIndex >= 0 && index > firstIdeaIndex) {
      for (const raised of catches) {
        if (!raised.raised && raised.attendee === speaker && carriesCatchText(line.text, raised.text)) {
          raised.raised = true;
        }
      }
    }
  });

  const catchRaised = explicitCatch || catches.some((entry) => entry.raised);
  const lastHeard = [...lines].reverse().find((line) => line.complete);
  const lastLine = lines.at(-1);
  const guestIdeas = lines.filter((line) =>
    line.complete && line.speaker === guest && (line.reading?.kind === 'idea' || line.proposal));

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
    decision: topic.decision,
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
    directions: topic.directions ?? [],
    readings: lines.flatMap((line) =>
      line.reading === undefined ? [] : [{ eventId: line.eventId, reading: line.reading }]),
    catchRaised,
    guestInvited,
    confirmationAsked: ledger.confirmationAsked,
    offerAsked: ledger.offerAsked,
    offer: ledger.offer,
    confirmationCall: ledger.confirmationCall,
    confirmationSpoken: ledger.confirmationSpoken,
    whichOneAsked: ledger.whichOneAsked,
    offers: ledger.offers,
    followUps: ledger.followUps,
    owner: topic.owner,
    guest,
    host,
    present,
    colleagues,
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
  private readonly colleagues: readonly { name: string; text: string }[];

  constructor(options: MeetingStateOptions) {
    for (const topic of options.topics) this.topics.set(topic.title, topic);
    this.presentNames = [...options.present];
    this.hostName = options.host;
    this.guestName = options.guest;
    this.colleagues = options.colleagues ?? [];
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
      if (ledger === undefined) {
        this.ledgers.set(title, {
          events: [], openedAt: at, readings: new Map(), clearedQuestions: new Set(),
          confirmationAsked: false, confirmationCall: undefined, confirmationSpoken: undefined,
          offerAsked: false, offer: undefined, whichOneAsked: false,
          offers: 0, followUps: 0,
        });
      } else {
        ledger.openedAt = at;
        ledger.confirmationAsked = false;
        ledger.confirmationCall = undefined;
        ledger.confirmationSpoken = undefined;
        ledger.offerAsked = false;
        ledger.offer = undefined;
        ledger.whichOneAsked = false;
      }
    }
    return true;
  }

  /** Attach the reader's structured reading to a guest line that is already in the ledger. */
  recordReading(eventId: string, reading: GuestReading): void {
    const title = this.lineTopics.get(eventId);
    if (title === undefined) return;
    this.ledgers.get(title)?.readings.set(eventId, reading);
  }

  /** Forget every question heard so far: settling or closing a topic means none of them is the live gate. */
  clearOpenQuestion(): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return;
    for (const event of ledger.events) {
      if (event.kind === 'start' && event.question !== undefined) ledger.clearedQuestions.add(event.id);
    }
  }

  /** Mark the host's confirmation question as asked with its exact call and spoken read-back, or clear it. */
  setConfirmationAsked(asked: boolean, call?: string, spoken?: string): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return;
    ledger.confirmationAsked = asked;
    ledger.confirmationCall = asked ? call : undefined;
    ledger.confirmationSpoken = asked ? spoken : undefined;
  }

  /** Mark Sam's concrete offer as asked with the exact call or choices, or clear it once it is answered. */
  setOfferAsked(asked: boolean, offer?: MeetingOffer): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return;
    ledger.offerAsked = asked;
    ledger.offer = asked ? offer : undefined;
    if (!asked) ledger.whichOneAsked = false;
  }

  /** Remember that Sam has already asked which of two offered options the guest means. */
  noteWhichOneAsked(): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger !== undefined) ledger.whichOneAsked = true;
  }

  /** Count one concrete offer the room heard on this topic. */
  noteOffer(): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger !== undefined) ledger.offers += 1;
  }

  /** Count one colleague question that asked the guest for a missing decision detail. */
  noteFollowUp(): void {
    const title = this.current;
    if (title === undefined) return;
    const ledger = this.ledgers.get(title);
    if (ledger !== undefined) ledger.followUps += 1;
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
  lineEnded(
    id: string,
    complete: boolean,
    at: number,
    heard?: { factIds?: readonly string[]; sentencesHeard?: number },
  ): HeardLine | undefined {
    const title = this.lineTopics.get(id);
    if (title === undefined) return undefined;
    const ledger = this.ledgers.get(title);
    if (ledger === undefined) return undefined;
    const ended = ledger.events.some((event) => event.kind === 'end' && event.id === id);
    if (ended) return undefined;
    ledger.events.push({
      kind: 'end', id, complete, at,
      ...(heard?.factIds === undefined ? {} : { heardFactIds: heard.factIds }),
      ...(heard?.sentencesHeard === undefined ? {} : { sentencesHeard: heard.sentencesHeard }),
    });
    return derive(this.topics.get(title), ledger, at, this.guestName, this.hostName, this.presentNames, this.colleagues)
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
    return derive(topic, ledger, now, this.guestName, this.hostName, this.presentNames, this.colleagues);
  }
}
