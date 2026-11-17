/**
 * The single next action the room should take, chosen from the state after the last heard line.
 *
 * Pure: no I/O, no timers, no model. The caller decides how to speak the line; in shadow mode it only logs it.
 */

import { contentWords, type HeardLine, type MeetingCatchView, type MeetingFactView, type MeetingView } from './meetingState';

export type SpeakPurpose = 'handover' | 'brief' | 'answer' | 'catch' | 'invite' | 'confirm' | 'clarify';

export interface SpeakDecision {
  kind: 'Speak';
  speaker: string;
  purpose: SpeakPurpose;
  /** The heard event this line answers, or undefined for an opening handover. */
  respondsTo: string | undefined;
  /** The briefing facts this step is written to tell, if any. */
  factIds?: readonly string[];
  reason: string;
}

export interface WaitDecision {
  kind: 'Wait';
  reason: string;
}

export interface ConfirmDecision {
  kind: 'ConfirmDecision';
  reason: string;
  respondsTo?: string;
}

export interface PointCardDecision {
  kind: 'PointCard';
  reason: string;
  respondsTo?: string;
}

export interface AdvanceDecision {
  kind: 'Advance';
  reason: string;
}

export type PlannerDecision =
  | SpeakDecision
  | WaitDecision
  | ConfirmDecision
  | PointCardDecision
  | AdvanceDecision;

/** What just happened and caused the planner to look at the state. */
export type PlannerEvent =
  | { kind: 'topicOpened' }
  | { kind: 'heard'; line: HeardLine }
  | { kind: 'interrupted'; line: HeardLine }
  | { kind: 'guestDecision'; line: HeardLine }
  | { kind: 'decisionConfirmed' }
  | { kind: 'cardDue' }
  | { kind: 'cardSent' };

function speak(
  speaker: string,
  purpose: SpeakPurpose,
  respondsTo: string | undefined,
  reason: string,
  factIds?: readonly string[],
): SpeakDecision {
  return { kind: 'Speak', speaker, purpose, respondsTo, ...(factIds === undefined ? {} : { factIds }), reason };
}

function wait(reason: string): WaitDecision {
  return { kind: 'Wait', reason };
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
    case 'PointCard':
      return 'PointCard';
    case 'Advance':
      return 'Advance';
  }
}

function isColleague(view: MeetingView, name: string): boolean {
  return name !== view.guest && view.present.includes(name);
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

function matchingFact(view: MeetingView, text: string): MeetingFactView | undefined {
  let best: { fact: MeetingFactView; overlap: number } | undefined;
  for (const fact of view.facts) {
    if (fact.told || canTell(view, fact) === undefined) continue;
    const overlap = countOverlap(fact.text, text);
    if (overlap === 0) continue;
    if (best === undefined || overlap > best.overlap) best = { fact, overlap };
  }
  return best?.fact;
}

function countOverlap(left: string, right: string): number {
  const rightWords = contentWords(right);
  let count = 0;
  for (const word of contentWords(left)) if (rightWords.has(word)) count += 1;
  return count;
}

/** The knower of the fact that most closely answers the guest's last point. */
function knowerForGuestPoint(view: MeetingView, text: string): string | undefined {
  const fact = matchingFact(view, text);
  return fact === undefined ? undefined : canTell(view, fact);
}

/** One colleague with a real catch on the first idea that the room has not heard yet. */
function unraisedCatchOwner(view: MeetingView, exclude: string | undefined): MeetingCatchView | undefined {
  return view.catches.find((entry) =>
    !entry.raised &&
    entry.attendee !== view.guest &&
    entry.attendee !== view.host &&
    entry.attendee !== exclude &&
    view.present.includes(entry.attendee));
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
      view.guestFirstIdea === undefined && !view.guestInvited) {
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

  if (event.kind === 'heard' && event.line.speaker === view.guest) {
    const knower = knowerForGuestPoint(view, event.line.text);
    if (knower !== undefined) {
      return speak(knower, 'answer', event.line.eventId, `${knower} knows a fact that answers ${event.line.speaker}'s last point`);
    }
    if (view.guestFirstIdea?.eventId === event.line.eventId && !view.catchRaised) {
      const owner = unraisedCatchOwner(view, event.line.speaker);
      if (owner !== undefined) {
        return speak(owner.attendee, 'catch', event.line.eventId, `${owner.attendee}'s catch on the first idea is still unraised`);
      }
    }
    return wait('nothing new to add; the guest has the floor');
  }

  if (event.kind === 'heard') {
    return wait('nothing new to add; waiting for the guest');
  }

  if (event.kind === 'guestDecision') {
    if (view.guestFirstIdea !== undefined && !view.catchRaised) {
      const owner = unraisedCatchOwner(view, undefined);
      if (owner !== undefined) {
        return speak(owner.attendee, 'catch', event.line.eventId, `${owner.attendee}'s catch on the first idea is still unraised`);
      }
    }
    return {
      kind: 'ConfirmDecision',
      reason: `${view.host ?? 'the host'} can confirm ${view.guest ?? 'the guest'}'s call before the card`,
      respondsTo: event.line.eventId,
    };
  }

  if (event.kind === 'decisionConfirmed' || event.kind === 'cardDue') {
    if (view.openQuestion !== undefined) return wait('a question is still open before the card');
    if (!view.catchRaised && view.guestFirstIdea !== undefined) return wait('the first idea has not had its catch yet');
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
  const openQuestion = line.question === undefined
    ? (view.openQuestion?.to === line.speaker ? undefined : view.openQuestion)
    : { from: line.speaker, to: line.question.to, text: line.question.text, askedAt: line.at, eventId: line.eventId };
  const guestInvited = view.guestInvited ||
    (line.speaker === view.host && line.question?.to !== undefined && line.question.to === view.guest);
  const guestFirstIdea = view.guestFirstIdea ??
    (line.speaker === view.guest && line.proposal ? line : undefined);
  return {
    ...view,
    lines,
    lastHeard: line.complete ? line : view.lastHeard,
    lastLine: line,
    facts,
    factsTold: facts.filter((fact) => fact.told).map((fact) => fact.id),
    openQuestion,
    guestInvited,
    guestFirstIdea,
    guestLastLine: line.speaker === view.guest ? line : view.guestLastLine,
  };
}
