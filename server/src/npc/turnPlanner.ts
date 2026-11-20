/**
 * The single next action the room should take, chosen from the state after the last heard line.
 *
 * Pure: no I/O, no timers, no model. The caller decides how to speak the line; in shadow mode it only logs it.
 */

import { carriesCatchText, type HeardLine, type MeetingCatchView, type MeetingFactView, type MeetingView } from './meetingState';
import type { GuestReadiness, GuestReading } from './guestReader';

type SpeakPurpose = 'handover' | 'brief' | 'answer' | 'catch' | 'invite' | 'confirm' | 'clarify' | 'defer';

export interface SpeakDecision {
  kind: 'Speak';
  speaker: string;
  purpose: SpeakPurpose;
  /** The heard event this line answers, or undefined for an opening handover. */
  respondsTo: string | undefined;
  /** The briefing facts this step is written to tell, if any. */
  factIds?: readonly string[];
  /** The real catch this step raises, if any. */
  catchId?: string;
  /** A precise instruction for a clarification line, when a generic one would be too vague. */
  clarifyNote?: string;
  /** This clarify line asks the guest for a missing decision detail; it counts towards the two-follow-up cap. */
  followUp?: boolean;
  /** This clarify line asks which of two offered options the guest means; it is not a new offer. */
  whichOne?: boolean;
  reason: string;
}

interface WaitDecision {
  kind: 'Wait';
  reason: string;
  /** A silence the owner rule allows: a second noise in a row needs no reply. */
  allowedSilence?: boolean;
}

export interface ConfirmDecision {
  kind: 'ConfirmDecision';
  reason: string;
  respondsTo?: string;
}

interface PointCardDecision {
  kind: 'PointCard';
  reason: string;
  respondsTo?: string;
}

/** The guest accepted one specific call that was put to them: it can now be committed to the task store. */
export interface CommitDecision {
  kind: 'CommitDecision';
  reason: string;
  respondsTo?: string;
  /** The exact call the guest agreed to: never a bare "yes" or a concatenation of their words. */
  call: string;
}

/** Sam turns the guest's own idea, or two realistic directions, into one concrete call and asks them to agree. */
export interface OfferDecision {
  kind: 'Offer';
  reason: string;
  respondsTo?: string;
  /** The concrete call built from the guest's own latest idea. */
  proposal?: string;
  /** Two plain-language directions when the guest has not given an idea at all. */
  choices?: readonly string[];
  /** The second offer after the two-direction choice was already put: ask what they would rather do, once. */
  openAsk?: boolean;
}

/** The topic closes honestly with no call made: no task, no decision, and the meeting moves on. */
interface UnresolvedDecision {
  kind: 'Unresolved';
  reason: string;
  respondsTo?: string;
}

interface AdvanceDecision {
  kind: 'Advance';
  reason: string;
}

export type PlannerDecision =
  | SpeakDecision
  | WaitDecision
  | ConfirmDecision
  | CommitDecision
  | OfferDecision
  | UnresolvedDecision
  | PointCardDecision
  | AdvanceDecision;

/** What just happened and caused the planner to look at the state. */
export type PlannerEvent =
  | { kind: 'topicOpened' }
  | { kind: 'heard'; line: HeardLine; reading?: GuestReading }
  | { kind: 'interrupted'; line: HeardLine }
  | { kind: 'guestDecision'; line: HeardLine; reading?: GuestReading }
  | { kind: 'decisionConfirmed' }
  | { kind: 'cardDue' }
  | { kind: 'cardSent' };

function speak(
  speaker: string,
  purpose: SpeakPurpose,
  respondsTo: string | undefined,
  reason: string,
  factIds?: readonly string[],
  catchId?: string,
  clarifyNote?: string,
  followUp?: boolean,
  whichOne?: boolean,
): SpeakDecision {
  return {
    kind: 'Speak', speaker, purpose, respondsTo,
    ...(factIds === undefined ? {} : { factIds }),
    ...(catchId === undefined ? {} : { catchId }),
    ...(clarifyNote === undefined ? {} : { clarifyNote }),
    ...(followUp === undefined ? {} : { followUp }),
    ...(whichOne === undefined ? {} : { whichOne }),
    reason,
  };
}

function wait(reason: string, allowedSilence = false): WaitDecision {
  return { kind: 'Wait', reason, ...(allowedSilence ? { allowedSilence: true } : {}) };
}

