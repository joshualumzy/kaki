/**
 * The single next action the room should take, chosen from the state after the last heard line.
 *
 * Pure: no I/O, no timers, no model. The caller decides how to speak the line; in shadow mode it only logs it.
 */

import { addressedCharacter } from './director';
import { carriesCatchText, contentWords, type HeardLine, type MeetingCatchView, type MeetingFactView, type MeetingView } from './meetingState';

export type SpeakPurpose = 'handover' | 'brief' | 'answer' | 'catch' | 'invite' | 'confirm' | 'clarify';

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
  catchId?: string,
): SpeakDecision {
  return {
    kind: 'Speak', speaker, purpose, respondsTo,
    ...(factIds === undefined ? {} : { factIds }),
    ...(catchId === undefined ? {} : { catchId }),
    reason,
  };
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

/** A whole guest line that only greets, acknowledges or stalls: it does not ask the room for anything. */
const FILLER_ONLY_RE =
  /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|yo|testing|test|wait|hold on|one sec|hang on|can you hear me|you guys hear me|is my mic working|idk|i don't know|not sure|hmm+|uh+|um+|ok|okay|sure|yes|no|yeah|yep|nope|right|fine|thanks|thank you|got it)(?:[ ,]+(?:team|all|everyone|folks))?[,.!?]*\s*)+$/i;

/** True when a guest line only greets, acknowledges or stalls, so the room need not answer it. */
export function isFillerGuestLine(text: string): boolean {
  return FILLER_ONLY_RE.test(text.trim());
}

/** A guest line that asks something: a question mark anywhere at the end, or a question word at the start. */
const QUESTION_START_RE =
  /^\s*(?:what|why|how|who|whom|whose|when|where|which|would|could|can|will|should|shall|do|does|did|is|are|was|were|has|have|had|am|may|might)\b/i;

/** True when the guest line is a question the room should answer, not a statement to react to. */
export function isGuestQuestion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith('?') || QUESTION_START_RE.test(trimmed);
}

/** The AI attendees the guest names anywhere in their line, including a second one named after the first. */
function namedColleagues(view: MeetingView, text: string): string[] {
  const found: string[] = [];
  for (const name of view.present) {
    if (!isColleague(view, name)) continue;
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text)) found.push(name);
  }
  return found;
}

/** The one colleague the guest speaks to first, using the same rules as the old addressee check. */
function addressedColleague(view: MeetingView, text: string): string | undefined {
  const cast = view.present.map((attendee) => ({
    attendee, voice: '', personality: '', agenda: '', concerns: [],
  }));
  const named = addressedCharacter(text, cast);
  return named !== undefined && isColleague(view, named) ? named : undefined;
}

