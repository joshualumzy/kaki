/**
 * The writer for one opening speaker: a focused prompt with only that colleague's persona, the line they are
 * answering and the briefing fact(s) they are allowed to tell. The reply is checked whole before any of it is heard.
 */

import type { Scenario } from '@kaki/shared';
import { escapeRegExp } from '../core/text';
import { cleanSpoken, type HumanInfo } from './director';
import { contentWords } from './meetingState';
import { isReplyControlLine } from './replyControl';

interface OpeningSpeakerRequest {
  scenario: Scenario;
  speaker: string;
  human?: HumanInfo;
  topicTitle: string;
  purpose: 'brief' | 'invite';
  /** The briefing fact(s) this speaker tells; empty for the host's question. */
  facts: readonly string[];
  decision?: string;
  /** The last line the room heard, which this line must answer. */
  previous?: { speaker: string; text: string };
}

interface OpeningReplyOptions {
  expectedSpeaker: string;
  names: readonly string[];
  guestName?: string;
  purpose: PlannedPurpose;
  topicTitle?: string;
}

type PlannedPurpose = 'brief' | 'invite' | 'answer' | 'catch' | 'clarify' | 'defer';
type GatePurpose = 'readback' | 'offer';

/** One short host line for a decision gate: either the guest's call read back, or one concrete offer. */
export interface GateSpeakerRequest {
  scenario: Scenario;
  speaker: string;
  human?: HumanInfo;
  topicTitle: string;
  purpose: GatePurpose;
  /** For an offer, the guest's own heard lines on this topic; for a read-back, the lines that make up the standing call. Oldest first. */
  guestLines: readonly string[];
  /** The one call to restate (read-back) or propose (offer): never a menu and never quoted notes. */
  call: string;
  /** The last fully heard line on this topic, when there is one. */
  previous?: { speaker: string; text: string };
}

type OpeningReply =
  | { ok: true; text: string; sentences: string[] }
  | { ok: false; reason: string };

/** One reply speaker's request: their own persona, the point to answer and the one thing they may add. */
interface ReplySpeakerRequest {
  scenario: Scenario;
  speaker: string;
  human?: HumanInfo;
  topicTitle: string;
  decision?: string;
  purpose: 'answer' | 'catch' | 'clarify' | 'defer';
  /** The last fully heard lines on this topic, oldest first. */
  transcript: readonly { speaker: string; text: string }[];
  /** The exact heard line this reply answers. */
  respondsTo: { speaker: string; text: string };
  /** The untold fact(s) an answer may state. */
  facts?: readonly string[];
  /** The real catch a catch reply raises. */
  catchText?: string;
  /** A precise instruction for a clarification, when the generic clarify line would be too vague. */
  clarifyNote?: string;
  /** The later slot this topic can be deferred to, when the guest wants to park a topic that can wait. */
  laterSlot?: string;
  /** Ask the model for its hidden KAKI_CONTROL line, used only on the first reply of a guest line. */
  asksControl?: boolean;
}