function unresolved(reason: string, respondsTo?: string): UnresolvedDecision {
  return { kind: 'Unresolved', reason, ...(respondsTo === undefined ? {} : { respondsTo }) };
}

/** One line for the shadow log: `Speak Sam (handover)`, `Wait`, and so on. */
export function describeDecision(decision: PlannerDecision): string {
  switch (decision.kind) {
    case 'Speak':
      return `Speak ${decision.speaker} (${decision.purpose})`;
    case 'Wait':
      return 'Wait';
    case 'ConfirmDecision':
      return 'ConfirmDecision';
    case 'CommitDecision':
      return 'CommitDecision';
    case 'Offer':
      return 'Offer';
    case 'Unresolved':
      return 'Unresolved';
    case 'PointCard':
      return 'PointCard';
    case 'Advance':
      return 'Advance';
  }
}

function isColleague(view: MeetingView, name: string): boolean {
  return name !== view.guest && view.present.includes(name);
}

/** The complete AI lines heard since the guest last spoke, so a guest line gets at most two answers. */
function respondersSinceGuest(view: MeetingView): HeardLine[] {
  let guestIndex = -1;
  for (let index = view.lines.length - 1; index >= 0; index -= 1) {
    const line = view.lines[index]!;
    if (line.complete && line.speaker === view.guest) {
      guestIndex = index;
      break;
    }
  }
  return guestIndex < 0
    ? []
    : view.lines.slice(guestIndex + 1).filter((line) => line.complete && line.speaker !== view.guest);
}

/** The reading the planner should use for this line: the event's, the line's, or the one stored in the view. */
function readingFor(view: MeetingView, line: HeardLine, fromEvent?: GuestReading): GuestReading | undefined {
  return fromEvent ?? line.reading ?? view.readings.find((entry) => entry.eventId === line.eventId)?.reading;
}

/** The reading before this line, used to spot a second noise attempt in a row. */
function previousReading(view: MeetingView, line: HeardLine): GuestReading | undefined {
  for (let index = view.readings.length - 1; index >= 0; index -= 1) {
    const entry = view.readings[index]!;
    if (entry.eventId !== line.eventId) return entry.reading;
  }
  return undefined;
}

/**
 * Every slot covered by any reading on this topic; a slot once covered with valid evidence stays covered.
 * A call is often given across several lines, so the action evidence is every distinct action quote on this
 * topic, oldest first, restarting at a line the reader marked as changing the call: the host reads back and
 * commits the whole standing call, not just the latest line. The other
 * slots keep their latest evidence. Practical is kept for wording only.
 */
export function mergedReadiness(view: MeetingView): GuestReadiness {
  const merged: GuestReadiness = {
    action: { covered: false },
    catchAddressed: { covered: false },
    practical: { covered: false },
  };
  const actionParts: string[] = [];
  for (const { reading } of view.readings) {
    for (const name of ['catchAddressed', 'practical'] as const) {
      if (reading.readiness[name].covered) merged[name] = reading.readiness[name];
    }
    const action = reading.readiness.action;
    const evidence = action.covered ? action.evidence?.trim() : undefined;
    if (evidence === undefined || evidence.length === 0) continue;
    // A changed call replaces what came before; otherwise the line adds to the call.
    if (action.revises === true) actionParts.length = 0;
    addCallPart(actionParts, evidence);
  }
  if (actionParts.length > 0) merged.action = { covered: true, evidence: joinCallParts(actionParts) };
  return merged;
}

/**
 * The guest lines whose readings make up the standing call (the lines behind mergedReadiness's action
 * evidence, restarting at a line that changed the call). A read-back is written from these whole lines, so a
 * part the reader quoted only in short is not lost, and a line that added nothing to the call (such as a
 * refused request to table it) is not read back.
 */
export function standingCallEventIds(view: MeetingView): ReadonlySet<string> {
  const ids: string[] = [];
  for (const { eventId, reading } of view.readings) {
    const action = reading.readiness.action;
    const evidence = action.covered ? action.evidence?.trim() : undefined;
    if (evidence === undefined || evidence.length === 0) continue;
    if (action.revises === true) ids.length = 0;
    ids.push(eventId);
  }
  return new Set(ids);
}

function normalisedCallPart(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/u, '').trim();
}

/** Add one action quote, skipping a repeat and letting a longer quote replace the shorter one it contains. */
function addCallPart(parts: string[], evidence: string): void {
  const next = normalisedCallPart(evidence);
  if (parts.some((part) => normalisedCallPart(part).includes(next))) return;
  const kept = parts.filter((part) => !next.includes(normalisedCallPart(part)));
  parts.splice(0, parts.length, ...kept, evidence);
}