/** Every colleague named as a vocative anywhere in the line: set off by commas, or followed by a question mark/word. */
function vocativeColleagues(view: MeetingView, text: string): string[] {
  const found: string[] = [];
  for (const name of view.present) {
    if (!isColleague(view, name)) continue;
    const escaped = escapeRegExp(name);
    const setOff = new RegExp(`(?:^|[,—–-])\\s*${escaped}\\s*(?:[,—–-]|$)`, 'i');
    const asked = new RegExp(`\\b${escaped}\\s*\\?`, 'i');
    const beforeQuestion = new RegExp(
      `(?:^|[,—–-])\\s*${escaped}\\s*,?\\s+(?:would|could|can|will|should|shall|what|how|why|when|where|who|whom|whose|which)\\b`,
      'i',
    );
    if (setOff.test(text) || asked.test(text) || beforeQuestion.test(text)) found.push(name);
  }
  return found;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The colleague whose role, worries and knowledge the guest's point touches most, if any. */
function closestColleague(view: MeetingView, text: string): string | undefined {
  let best: { name: string; overlap: number } | undefined;
  for (const name of view.present) {
    if (!isColleague(view, name) || name === view.host) continue;
    const known = [
      view.colleagues.find((profile) => profile.name === name)?.text ?? '',
      ...view.facts.filter((fact) => fact.knownBy.includes(name)).map((fact) => fact.text),
      ...view.catches.filter((entry) => entry.attendee === name).map((entry) => entry.text),
    ].join(' ');
    const overlap = countOverlap(known, text);
    if (overlap === 0) continue;
    if (best === undefined || overlap > best.overlap) best = { name, overlap };
  }
  return best?.name;
}

/** How the room answers a guest line: one named colleague, the first idea's catch, a fact, or a clarification. */
function guestLineDecision(view: MeetingView, line: HeardLine): PlannerDecision {
  if (isFillerGuestLine(line.text)) return wait(`"${line.text.trim()}" is only a filler or acknowledgement`);

  const recorded = line.question?.to !== undefined && isColleague(view, line.question.to) ? line.question.to : undefined;
  const vocatives = vocativeColleagues(view, line.text);
  const addressed = recorded ??
    (vocatives.length === 1 ? vocatives[0] : vocatives.length > 1 ? undefined : addressedColleague(view, line.text));
  if (addressed !== undefined) {
    return speak(addressed, 'answer', line.eventId, `the guest addressed ${addressed} by name`);
  }

  if (view.guestFirstIdea?.eventId === line.eventId && !view.catchRaised) {
    const owner = unraisedCatchOwner(view, line.speaker);
    if (owner !== undefined) {
      return speak(owner.attendee, 'catch', line.eventId, `${owner.attendee}'s catch on the first idea is still unraised`, undefined, owner.id);
    }
  }

  const fact = matchingFact(view, line.text);
  if (fact !== undefined) {
    const knower = canTell(view, fact);
    if (knower !== undefined) {
      return speak(knower, 'answer', line.eventId, `${knower} knows a fact that answers the guest's last point`, [fact.id]);
    }
  }

  const question = isGuestQuestion(line.text);
  const closest = closestColleague(view, line.text);
  if (closest !== undefined) {
    return question
      ? speak(closest, 'answer', line.eventId, `${closest} can answer the guest's question directly`)
      : speak(closest, 'clarify', line.eventId, `${closest}'s own work is closest to the guest's point`);
  }
  if (view.host !== undefined && isColleague(view, view.host)) {
    return question
      ? speak(view.host, 'answer', line.eventId, 'nobody else has something to add, so the host answers')
      : speak(view.host, 'clarify', line.eventId, 'nobody else has something to add, so the host clarifies');
  }
  return wait('no colleague can answer the guest');
}

/** A second colleague speaks only when the guest's line gives them a reason of their own. */
function secondSpeakerDecision(view: MeetingView, responders: readonly HeardLine[]): PlannerDecision {
  if (responders.length === 0) return wait('the guest has the floor');
  if (responders.length >= 2) return wait('the guest line already has its two speakers');
  const first = responders[0]!;
  const guestLine = view.guestLastLine;

  if (guestLine !== undefined) {
    const named = new Set(namedColleagues(view, guestLine.text));
    if (guestLine.question?.to !== undefined && isColleague(view, guestLine.question.to)) {
      named.add(guestLine.question.to);
    }
    named.delete(first.speaker);
    const second = [...named][0];
    if (second !== undefined) {
      return speak(second, 'answer', guestLine.eventId, `the guest also addressed ${second}`);
    }
  }

  if (view.guestFirstIdea !== undefined && view.guestLastLine?.eventId === view.guestFirstIdea.eventId && !view.catchRaised) {
    const owner = unraisedCatchOwner(view, first.speaker);
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

  // The guest's own line outranks any question left open before it: a colleague they just named answers.
  if (event.kind === 'heard' && event.line.speaker === view.guest) {
    return guestLineDecision(view, event.line);
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
    if (view.guestFirstIdea !== undefined && !view.catchRaised) {
      const owner = unraisedCatchOwner(view, undefined);
      if (owner !== undefined) {
        return speak(owner.attendee, 'catch', event.line.eventId, `${owner.attendee}'s catch on the first idea is still unraised`, undefined, owner.id);
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