/** A hidden control line or a stage direction, never spoken. */
function isMetaLine(line: string): boolean {
  return isReplyControlLine(line) || /^\s*[\[(]/u.test(line);
}
/** Points at the game's follow-up card or the player's screen, not a table card or a loyalty card. */
const CARD_OR_SCREEN_RE =
  /\b(?:follow[- ]up\s+card|card\s+on\s+your|on\s+your\s+(?:screen|phone)|panel|dashboard)\b/i;
const META_LINE_RE = /\b(?:as an ai|language model|system prompt|prompt leak|these instructions|this note)\b/i;

function roleLabel(scenario: Scenario, speaker: string): string {
  const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
  return scenario.roles.find((role) => role.id === attendee?.role)?.label ?? 'colleague';
}

/** A spoken line may only lean on what the room already knows: nothing new may appear as a fact or a gate. */
const HEARD_ONLY_RULE =
  'Use only facts and names already heard in this room; never add a new open item, task, person or number.';
/** Sam chairs the meeting and must not take the guest's follow-up on himself. */
const NO_SELF_WORK_RULE = 'Never volunteer to do the work yourself; the follow-up is the guest\'s.';

function isFacilitatorSpeaker(scenario: Scenario, speaker: string): boolean {
  const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
  const role = scenario.roles.find((candidate) => candidate.id === attendee?.role);
  return role?.facilitator === true ||
    (scenario.npcs ?? []).some((npc) => npc.attendee === speaker && npc.role === 'host');
}

function describeOffScreen(scenario: Scenario, topicTitle: string): string | undefined {
  const item = scenario.agenda.find((candidate) => candidate.title === topicTitle);
  const offScreen = item?.offScreen;
  if (offScreen === undefined) return undefined;
  return [
    `Off-screen for this topic only: ${offScreen.name} (${offScreen.role}).`,
    `A colleague must say they will ask ${offScreen.name} first.`,
    `Only on a later reply, once that offer is in the earlier lines, may this person answer once, relayed in one sentence as a message they sent back ("${offScreen.name}'s texted back: ..."), never as a meeting in person.`,
    `If asked, ${offScreen.name} answers once, in character. How they answer: ${offScreen.howTheyAnswer}`,
  ].join(' ');
}

function describeSpeaker(scenario: Scenario, speaker: string, human?: HumanInfo): string {
  const npc = (scenario.npcs ?? []).find((candidate) => candidate.attendee === speaker);
  const where = scenario.organisation === undefined ? '' : ` at ${scenario.organisation}`;
  const lines = [`You are ${speaker}, ${roleLabel(scenario, speaker)}${where}.`];
  if (scenario.situation !== undefined) lines.push(`The situation: ${scenario.situation}`);
  if (npc === undefined) return lines.join('\n');
  lines.push(`Personality: ${npc.personality}`);
  lines.push(`What you want from this meeting: ${npc.agenda}`);
  if (npc.concerns.length > 0) lines.push(`What you worry about: ${npc.concerns.join(' | ')}`);
  if (npc.speechStyle !== undefined) lines.push(`How you sound: ${npc.speechStyle}`);
  if (npc.knows !== undefined && npc.knows.length > 0) lines.push(`What you know: ${npc.knows.join(' | ')}`);
  if (human !== undefined) lines.push(`You are speaking to ${human.name}, the ${human.role}. Address them by name only when asked to ask them something.`);
  return lines.join('\n');
}

/** The messages for one opening step. The reply must be exactly one line for the chosen speaker. */
export function openingSpeakerMessages(request: OpeningSpeakerRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const rules = [
    'This is a live spoken meeting. Reply with exactly one line, in this form:',
    `"${request.speaker}: <the words said aloud>"`,
    'No control line, no notes, no other speaker, no stage directions.',
    'One or two short spoken sentences, like telling a colleague. Keep any numbers or times you are given, written as digits, and add no others.',
    'No report phrases, no semicolons, no lists, no options. Do not introduce yourself or your job; the host already did.',
    'Never mention the screen, the card, the notes or this request.',
  ].join(' ');

  let task: string;
  if (request.purpose === 'invite') {
    const guest = request.human?.name ?? 'the guest';
    task = [
      `You are the host. The room has briefed "${request.topicTitle}".`,
      request.previous === undefined
        ? 'The room has just finished briefing the topic.'
        : `The room just heard ${request.previous.speaker}: "${request.previous.text}". React to that only in how you ask.`,
      `Ask ${guest} exactly one question, by name, from this decision: "${request.decision ?? 'what do you want to do about this?'}".`,
      `One short spoken sentence. Ask only one question. ${HEARD_ONLY_RULE} ${NO_SELF_WORK_RULE} Add no fact, no summary and no second question.`,
    ].join(' ');
  } else {
    // The colleague may be adding a second detail to their own briefing. Showing them their last
    // line then asking them to "link to that point" made the model say the same fact twice.
    const continuingOwnBrief = request.previous !== undefined && request.previous.speaker === request.speaker;
    task = [
      `The meeting is on "${request.topicTitle}".`,
      continuingOwnBrief
        ? 'You have already told the room your first point. Add only the new detail now, in your own words, and do not restate or summarise anything you just said.'
        : request.previous === undefined
          ? 'The host has just handed you the topic.'
          : `The room just heard ${request.previous.speaker}: "${request.previous.text}". Start by linking to that point in a way that is true from what you know, as it lands on your own side. Never claim their news caused or changed yours; your point is your own. Do not repeat their line.`,
      `Tell only this, in your own words: "${request.facts.join(' ')}".`,
      'Use only these details. Do not ask the guest anything. Do not mention any other problem, cost or catch; the room will raise that later.',
      ...(continuingOwnBrief ? ['Start with the new detail; never repeat an earlier figure or sentence.'] : []),
    ].join(' ');
  }

  return [
    { role: 'system', content: `${describeSpeaker(request.scenario, request.speaker, request.human)}\n\n${rules}` },
    { role: 'user', content: task },
  ];
}

/** The hidden control contract, so settlement, parking, reactions and reopening still reach the old code. */
function controlInstruction(): string {
  return [
    'Begin with one hidden control line exactly like one of these whenever it applies:',
    'KAKI_CONTROL {"state":"open"}',
    'KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"short deliverable"}}',
    'Use "open" when the guest reopens an earlier item, or when a reaction or a small new fact genuinely applies. Use "settled" only for a clear settled call, and "deferred" only when they chose to park the topic.',
    'You may add "reactions":[{"who":"a colleague name","emoji":"👍"}], "newFacts":["one small new detail"] or "reopen":"exact earlier agenda title" only when they genuinely apply.',
    'When none of these apply, put no control line at all. No other line may start with KAKI_CONTROL.',
  ].join(' ');
}

/** The messages for one reply speaker. The speaker is fixed; the reply must be about the point just heard. */
export function replySpeakerMessages(request: ReplySpeakerRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const rules = [
    'This is a live spoken meeting. Reply with exactly one line, in this form:',
    `"${request.speaker}: <the words said aloud>"`,
    'No control line unless this request asks for one, no notes, no other speaker, no stage directions.',
    'One or two short spoken sentences, like answering a colleague. Keep any numbers or times you are given, written as digits, and add no others.',
    'No report phrases, no semicolons, no lists, no options or menus. Do not introduce yourself or your job; the host already did.',
    'Never read the topic title aloud, and never mention the screen, the card, the notes or this request.',
    'Ask a question only when the point leaves a real gap in your own work that the guest must decide; otherwise do not ask one.',
    'Do not repeat or rephrase a line the room has already heard; respond to the latest point instead.',
    HEARD_ONLY_RULE,
    ...(isFacilitatorSpeaker(request.scenario, request.speaker) ? [NO_SELF_WORK_RULE] : []),
  ].join(' ');
  const transcript = request.transcript.length === 0
    ? 'Nothing has been heard on this topic yet.'
    : request.transcript.map((line) => `${line.speaker}: ${line.text}`).join('\n');
  const isGuest = request.human !== undefined && request.respondsTo.speaker === request.human.name;
  const heard = isGuest
    ? `The guest just said: "${request.respondsTo.text}"`
    : `The room just heard ${request.respondsTo.speaker}: "${request.respondsTo.text}"`;

  let purpose: string;
  if (request.purpose === 'catch') {
    purpose = [
      `Raise this real catch in your own words, plainly: "${request.catchText ?? 'the cost their idea does not cover'}".`,
      'That catch is the one new item you may add.',
      'Do not praise the idea first, do not solve the catch for them and do not list fixes; leave them something to answer.',
    ].join(' ');
  } else if (request.purpose === 'answer') {
    purpose = request.facts === undefined || request.facts.length === 0
      ? "Answer the point directly, in your own words, from what you know. If you do not know the answer, say plainly that you don't know; never invent figures or a new problem. Do not ask the guest a question back."
      : `Answer the point directly, in your own words. You may tell only this: "${request.facts.join(' ')}". ${request.facts.length === 1 ? 'That fact is the one new item you may add.' : 'Those facts are the one new item you may add.'} If that does not answer what was asked, say plainly that you don't know rather than inventing. Do not ask the guest a question back.`;
  } else if (request.purpose === 'defer') {
    purpose = [
      'The guest wants to leave this for later, and this topic can wait.',
      `Confirm in one short sentence that the room will come back to it ${request.laterSlot === undefined ? 'later' : `"${request.laterSlot}"`}.`,
      'Do not settle it now, do not start the work, and do not ask the guest a question back.',
    ].join(' ');
  } else {
    purpose = [
      'React to what the guest actually said: say what their point means for your own work in one or two sentences, in your own words.',
      "Ask one short question only when the guest's call leaves a real gap in your own area that they must decide; otherwise end with no question.",
      ...(request.clarifyNote === undefined ? [] : [request.clarifyNote]),
    ].join(' ');
  }

  const task = [
    `The meeting is on "${request.topicTitle}".`,
    request.decision === undefined ? '' : `The decision on the table: "${request.decision}".`,
    `What the room has heard on this topic, in order:\n${transcript}`,
    `${heard}.`,
    purpose,
    `Reply with exactly one line: "${request.speaker}: <the words said aloud>".`,
    request.asksControl === true ? controlInstruction() : '',
  ].filter((part) => part.length > 0).join('\n');

  const offScreen = describeOffScreen(request.scenario, request.topicTitle);
  return [
    { role: 'system', content: `${describeSpeaker(request.scenario, request.speaker, request.human)}\n\n${rules}` },
    { role: 'user', content: offScreen === undefined ? task : `${task}\n\n${offScreen}` },
  ];
}

/** The messages for Sam's read-back or offer: one plain spoken line, never a quote or a menu. */
export function gateSpeakerMessages(request: GateSpeakerRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const rules = [
    'This is a live spoken meeting. Reply with exactly one line, in this form:',
    `"${request.speaker}: <the words said aloud>"`,
    'No control line, no notes, no other speaker, no stage directions.',
    'One or two short spoken sentences, like talking to a colleague. Keep any numbers or times you are given, written as digits, and add no others.',
    'Never use quotation marks. Never read a written note, a list or a menu aloud. Do not mention the screen, the card, the notes or this request.',
    HEARD_ONLY_RULE,
    NO_SELF_WORK_RULE,
  ].join(' ');
  const guest = request.human?.name ?? 'the guest';
  const transcript = request.guestLines.length === 0
    ? 'The guest has not spoken on this topic yet.'
    : request.guestLines.map((line) => `- ${line}`).join('\n');
  const cast = [...new Set([
    ...request.scenario.attendees.map((attendee) => attendee.name),
    ...(request.scenario.npcs ?? []).map((npc) => npc.attendee),
    ...(request.human === undefined ? [] : [request.human.name]),
  ])].join(', ');
  const task = request.purpose === 'readback'
    ? [
      `The meeting is on "${request.topicTitle}".`,
      `What ${guest} said that makes up their call, in order:\n${transcript}`,
      `The room's reading of their call, from those lines: "${request.call}".`,
      `Say that whole call back in your own plain words: keep every part they decided in those lines, not just the quoted reading, and where a later line changes an earlier one, say the later one. Put the call in one plain sentence, joining its parts with commas or and. Then add a short check that asks ${guest} if that is their call.`,
      `Write it in clean, standard words: correct any misspelling, shorthand or slang the guest used, and spell every person's name exactly as in this cast: ${cast}.`,
      'Never repeat a fragment that trails off or was cut off mid-sentence; say only the parts the guest actually decided, in full.',
      'Restate only what the guest decided. Add no new step, owner, person, open item, task, number or time. Do not quote them or use quotation marks.',
      `Reply with exactly one line: "${request.speaker}: <the words said aloud>".`,
    ].join('\n')
    : [
      `The meeting is on "${request.topicTitle}".`,
      `What ${guest} has said on this topic, in order:\n${transcript}`,
      request.previous === undefined ? '' : `The room just heard ${request.previous.speaker}: "${request.previous.text}".`,
      `Propose exactly one concrete call in your own plain words, from this: "${request.call}".`,
      `One or two short spoken sentences that ask ${guest} to agree. Do not quote, do not list options and do not offer an either/or choice.`,
      `Reply with exactly one line: "${request.speaker}: <the words said aloud>".`,
    ].filter((part) => part.length > 0).join('\n');
  return [
    { role: 'system', content: `${describeSpeaker(request.scenario, request.speaker, request.human)}\n\n${rules}` },
    { role: 'user', content: task },
  ];
}

function sentenceCount(text: string): number {
  return text
    .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
    .map((part) => part.trim())
    .filter((part) => /\p{L}|\p{N}/u.test(part)).length;
}

function stripSelfIntro(name: string, text: string): string {
  const who = escapeRegExp(name);
  const cleaned = text
    .replace(
      new RegExp(
        `^(?:(?:hey|hi|hello)\\s+[a-z]+,?\\s*)?(?:and\\s+)?(?:` +
          `(?:(?:i'm|i am)\\s+${who}(?:\\s+here)?|${who}\\s+here|(?:i'm|i am)?\\s*${who}\\s+(?:from|on|in|your)\\s+[^,.!?]+)` +
          `)(?:\\s*[,—–-]\\s*[^,.!?]+?(?:lead|director|manager))?\\s*[,.—–-]\\s*`,
        'i',
      ),
      '',
    )
    .trim();
  return cleaned.length === 0 ? text : cleaned;
}

function flatten(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function readsTitle(text: string, title: string | undefined): boolean {
  if (title === undefined) return false;
  const wanted = flatten(title);
  return wanted.length > 0 && ` ${flatten(text)} `.includes(` ${wanted} `);
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
  thousand: '1000',
};

/** A value that must survive a paraphrase: a number, a clock time or a price. */
function normaliseValue(token: string): string {
  const compact = token.toLowerCase().replace(/[\s.]/g, '').replace(/,/g, '');
  return NUMBER_WORDS[compact] ?? compact;
}

function valueTokens(text: string): Set<string> {
  const values = new Set<string>();
  const lower = text.toLowerCase();
  const add = (raw: string): void => {
    values.add(normaliseValue(raw));
  };
  for (const match of lower.matchAll(/(?:rm|myr|usd|sgd|\$|s\$)\s*\d+(?:[.,]\d+)?/g)) {
    add(match[0].replace(/^(?:rm|myr|usd|sgd|\$|s\$)\s*/, ''));
  }
  for (const match of lower.matchAll(/\d+(?:[.,]\d+)?\s*(?:ringgit|dollars?|cents?|bucks?)/g)) {
    add(/\d+(?:[.,]\d+)?/.exec(match[0])![0]);
  }
  for (const match of lower.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/g)) {
    add(match[0].replace(/[.\s]/g, ''));
  }
  for (const match of lower.matchAll(/\b\d{1,2}:\d{2}\b/g)) add(match[0]);
  for (const match of lower.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) add(match[0]);
  for (const match of lower.matchAll(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/g,
  )) {
    add(match[0]);
  }
  return values;
}

/**
 * True when a spoken line still carries the fact it was asked to tell: every number, clock time and price
 * appears in it, and at least half of the fact's content words survive the paraphrase.
 */
export function carriesFact(line: string, fact: string, options: { minShare?: number; minShared?: number } = {}): boolean {
  const factWords = contentWords(fact);
  if (factWords.size > 0) {
    const lineWords = contentWords(line);
    let shared = 0;
    for (const word of factWords) if (lineWords.has(word)) shared += 1;
    const minShare = options.minShare ?? 0.5;
    const minShared = options.minShared ?? 0;
    if (shared < minShared || shared / factWords.size < minShare) return false;
  }
  const lineValues = valueTokens(line);
  for (const value of valueTokens(fact)) if (!lineValues.has(value)) return false;
  return true;
}

/**
 * True when a catch survives a paraphrase: at least two of its content words and a third of them appear,
 * and every number or price it names is still there. Looser than a briefing fact because the prompt asks
 * the speaker to raise the catch "in their own words".
 */
export function carriesCatch(line: string, catchText: string): boolean {
  return carriesFact(line, catchText, { minShare: 1 / 3, minShared: 2 });
}

/** Clean and check one planned reply. A reply with another speaker, no speech or the wrong shape is rejected whole. */
export function parsePlannedReply(reply: string, options: OpeningReplyOptions): OpeningReply {
  const cast = [...options.names, ...(options.guestName === undefined ? [] : [options.guestName])];
  const alternatives = cast.map(escapeRegExp).join('|');
  const tagPattern = new RegExp(`^(${alternatives})\\s*:\\s*(.*)$`, 'i');
  const tagged: string[] = [];
  const stray: string[] = [];
  for (const raw of reply.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || isMetaLine(line)) continue;
    const tag = tagPattern.exec(line);
    if (tag !== null) {
      const name = tag[1] ?? '';
      const canonical = cast.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (canonical !== undefined && canonical !== options.expectedSpeaker) {
        return { ok: false, reason: `another speaker (${canonical}) was written` };
      }
      tagged.push(tag[2] ?? '');
      continue;
    }
    stray.push(line);
  }
  // A second speaker can also appear mid-line after a finished sentence.
  for (const other of cast) {
    if (other === options.expectedSpeaker) continue;
    if (new RegExp(`(?<=^|[.!?…]["')\\]]?\\s+|\\n)\\s*${escapeRegExp(other)}\\s*:`, 'i').test(reply)) {
      return { ok: false, reason: `another speaker (${other}) was written` };
    }
  }

  let text = cleanSpoken([...tagged, ...stray].join(' ')).replace(/\s+/g, ' ').trim();
  text = stripSelfIntro(options.expectedSpeaker, text);
  text = text.replace(/^\s*(?:NONE|none)[.!?\s]*$/, '').trim();
  if (text.length === 0 || !/\p{L}|\p{N}/u.test(text)) {
    return { ok: false, reason: 'no speakable line' };
  }
  if (META_LINE_RE.test(text)) return { ok: false, reason: 'wrote about the instructions' };
  if (CARD_OR_SCREEN_RE.test(text)) return { ok: false, reason: 'pointed at the card or screen' };
  if (readsTitle(text, options.topicTitle)) return { ok: false, reason: 'read the topic title' };
  if (/;/.test(text)) return { ok: false, reason: 'used a semicolon' };
  if (sentenceCount(text) > 2) return { ok: false, reason: 'wrote more than two sentences' };

  if (options.purpose === 'brief' && text.includes('?')) {
    return { ok: false, reason: 'asked a question during the brief' };
  }
  if (options.purpose === 'invite') {
    if (!text.trim().endsWith('?') || (text.match(/\?/g) ?? []).length !== 1) {
      return { ok: false, reason: 'did not ask exactly one question' };
    }
    const guest = options.guestName;
    if (guest !== undefined && !new RegExp(`\\b${escapeRegExp(guest)}\\b`, 'i').test(text)) {
      text = `${guest}, ${text[0]!.toLowerCase()}${text.slice(1)}`;
    }
  }
  if ((options.purpose === 'answer' || options.purpose === 'catch' || options.purpose === 'clarify') &&
      (text.match(/\?/g) ?? []).length > 1) {
    return { ok: false, reason: 'asked more than one question' };
  }

  const sentences = text
    .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { ok: true, text, sentences };
}

/**
 * Check one read-back or offer line. Quotation marks are rejected whole, so the guest hears plain speech,
 * and the line must end with one short check so an "agree" has something exact to map to.
 */
export function parseGateReply(reply: string, options: { speaker: string; guestName?: string }): OpeningReply {
  const cast = [options.speaker, ...(options.guestName === undefined ? [] : [options.guestName])];
  const alternatives = cast.map(escapeRegExp).join('|');
  const tagPattern = new RegExp(`^(${alternatives})\\s*:\\s*(.*)$`, 'i');
  const tagged: string[] = [];
  const stray: string[] = [];
  for (const raw of reply.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || isMetaLine(line)) continue;
    const tag = tagPattern.exec(line);
    if (tag !== null) {
      const name = tag[1] ?? '';
      const canonical = cast.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (canonical !== undefined && canonical !== options.speaker) {
        return { ok: false, reason: `another speaker (${canonical}) was written` };
      }
      tagged.push(tag[2] ?? '');
      continue;
    }
    stray.push(line);
  }

  let text = cleanSpoken([...tagged, ...stray].join(' ')).replace(/\s+/g, ' ').trim();
  text = stripSelfIntro(options.speaker, text);
  if (text.length === 0 || !/\p{L}|\p{N}/u.test(text)) return { ok: false, reason: 'no speakable line' };
  if (META_LINE_RE.test(text)) return { ok: false, reason: 'wrote about the instructions' };
  if (CARD_OR_SCREEN_RE.test(text)) return { ok: false, reason: 'pointed at the card or screen' };
  if (/["“”„]/.test(text)) return { ok: false, reason: 'used quotation marks' };
  if (/;/.test(text)) return { ok: false, reason: 'used a semicolon' };
  if (sentenceCount(text) > 2) return { ok: false, reason: 'wrote more than two sentences' };
  if ((text.match(/\?/g) ?? []).length !== 1 || !text.endsWith('?')) {
    return { ok: false, reason: 'did not end with exactly one short question' };
  }

  const sentences = text
    .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { ok: true, text, sentences };
}