function joinCallParts(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]!;
  return parts.map((part) => (/[.!?…]["')\]]*$/u.test(part) ? part : `${part}.`)).join(' ');
}

/** A catch can be raised only by a colleague who is actually in the room. */
function canBeRaised(view: MeetingView, entry: MeetingCatchView, exclude?: string): boolean {
  return entry.attendee !== view.guest && entry.attendee !== view.host &&
    entry.attendee !== exclude && view.present.includes(entry.attendee);
}

/** True when the reader linked this idea to a catch that a present colleague can raise. */
function ideaHasLinkedCatch(view: MeetingView, reading: GuestReading): boolean {
  return reading.relevantCatchIds.some((id) =>
    view.catches.some((entry) => entry.id === id && canBeRaised(view, entry)));
}

function firstIdeaIndex(view: MeetingView): number {
  if (view.guestFirstIdea === undefined) return -1;
  return view.lines.findIndex((line) => line.eventId === view.guestFirstIdea?.eventId);
}

function catchIndexAfterIdea(view: MeetingView): number {
  const ideaIndex = firstIdeaIndex(view);
  if (ideaIndex < 0) return -1;
  return view.lines.findIndex((line, index) =>
    index > ideaIndex && line.complete && line.speaker !== view.guest && line.speaker !== view.host &&
    (line.catch || line.catchId !== undefined));
}

/** The guest has heard the first idea's catch and answered it with any line of their own. */
function guestSpokeAfterCatch(view: MeetingView): boolean {
  if (!view.catchRaised) return false;
  const ideaIndex = firstIdeaIndex(view);
  if (ideaIndex < 0) return true;
  const catchIndex = catchIndexAfterIdea(view);
  let lastGuestIndex = -1;
  view.lines.forEach((line, index) => {
    if (line.complete && line.speaker === view.guest) lastGuestIndex = index;
  });
  return catchIndex < 0 ? lastGuestIndex > ideaIndex : lastGuestIndex > catchIndex;
}

/**
 * Workable readiness: the guest has chosen an action with valid evidence. When the reader linked the first idea
 * to a catch a present colleague can raise, that catch is raised and the guest speaks once after it. They need
 * not solve the catch, and who/when is not a gate. An idea with no linked catch is never held back waiting for one.
 */
export function readinessMet(view: MeetingView): boolean {
  if (view.guest !== undefined && view.openQuestion?.to === view.guest) return false;
  const firstIdea = view.guestFirstIdea;
  const firstIdeaReading = firstIdea === undefined ? undefined : readingFor(view, firstIdea);
  if (firstIdeaReading !== undefined && ideaHasLinkedCatch(view, firstIdeaReading) && !guestSpokeAfterCatch(view)) {
    return false;
  }
  return mergedReadiness(view).action.covered;
}

/** Keep at most two colleague questions for missing details; after that Sam offers a call instead. */
export const MAX_FOLLOW_UPS = 2;

/** A topic gets at most two concrete offers: first the guest's idea or the directions, then the directions or one open ask. */
export const MAX_OFFERS = 2;

/** The first sentence of one scenario direction, in plain words. */
export function plainDirection(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text.trim();
  return first.replace(/[.!?]+$/u, '').trim();
}

/**
 * The first offer turns the guest's own latest idea, or two realistic directions, into one concrete call.
 * The second offer puts the two directions (or, if they were already offered, one open "what would you rather do?").
 */
function offerDecision(view: MeetingView, line: HeardLine, reason: string): OfferDecision {
  const withIdea = [...view.readings].reverse()
    .find(({ reading }) => reading.kind === 'idea' && reading.readiness.action.covered);
  const choices = view.directions.slice(0, 2).map(plainDirection).filter((choice) => choice.length > 0);
  if (view.offers === 0) {
    const proposal = withIdea?.reading.readiness.action.evidence ?? mergedReadiness(view).action.evidence;
    if (proposal !== undefined) {
      return { kind: 'Offer', reason, respondsTo: line.eventId, proposal };
    }
    return { kind: 'Offer', reason, respondsTo: line.eventId, ...(choices.length === 0 ? {} : { choices }) };
  }
  // Offer 1 was the guest's own call: offer 2 puts the two realistic directions instead.
  if (withIdea !== undefined && choices.length > 0) {
    return { kind: 'Offer', reason, respondsTo: line.eventId, choices };
  }
  // Offer 1 was already the two-direction choice: offer 2 asks what they would rather do, once.
  return { kind: 'Offer', reason, respondsTo: line.eventId, openAsk: true };
}

function hostOf(view: MeetingView): string | undefined {
  return view.host !== undefined && isColleague(view, view.host) ? view.host : undefined;
}

function factKnower(view: MeetingView, id: string): string | undefined {
  const fact = view.facts.find((entry) => entry.id === id);
  return fact === undefined ? undefined : canTell(view, fact);
}

/** A relevant fact the room has not heard yet: an answer may use a told fact from the transcript, never be required to. */
function untoldFactKnower(view: MeetingView, id: string): string | undefined {
  const fact = view.facts.find((entry) => entry.id === id);
  return fact === undefined || fact.told ? undefined : canTell(view, fact);
}

/** The colleague whose fact best helps from the ids the reader picked, if any. */
function factHelper(view: MeetingView, reading: GuestReading): string | undefined {
  for (const id of reading.relevantFactIds) {
    const knower = factKnower(view, id);
    if (knower !== undefined) return knower;
  }
  return undefined;
}

/** The colleague best placed to help with a confused guest: a relevant fact knower, the topic owner, then the host. */
function bestHelper(view: MeetingView, reading: GuestReading): string | undefined {
  const knower = factHelper(view, reading);
  if (knower !== undefined) return knower;
  if (view.owner !== undefined && isColleague(view, view.owner)) return view.owner;
  return hostOf(view);
}

/** The catch the reader linked to this idea that is still open, if a present colleague can raise it. */
function requestedCatch(view: MeetingView, reading: GuestReading, exclude?: string): MeetingCatchView | undefined {
  for (const id of reading.relevantCatchIds) {
    const catchEntry = view.catches.find((entry) =>
      entry.id === id && !entry.raised && canBeRaised(view, entry, exclude));
    if (catchEntry !== undefined) return catchEntry;
  }
  return undefined;
}

/** An urgent park: explain the deadline once, then offer a concrete call; never park it and never loop. */
function parkDecision(view: MeetingView, line: HeardLine, _reading: GuestReading): PlannerDecision {
  const host = hostOf(view);
  if (view.canWait) {
    return host === undefined
      ? wait('the guest parked a topic that can wait, but no host is present to confirm the later slot')
      : speak(host, 'defer', line.eventId,
        `the guest parked a topic that can wait; confirm the later slot "${view.deadline ?? 'later'}"`);
  }
  const attempts = view.readings.filter((entry) => entry.reading.kind === 'park').length;
  if (attempts >= 3) {
    return unresolved('the guest has left this urgent topic open three times; no call made', line.eventId);
  }
  if (attempts === 2) {
    return view.offers >= MAX_OFFERS
      ? unresolved('the guest parked the topic again after two offers; no call made', line.eventId)
      : offerDecision(view, line, 'a second park attempt on an urgent topic: offer one concrete call');
  }
  const owner = view.owner !== undefined && isColleague(view, view.owner) ? view.owner : undefined;
  if (owner !== undefined && owner !== host) {
    return speak(owner, 'clarify', line.eventId,
      `${owner} explains the deadline "${view.deadline ?? 'today'}" once, because this topic cannot wait`, undefined, undefined,
      `Explain plainly once that this must be decided "${view.deadline ?? 'today'}" and why it cannot wait. Then stop.`);
  }
  return host === undefined
    ? wait('the guest parked an urgent topic, but no host is present')
    : speak(host, 'clarify', line.eventId,
      'explain the deadline once, then stop and give the guest the floor', undefined, undefined,
      `Explain plainly that this must be decided "${view.deadline ?? 'today'}". Do not ask a question.`);
}

/** How the room answers a guest line, from the reader's structured meaning and never from its words. */
function guestLineDecision(view: MeetingView, line: HeardLine, reading: GuestReading | undefined): PlannerDecision {
  if (reading === undefined) return wait('the guest line has no reading yet');
  const host = hostOf(view);

  // A short listener sound said while someone else was talking means "go on": no reply and no gate answer.
  if (reading.kind === 'backchannel') return wait('a listener backchannel; the room carries on', true);

  const confirmationCall = view.confirmationCall ?? mergedReadiness(view).action.evidence;
  if (view.confirmationAsked && reading.kind === 'agree' && confirmationCall !== undefined) {
    return {
      kind: 'CommitDecision',
      reason: "the guest agreed to the host's confirmation",
      respondsTo: line.eventId,
      call: confirmationCall,
    };
  }

  if (view.offerAsked) {
    const choices = view.offer?.choices;
    if (reading.chosenOption !== undefined && choices !== undefined && choices[reading.chosenOption] !== undefined) {
      return {
        kind: 'CommitDecision',
        reason: 'the guest chose one of the options Sam offered',
        respondsTo: line.eventId,
        call: choices[reading.chosenOption]!,
      };
    }
    if (reading.kind === 'agree') {
      if (view.offer?.proposal !== undefined) {
        return {
          kind: 'CommitDecision',
          reason: "the guest agreed to Sam's offer",
          respondsTo: line.eventId,
          call: view.offer.proposal,
        };
      }
      if (view.offer?.choices !== undefined || view.offer?.openAsk === true) {
        // A bare yes does not pick between two calls: ask which one once, then close honestly.
        if (view.whichOneAsked) {
          return unresolved('the guest agreed again without choosing one of the offers; no call made', line.eventId);
        }
        return host === undefined
          ? unresolved('the guest agreed without choosing, but no host is present to ask which one', line.eventId)
          : speak(host, 'clarify', line.eventId,
            'the guest agreed to a two-option offer; ask which one, once', undefined, undefined,
            'Ask the guest which of the offered options they mean, in one short line. Do not make a new offer.',
            undefined, true);
      }
      // An offer stored without details (an older state): commit the call the guest actually covered.
      const fallback = mergedReadiness(view).action.evidence;
      if (fallback !== undefined) {
        return {
          kind: 'CommitDecision',
          reason: "the guest agreed to Sam's offer",
          respondsTo: line.eventId,
          call: fallback,
        };
      }
    }
    if (view.whichOneAsked && (reading.kind === 'unsure' || reading.kind === 'noise')) {
      return unresolved('the guest did not choose between the offers; no call made', line.eventId);
    }
  }

  if (reading.kind === 'noise') {
    if (previousReading(view, line)?.kind === 'noise') {
      return wait('a second noise in a row; the silence timers will follow up from here', true);
    }
    return host === undefined
      ? wait('the guest may not be heard, but no host is present to check')
      : speak(host, 'clarify', line.eventId, 'the guest may not be heard; check once and restate the question', undefined, undefined,
        'Check once that they can be heard, then restate the open question in one short line.');
  }

  // Two offers are the cap. A question or an addressed line is still answered normally; a covered call is
  // confirmed; anything else closes the topic honestly rather than offering a third time.
  if (view.offers >= MAX_OFFERS) {
    if (reading.addressee !== undefined && reading.addressee !== view.host &&
        isColleague(view, reading.addressee)) {
      return speak(reading.addressee, 'answer', line.eventId, `the guest addressed ${reading.addressee}`);
    }
    if (reading.kind === 'question') {
      for (const id of reading.relevantFactIds) {
        const knower = untoldFactKnower(view, id);
        if (knower !== undefined) {
          return speak(knower, 'answer', line.eventId, `${knower} knows a fact that answers the guest's point`, [id]);
        }
      }
      const helper = bestHelper(view, reading);
      if (helper !== undefined) {
        return speak(helper, 'answer', line.eventId, `${helper} can answer the guest's question directly`);
      }
      return unresolved('the guest asked a question after two offers, but nobody present can answer it', line.eventId);
    }
    if (reading.readiness.action.covered || readinessMet(view)) {
      return {
        kind: 'ConfirmDecision',
        reason: 'the guest chose a call after two offers; confirm it instead of offering again',
        respondsTo: line.eventId,
      };
    }
    return unresolved('two offers have already been made and the guest did not choose a call', line.eventId);
  }

  if (reading.kind === 'park') return parkDecision(view, line, reading);

  if (reading.kind === 'unsure') {
    const helpLines = view.readings.filter((entry) => entry.reading.kind === 'unsure').length;
    if (helpLines >= 3) {
      return offerDecision(view, line, 'a third confused line: offer one concrete call instead of another help line');
    }
    const helper = factHelper(view, reading) ?? host;
    return helper === undefined
      ? unresolved('the guest is unsure, but nobody present can offer help', line.eventId)
      : speak(helper, 'clarify', line.eventId, 'the guest is unsure; offer a short, specific help line', undefined, undefined,
        'Offer the two most realistic options for this topic in plain words, then ask which one they want.');
  }

  if (reading.kind === 'off_topic') {
    return host === undefined
      ? unresolved('the guest is off topic, but no host is present to steer back', line.eventId)
      : speak(host, 'clarify', line.eventId, "steer back to this topic's decision in one line", undefined, undefined,
        'Steer back to this topic and its decision in one short line. Do not answer the off-topic remark.');
  }

  // The host is the one Sam is speaking to, so a line addressed to the host is the guest answering Sam,
  // not a hand-off to a colleague. Readiness decides the next step, as for any other guest answer.
  if (reading.addressee !== undefined && reading.addressee !== view.host &&
      isColleague(view, reading.addressee)) {
    return speak(reading.addressee, 'answer', line.eventId, `the guest addressed ${reading.addressee}`);
  }

  // After any offer, a guest line that chooses a call is confirmed straight away, with no new follow-ups.
  if ((view.offers > 0 || view.offerAsked) && reading.kind !== 'agree' && reading.readiness.action.covered) {
    return {
      kind: 'ConfirmDecision',
      reason: 'the guest corrected the offer; confirm the corrected call straight away',
      respondsTo: line.eventId,
    };
  }

  // Two colleague follow-ups are enough: the next step is Sam's concrete offer, even if the guest now adds an idea.
  if (view.followUps >= MAX_FOLLOW_UPS && !view.offerAsked && !view.confirmationAsked &&
      (reading.kind === 'idea' || reading.kind === 'answer')) {
    return offerDecision(view, line, 'two follow-ups have already been asked; offer one concrete call');
  }

  if (reading.kind === 'idea') {
    const owner = requestedCatch(view, reading);
    if (owner !== undefined) {
      return speak(owner.attendee, 'catch', line.eventId,
        `${owner.attendee}'s catch on the guest's idea is still unraised`, undefined, owner.id);
    }
  }

  if (reading.kind === 'question' || reading.kind === 'answer' || reading.kind === 'idea' || reading.kind === 'agree') {
    for (const id of reading.relevantFactIds) {
      const knower = untoldFactKnower(view, id);
      if (knower !== undefined) {
        return speak(knower, 'answer', line.eventId, `${knower} knows a fact that answers the guest's point`, [id]);
      }
    }
  }

  if (reading.kind === 'question') {
    const helper = bestHelper(view, reading);
    if (helper !== undefined) {
      return speak(helper, 'answer', line.eventId, `${helper} can answer the guest's question directly`);
    }
    return unresolved('the guest asked a question, but nobody present can answer it', line.eventId);
  }

  if (readinessMet(view)) {
    return {
      kind: 'ConfirmDecision',
      reason: `the guest has chosen a workable action; ${host ?? 'the host'} should confirm it`,
      respondsTo: line.eventId,
    };
  }

  if (!mergedReadiness(view).action.covered) {
    if (view.followUps >= MAX_FOLLOW_UPS) {
      return offerDecision(view, line, 'the guest has not chosen an action after two follow-ups; offer one concrete call');
    }
    const helper = bestHelper(view, reading) ?? host;
    if (helper !== undefined) {
      return speak(helper, 'clarify', line.eventId, 'the guest has not chosen an action yet; ask for one missing detail',
        undefined, undefined,
        'Ask the guest one short question about what they want to do. Do not offer a menu and do not ask about who or when.',
        true);
    }
    return unresolved('the guest has not chosen an action and nobody present can ask for one', line.eventId);
  }

  // The action is covered but the topic is not ready: raise the first idea's linked catch, or restate what is open.
  if (view.guestFirstIdea !== undefined) {
    const firstIdeaReading = readingFor(view, view.guestFirstIdea);
    const owner = firstIdeaReading === undefined ? undefined : requestedCatch(view, firstIdeaReading);
    if (owner !== undefined) {
      return speak(owner.attendee, 'catch', line.eventId,
        `${owner.attendee}'s catch on the first idea is still unraised`, undefined, owner.id);
    }
  }
  if (host !== undefined) {
    return speak(host, 'clarify', line.eventId, 'the guest has not answered what is still open; restate it once',
      undefined, undefined, 'Restate the one thing still open in a short line. Do not add a new question.');
  }
  return unresolved('the guest has a call, but nothing present can move the topic on', line.eventId);
}

/** A second colleague speaks only for the first idea's unraised catch; otherwise the guest has the floor. */
function secondSpeakerDecision(view: MeetingView, responders: readonly HeardLine[]): PlannerDecision {
  if (responders.length === 0) return wait('the guest has the floor');
  if (responders.length >= 2) return wait('the guest line already has its two speakers');
  const first = responders[0]!;

  if (view.guestFirstIdea !== undefined && view.guestLastLine?.eventId === view.guestFirstIdea.eventId && !view.catchRaised) {
    const firstIdeaReading = readingFor(view, view.guestFirstIdea);
    const owner = firstIdeaReading === undefined ? undefined : requestedCatch(view, firstIdeaReading, first.speaker);
    if (owner !== undefined) {
      return speak(owner.attendee, 'catch', view.guestFirstIdea.eventId,
        `${first.speaker} did not raise ${owner.attendee}'s catch on the first idea`, undefined, owner.id);
    }
  }

  return wait('nothing new to add; waiting for the guest');
}

function canTell(view: MeetingView, fact: MeetingFactView): string | undefined {
  return fact.knownBy.find((name) => isColleague(view, name) && name !== view.host);
}

function firstFactTeller(view: MeetingView): string | undefined {
  for (const fact of view.facts) {
    if (fact.told) continue;
    const teller = canTell(view, fact);
    if (teller !== undefined) return teller;
  }
  return undefined;
}

/**
 * The first untold briefing fact's teller, plus any following consecutive facts the same colleague knows.
 * A fact nobody present can tell is skipped; a different teller starts the next step.
 */
function nextBriefStep(view: MeetingView): { speaker: string; factIds: string[] } | undefined {
  let speaker: string | undefined;
  const factIds: string[] = [];
  for (const fact of view.facts) {
    if (fact.told) continue;
    const teller = canTell(view, fact);
    if (teller === undefined) continue;
    if (speaker === undefined) {
      speaker = teller;
      factIds.push(fact.id);
      continue;
    }
    if (teller !== speaker) break;
    factIds.push(fact.id);
  }
  return speaker === undefined ? undefined : { speaker, factIds };
}

/** No untold fact is left that someone in the room could tell. */
function factsSettled(view: MeetingView): boolean {
  return view.facts.every((fact) => fact.told || canTell(view, fact) === undefined);
}

/**
 * The next speaker, in order: in the opening, the colleague who can tell the next briefing fact(s), then the
 * host's one question; otherwise the named addressee of an open question, the knower who can answer the guest's
 * last point, the colleague holding an unraised catch on the guest's first idea, the host for a handover,
 * one invitation or a confirmation. Nothing relevant to add means wait for the guest.
 */
export function next(view: MeetingView, event: PlannerEvent): PlannerDecision {
  if (event.kind === 'topicOpened') {
    const teller = firstFactTeller(view);
    if (view.host === undefined) return wait('no host is present to hand the topic over');
    return speak(
      view.host,
      'handover',
      undefined,
      teller === undefined
        ? 'opening the topic; no briefing fact has a present knower'
        : `opening the topic and handing it to ${teller}, who knows the first briefing fact`,
    );
  }

  // The opening is planner-owned: the handover's question is answered by the brief step, not by an answer turn.
  if (event.kind === 'heard' && event.line.speaker !== view.guest &&
      view.guestFirstIdea === undefined && !view.guestInvited && view.guestLastLine === undefined) {
    const step = nextBriefStep(view);
    if (step !== undefined) {
      return speak(
        step.speaker,
        'brief',
        event.line.eventId,
        `${step.speaker} has the next briefing fact the room has not heard`,
        step.factIds,
      );
    }
    if (factsSettled(view) && view.host !== undefined) {
      return speak(view.host, 'invite', event.line.eventId, 'the briefing is done and the guest has not been invited once');
    }
  }

  // The guest's own line outranks any question left open before it: the reading decides who answers.
  if (event.kind === 'heard' && event.line.speaker === view.guest) {
    return guestLineDecision(view, event.line, readingFor(view, event.line, event.reading));
  }

  // A guest line gets at most two AI speakers, even when the second one asks a third colleague a question.
  if (event.kind === 'heard' && view.guest !== undefined && respondersSinceGuest(view).length >= 2) {
    return wait('the guest line already has its two AI speakers');
  }

  const question = view.openQuestion;
  if (question !== undefined) {
    if (question.to === view.guest) return wait(`the open question is addressed to ${view.guest}`);
    if (isColleague(view, question.to)) {
      return speak(question.to, 'answer', question.eventId, `${question.to} was asked "${question.text}"`);
    }
    return wait(`the open question names ${question.to}, who is not in the room`);
  }

  if (event.kind === 'interrupted') {
    return wait('the last line was cut off before it was fully heard');
  }

  if (event.kind === 'heard') {
    return secondSpeakerDecision(view, respondersSinceGuest(view));
  }

  if (event.kind === 'guestDecision') {
    if (view.guestFirstIdea !== undefined) {
      const firstIdeaReading = readingFor(view, view.guestFirstIdea);
      const owner = firstIdeaReading === undefined ? undefined : requestedCatch(view, firstIdeaReading);
      if (owner !== undefined) {
        return speak(owner.attendee, 'catch', event.line.eventId, `${owner.attendee}'s catch on the first idea is still unraised`, undefined, owner.id);
      }
    }
    if (!readinessMet(view)) return wait('the guest has not chosen a workable action yet');
    return {
      kind: 'ConfirmDecision',
      reason: `${view.host ?? 'the host'} can confirm ${view.guest ?? 'the guest'}'s call before the card`,
      respondsTo: event.line.eventId,
    };
  }

  if (event.kind === 'decisionConfirmed' || event.kind === 'cardDue') {
    if (view.openQuestion !== undefined) return wait('a question is still open before the card');
    const firstIdeaReading = view.guestFirstIdea === undefined ? undefined : readingFor(view, view.guestFirstIdea);
    if (firstIdeaReading !== undefined && requestedCatch(view, firstIdeaReading) !== undefined) {
      return wait('the first idea has not had its linked catch yet');
    }
    if (!readinessMet(view)) return wait('the decision is not ready for the card');
    return { kind: 'PointCard', reason: 'the call is confirmed and nothing is still open' };
  }

  if (event.kind === 'cardSent') {
    return { kind: 'Advance', reason: 'the follow-up card is sent; the topic can move on' };
  }

  return wait('nothing to say');
}

/**
 * The view as it would be if `line` had just finished playing and its `factIds` were heard. Used only to start
 * the next opening speaker's request while the current line is still playing; the real ledger is the authority.
 */
export function projectHeard(view: MeetingView, line: HeardLine, factIds: readonly string[] = []): MeetingView {
  const told = new Set(factIds);
  const facts: MeetingFactView[] = view.facts.map((fact) =>
    !fact.told && told.has(fact.id) && fact.knownBy.includes(line.speaker)
      ? { ...fact, told: true, toldBy: line.speaker, eventId: line.eventId }
      : fact);
  const lines = [...view.lines, line];
  const answersOpenQuestion = line.speaker === view.guest
    ? line.reading === undefined || line.reading.answersOpenQuestion
    : line.answersQuestion === true && line.question === undefined;
  const openQuestion = line.question === undefined
    ? (answersOpenQuestion && view.openQuestion?.to === line.speaker ? undefined : view.openQuestion)
    : { from: line.speaker, to: line.question.to, text: line.question.text, askedAt: line.at, eventId: line.eventId };
  const guestInvited = view.guestInvited ||
    (line.speaker === view.host && line.question?.to !== undefined && line.question.to === view.guest);
  const guestFirstIdea = view.guestFirstIdea ??
    (line.speaker === view.guest && line.proposal ? line : undefined);
  // A line raises one exact catch, or a legacy untagged line raises the catch its own words actually carry.
  const canRaiseCatch = line.speaker !== view.guest && line.speaker !== view.host;
  const catches = !canRaiseCatch
    ? view.catches
    : line.catchId !== undefined
      ? view.catches.map((entry) =>
        !entry.raised && entry.id === line.catchId ? { ...entry, raised: true } : entry)
      : guestFirstIdea !== undefined
        ? view.catches.map((entry) =>
          !entry.raised && entry.attendee === line.speaker && carriesCatchText(line.text, entry.text)
            ? { ...entry, raised: true }
            : entry)
        : view.catches;
  return {
    ...view,
    lines,
    lastHeard: line.complete ? line : view.lastHeard,
    lastLine: line,
    facts,
    factsTold: facts.filter((fact) => fact.told).map((fact) => fact.id),
    catches,
    openQuestion,
    guestInvited,
    guestFirstIdea,
    guestLastLine: line.speaker === view.guest ? line : view.guestLastLine,
    catchRaised: view.catchRaised || line.catch || catches.some((entry) => entry.raised),
  };
}
