import { itemMode, type ActionKind, type MeetingMemoryEntry, type NpcStateMessage, type Scenario, type SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../services/llm';
import { cleanSpokenTopic, liveNextItemLine, liveWrapUpLine, spokenAgendaName } from '../host/opening';
import { CardPointer } from './cardPointer';
import { buildSystemPrompt, findHandover, HandoverGuard, responsibilityFor, TurnParser, type HumanInfo, type Utterance } from './director';
import { silenceCheckInLine, silenceCheckInNote, silenceColleagueNote } from './silence';
import { couldBeReplyControlLine, isReplyControlLine, OPEN_REPLY_CONTROL, parseReplyControl, type ReplyControl } from './replyControl';
import { SpeechGate } from './speechGate';
import { MeetingMemory } from './meetingMemory';
import { TopicRecord, type OpenQuestion, type TopicPromptView } from './topicRecord';
import { meetingTopic, MeetingState, type HeardLine, type MeetingView } from './meetingState';
import { describeDecision, MAX_OFFERS, mergedReadiness, standingCallEventIds, next as nextPlannerDecision, plainDirection, projectHeard, readinessMet, type OfferDecision, type PlannerDecision, type PlannerEvent, type SpeakDecision } from './turnPlanner';
import { readGuestLine, type GuestReaderInput, type GuestReaderPorts, type GuestReading } from './guestReader';
import { carriesCatch, carriesFact, gateSpeakerMessages, openingSpeakerMessages, parseGateReply, parsePlannedReply, replySpeakerMessages, type GateSpeakerRequest } from './openingWriter';

/** What the people in the meeting should see the AI attendees doing. */
export type NpcUiState = NpcStateMessage;

/** Everything the conversation needs from the outside world; tests replace all of it. */
export interface NpcPorts<Clip> {
  /** Stream the Director's reply; must stop promptly when `signal` aborts. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** The backup model, used for the one retry after a first sentence misses its deadline. */
  fallbackStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** A low-temperature stream for the guest-line reader; falls back to `stream` when absent. */
  readerStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** The backup reader stream; falls back to `fallbackStream` when absent. */
  readerFallbackStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** Turn a sentence into audio. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Clip>;
  /** Play a clip as `speaker`. Resolves when it finished, or straight after `signal` aborts and the sound has stopped. */
  play(speaker: string, clip: Clip, signal: AbortSignal): Promise<void>;
  /** Playback length for resuming a scripted sentence after a wordless cut-in. */
  clipDurationMs?(clip: Clip): number;
  /**
   * A line said in the meeting, for Kaki's transcript; `textOnly` marks a line shown as text because its voice failed,
   * `catchId` marks the last sentence of the line that raises a catch, `lineId` lets a later update replace the same
   * line, and `human` marks the person's own line, which the app server writes so it is recorded even with no AI runner.
   */
  emitTranscript(
    speaker: string,
    text: string,
    options?: { textOnly?: boolean; catchId?: string; lineId?: string; human?: boolean; gate?: 'lock-offer' },
  ): void;
  /** Replace the words shown for a spoken line, display only: it is never recorded as another line. */
  emitTranscriptUpdate(speaker: string, text: string, options: { lineId: string; cut: boolean }): void;
  /** What the AI attendees are doing, for the screen. */
  emitState(state: NpcUiState): void;
  log?(message: string): void;
  /** What the person's microphone has been hearing, to explain a refused phrase. */
  describeMic?(): string | undefined;
  /** Move the meeting to the next agenda item: the current one is settled and its follow-up is finished or timed out. */
  advanceAgenda?(): void;
  /** Wrap up the meeting once the final agenda item is complete. */
  endMeeting?(): void;
  /** A fact the Director picked to help the visitor right now, for their Wingman, on the agenda item it belongs to. */
  onWingmanTip?(tip: string, title: string, agendaIndex: number): void;
  /** The visitor's decision on the current item is locked; `followUp` is the task that announces it. */
  settleTopic?(followUp: SuggestInput, reopened?: boolean): void | Promise<void>;
  onMemoryChange?(entries: MeetingMemoryEntry[]): void;
  onReaction?(who: string, emoji: string): void;
}

/** Quiet needed after the person stops talking before the AI answers; on top of the voice detector's own hangover. */
const DEFAULT_RESPONSE_DELAY_MS = 300;

/** Pause when one character finishes and a different one starts, so it sounds like people taking turns. */
export const DEFAULT_SPEAKER_GAP_MS = 900;
/** Pause between two sentences of the same speaker, so they do not run together. */
export const DEFAULT_SENTENCE_GAP_MS = 400;

/** The person cut an AI attendee off but said nothing recognisable; they carry on after this long. */
const DEFAULT_RESUME_MS = 1800;

/** When speech recognition reports that a cut-in held no words, the AI carries on after this long. */
const DEFAULT_NOTHING_MS = 400;

/** An answer cancelled before anything was said, with nothing new from the person, is retried after this long. */
const DEFAULT_RETRY_MS = 1500;

/** How many times in a row the AI may pass the turn to another character without the person saying anything. */
export const MAX_FOLLOW_UPS = 2;

/** How long a Host cue waits for a quiet moment before it is dropped as out of date. */
const DEFAULT_ANNOUNCE_GIVE_UP_MS = 40_000;
/** The longest a planned line waits for another line to stop playing before it speaks anyway. */
const FLOOR_WAIT_MAX_MS = 15_000;
/** How long a topic's time-up close may wait for the guest to finish answering. */
const TIME_UP_GRACE_MS = 60_000;
/** How often a held time-up close checks whether the guest has finished. */
const TIME_UP_RECHECK_MS = 1_000;
/** How often a line that is ready to play checks whether the guest has stopped talking. */
const HUMAN_TALKING_RECHECK_MS = 100;


/** The host asks when the agenda moves on; if that never happens, after this many lines from the person. */
const ASK_BACKSTOP_LINES = 8;
/** How long after the host announces the next item before the question (the announcement is spoken first). */
const DEFAULT_ASK_DELAY_MS = 3000;
/** How long after an item opens, with the person silent, before the characters start talking it through. */
const DEFAULT_OBSERVE_DELAY_MS = 1500;
/** How long the room waits in silence on the person's item before the host gently checks in by name. */
const DEFAULT_SILENCE_PROMPT_MS = 22_000;
/** Start writing the first silence nudge this long before it should be heard, so model time does not delay it. */
const DEFAULT_SILENCE_NUDGE_LEAD_MS = 15_000;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** A topic still open after this many lines from the visitor, or this long, gets one offer from the host to lock in what they said. */
const DEFAULT_TOPIC_TURN_BUDGET = 12;
/**
 * How long a topic may stay open before time is up on it, when its agenda item gives no minutes. An item's own
 * minutes win, so the AI closes a topic when the agenda says, not on a fixed clock.
 */
export const DEFAULT_TOPIC_TIME_BUDGET_MS = 180_000;
/** How long the host waits for an answer to that offer before asking once more, and then before locking it in. */
const DEFAULT_BUDGET_SILENCE_MS = 20_000;
/** After a settled topic waits this long with nothing happening on the card, the host nudges the visitor towards it. */
const DEFAULT_REVIEW_NUDGE_MS = 5_000;
/**
 * How long a settled topic waits for the visitor's follow-up card with nothing happening on it before the host moves on.
 * Short on purpose: a long wait was 30-50 s of silence for a first-timer, and the card stays sendable after the room moves on.
 * Any progress on the card restarts the wait, so a visitor working on it is never cut off.
 */
const DEFAULT_REVIEW_WINDOW_MS = 10_000;
/** After the follow-up is sent or declined, how long the topic stays so the visitor can open the result. */
const DEFAULT_OPEN_LIVE_GRACE_MS = 9_000;

/** How long the person must keep talking over the room before it stops; a shorter burst is probably noise or an echo. */
export const DEFAULT_BARGE_IN_MS = 1400;

function splitSentences(text: string): string[] {
  return (
    text
      .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}

/** A spoken line never carries a semicolon: each clause becomes its own sentence, with a capital after the stop. */
function splitSemicolons(text: string): string {
  return text.replace(/;\s*(.)?/gs, (_match, next: string | undefined) =>
    next === undefined ? '.' : `. ${next.toUpperCase()}`);
}

/** True when `text` reads `title` out word for word, ignoring case and punctuation. */
function readsTaskTitle(text: string, title: string | undefined): boolean {
  if (title === undefined) return false;
  const flatten = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = flatten(title);
  return wanted.length > 0 && ` ${flatten(text)} `.includes(` ${wanted} `);
}

/** How long a speaker must not restate a point they already made aloud. */
const DEFAULT_REPEAT_WINDOW_MS = 60_000;
/** How often a card pointer or move-on rechecks whether the topic's open question has been answered. */
const CARD_WAIT_POLL_MS = 500;
/** How long an early colleague brief may wait for its first spoken sentence before it is aborted and retried. */
const DEFAULT_BRIEF_FIRST_CHUNK_MS = 12_000;
/** How long one opening speaker's whole line may take before it is abandoned and retried, even after its first sentence. */
const DEFAULT_OPENING_COMPLETION_MS = 20_000;
const LOCK_ASK_RE = /\b(?:shall we lock in|shall i lock in|lock a direction in|make a decision and keep moving)\b/i;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'being',
  'between', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers', 'him', 'his', 'how', 'into', 'its', 'itself',
  'just', 'more', 'most', 'nor', 'not', 'now', 'off', 'once', 'only', 'other', 'our', 'out', 'over', 'own', 'same',
  'she', 'should', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'too', 'under', 'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** The meaningful words in a sentence, for spotting a restated point without matching on filler. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/**
 * What makes a sentence the opposite of another: a negation in one that the other lacks flips its meaning,
 * so "we meet Tuesday" and "no, not Tuesday" are never the same point.
 */
const NEGATION_RE =
  /\b(?:not|no|never|neither|nor|without|cannot|can't|don't|doesn't|didn't|won't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't|hasn't|haven't|cancel(?:led|ling)?|instead)\b/i;

function negates(text: string): boolean {
  return NEGATION_RE.test(text.replace(/[’]/g, "'"));
}

/** True when `next` restates most of `previous` and adds only a little of its own. */
function closelyRepeats(
  next: Set<string>,
  previous: Set<string>,
  negatedNext: boolean,
  negatedPrevious: boolean,
): boolean {
  // A correction is not a restatement: opposite polarity means the point changed.
  if (negatedNext !== negatedPrevious) return false;
  if (next.size < 4 || previous.size < 4) return false;
  let common = 0;
  for (const word of next) if (previous.has(word)) common += 1;
  return common / Math.min(next.size, previous.size) >= 0.7 && next.size - common <= 4;
}

/**
 * Estimate the unspoken part of `text` after `elapsedMs` of playback. Returns `""` when the sentence was
 * already finished or has nothing meaningful left unsaid.
 */
function unspokenRemainder(text: string, elapsedMs: number, durationMs?: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  if (elapsedMs <= 0) return trimmed;
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '';
  const totalMs =
    durationMs !== undefined && durationMs > 0
      ? durationMs
      : Math.max(words.length * 320, trimmed.length * 55);
  if (elapsedMs >= totalMs * 0.98) return '';
  const spokenWordCount = Math.floor((elapsedMs / totalMs) * words.length);
  const unspokenWords = words.slice(spokenWordCount);
  if (unspokenWords.length < 2 || contentWords(unspokenWords.join(' ')).size === 0) return '';
  // Keep one word of overlap so a resumed phrase does not start with a stranded verb.
  const remainingWords = words.slice(Math.max(0, spokenWordCount - 1));
  const rest = remainingWords.join(' ').replace(/^[,;:.!?\s—–-]+/, '').trim();
  return rest[0]!.toUpperCase() + rest.slice(1);
}

/** The words of `text` the room heard after `elapsedMs` of playback; the faultless prefix, not a rephrase. */
function heardPrefix(text: string, elapsedMs: number, durationMs?: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || elapsedMs <= 0) return '';
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '';
  const totalMs =
    durationMs !== undefined && durationMs > 0
      ? durationMs
      : Math.max(words.length * 320, trimmed.length * 55);
  if (elapsedMs >= totalMs * 0.98) return trimmed;
  const spokenWordCount = Math.floor((elapsedMs / totalMs) * words.length);
  return words.slice(0, spokenWordCount).join(' ');
}

/** True when a sentence ends as a question to the visitor rather than a handover to another colleague. */
function isQuestionToVisitor(
  text: string,
  speaker: string,
  names: readonly string[],
  humanName?: string,
): boolean {
  const trimmed = text.trim();
  if (!/\?["')\]]*$/.test(trimmed)) return false;
  return findHandover([{ speaker, text: trimmed }], names, humanName) === undefined;
}

const VOLUNTEER_VERB =
  '(?:handle|take|do|sort|draft|write|send|post|email|prepare|check|cover|look after|print|call|ring|book|order|fix|set up|brief|update)';

/** A volunteer takes the follow-up themselves rather than waiting to be asked. */
const VOLUNTEERED_RE = new RegExp(
  `\\b(?:leave (?:it|that|this) (?:with|to) me|i(?:'ll| will) ${VOLUNTEER_VERB}|i can (?:${VOLUNTEER_VERB}|get)|i(?:'m| am) (?:happy|glad) to ${VOLUNTEER_VERB}|(?:count|put) me in)\\b`,
  'i',
);
/** "I'll get it done" is a promise; a bare "I'll get ..." can be a complaint ("I'll get shouted at"). */
const GET_IT_DONE_RE = /\bi(?:'ll| will)\s+get\s+(?:it|that|this)\s+(?:done|sorted)\b/i;
/** "On it" is a volunteer only as a whole short reply or the start of a sentence, not inside "depends on it". */
const ON_IT_RE = /^\s*on it\b/i;

/** True when the speaker volunteered to take on the follow-up, not described it or added a condition. */
function isVolunteer(text: string): boolean {
  const match = VOLUNTEERED_RE.exec(text) ?? GET_IT_DONE_RE.exec(text) ?? ON_IT_RE.exec(text);
  if (match === null) return false;
  // "I can do it, but I need the password first" is a condition, not a promise to take it on.
  return !/\bbut\b/i.test(text.slice(match.index + match[0].length));
}

/** True when the visitor's line names `name` and gives them the follow-up ("Daniel, can you call the supplier?"). */
function assignedByGuest(text: string, name: string): boolean {
  const who = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (who.length === 0 || !new RegExp(`\\b${who}\\b`, 'i').test(text)) return false;
  return new RegExp(
    [
      `\\b(?:can|could|would|will) you\\b`,
      `\\bplease\\b`,
      `\\byou(?:'ll| will)\\b`,
      `\\byou (?:take|handle)\\b`,
      `\\b${who}(?:'ll| will)\\b`,
      `\\blet ${who}\\b`,
      `\\bget ${who} to\\b`,
      `\\b${who} to (?:handle|take|call|send|draft|check|sort|do)\\b`,
      `\\b${who} can (?:handle|take|do|sort)\\b`,
    ].join('|'),
    'i',
  ).test(text);
}

/**
 * A model-written sentence that points the visitor at their card or screen. Only the host's fixed handoff line does
 * that, so these are dropped. Narrower than CARD_POINT_RE so "the card machine", "your card or PayNow" and
 * "your card at the counter" in a kopitiam still get through.
 */
const MODEL_CARD_MENTION_RE =
  /\b(?:your (?:card|screen|panel)(?=\s*(?:$|[.,!?]|\b(?:on the right|there|ready|has|holds|shows|contains|whenever|when)\b))|(?:card|screen|panel) on the right|right-hand panel)\b/i;

/** A verb for passing the decision on to other people; a colleague's own task uses none of these. */
const SHARE_VERB = '(?:post|send|share|email|message|put|drop|pop|circulate|announce|broadcast|text)';

/**
 * Where a shared decision goes: the team/chat, or the decision itself. Narrow enough that a colleague's own task
 * ("I'll email the supplier about the fridge", "I'll put a note on the fridge") still gets through.
 */
const SHARE_TARGET =
  '(?:(?:in|on|to|into|through)\\s+the\\s+(?:chat|group(?: chat)?|channel|team|staff|everyone|crew|whatsapp|mattermost)|(?:the|that|an|this)\\s+(?:update|announcement|decision)|the same line)';

const SHARE_VERB_RE = new RegExp(`\\b${SHARE_VERB}\\b`, 'i');
const SHARE_TARGET_RE = new RegExp(`\\b${SHARE_TARGET}\\b`, 'i');

/** Verbs that share the decision itself, and verbs that only place something (which need a chat-like place). */
const OUTWARD_SHARE_VERB = '(?:post|send|share|email|message|circulate|announce|broadcast)';
const PLACING_SHARE_VERB = '(?:put|drop|pop|text)';
const SHARE_PLACE_TARGET =
  '(?:in|on|to|into|through)\\s+the\\s+(?:chat|group(?: chat)?|channel|team|crew|whatsapp|mattermost)';
const SHARE_OBJECT_TARGET = '(?:the|that|an|this)\\s+(?:update|announcement|decision)';
/** The target must follow the verb in the same clause, so an aside ("put it this way, the decision") does not count. */
const SHARE_CLAUSE = '[^,.;!?]*?';
const SHARE_PROMISE = "\\b(?:i['’]ll|i will|i can|let me|i['’]m happy to)\\b";

/**
 * A model-written sentence where a colleague promises to share the visitor's decision with the team themselves
 * ("I'll post the update to the team"). The prompt forbids it, but the model sometimes does it; sharing the
 * decision is the visitor's own follow-up, so these are dropped. Narrower than a bare verb so a colleague's own
 * task ("I'll email the supplier about the fridge") still gets through.
 */
const MODEL_SHARE_TAKEOVER_RE = new RegExp(
  `${SHARE_PROMISE}${SHARE_CLAUSE}\\b${OUTWARD_SHARE_VERB}\\b${SHARE_CLAUSE}\\b(?:${SHARE_PLACE_TARGET}|${SHARE_OBJECT_TARGET}|the same line)\\b` +
    `|${SHARE_PROMISE}${SHARE_CLAUSE}\\b${PLACING_SHARE_VERB}\\b${SHARE_CLAUSE}\\b${SHARE_PLACE_TARGET}\\b`,
  'i',
);

/** The colleague a sentence asks to share the decision ("Daniel, can you post it in the chat?"), if any. */
function addressedShareTarget(text: string, names: readonly string[]): string | undefined {
  if (!SHARE_VERB_RE.test(text) || !SHARE_TARGET_RE.test(text)) return undefined;
  for (const name of names) {
    const who = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${who}\\s*,\\s*(?:(?:can|could|would|will)\\s+you|please)\\b`, 'i').test(text)) return name;
  }
  return undefined;
}

/**
 * The verb a colleague volunteers for, straight after the claim ("I'll test it", "I'll be the one to test it",
 * "I'd sooner be the one testing that"). Only that verb counts, so "I'll print the cards so Bao can test them"
 * claims printing, not testing. "be the one" only counts after a claim, so "that could be the one test that
 * matters" claims nothing.
 */
const SELF_CLAIM_VERB_RE =
  /\b(?:i['’]ll|i will|i can|let me|i['’]d (?:sooner|rather))\s+(?:be the one\s+(?:to\s+)?)?(?:also\s+|just\s+|go\s+)?([a-z]+)/gi;

/**
 * Verbs too general to tell one step from another ("take", "check", "tell"): never used to match a claimed step,
 * since "Mei will check the fridge" and "I'll check the till" are different jobs.
 */
const GENERIC_STEP_STEMS = new Set([
  'take', 'handle', 'sort', 'make', 'have', 'keep', 'help', 'look', 'work', 'just', 'also', 'then', 'need',
  'check', 'tell', 'call', 'post', 'talk', 'speak', 'chat', 'update', 'follow', 'sure',
].map((verb) => verb.slice(0, 4)));

/** The first four letters of a step's verb, so "test", "tests" and "testing" match. */
function stepStem(word: string): string | undefined {
  const stem = word.toLowerCase().slice(0, 4);
  return word.length >= 4 && !GENERIC_STEP_STEMS.has(stem) ? stem : undefined;
}

/**
 * The verbs of steps a visitor line gives to `name` ("Mei will test the rule" gives Mei "test"; "Ada, you test it
 * instead" gives Ada "test", so a step the visitor moves can be taken by its new owner).
 */
function stepsGivenTo(text: string, name: string): Set<string> {
  const who = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stems = new Set<string>();
  if (who.length === 0) return stems;
  const re = new RegExp(
    `\\b(?:${who}(?:['’]ll| will| to| can| should)|let ${who}|get ${who} to|${who},? (?:can|could|would|will) you|${who},? please|${who}, you)\\s+(?:also\\s+|just\\s+)?([a-z]+)`,
    'gi',
  );
  for (const match of text.matchAll(re)) {
    const stem = stepStem(match[1] ?? '');
    if (stem !== undefined) stems.add(stem);
  }
  return stems;
}

/**
 * A colleague's sentence that claims a step the visitor explicitly gave someone else on this topic ("Mei will test
 * the rule" -> Arjun: "I'd sooner be the one testing that"). Steps nobody was given, and the assignee's own, pass.
 */
export function claimsStepGivenToOther(
  text: string,
  speaker: string,
  guestLines: readonly string[],
  names: readonly string[],
): boolean {
  const claimed = [...text.matchAll(SELF_CLAIM_VERB_RE)].map((match) => match[1] ?? '');
  if (claimed.length === 0) return false;
  const givenToSpeaker = new Set(guestLines.flatMap((line) => [...stepsGivenTo(line, speaker)]));
  const givenToOthers = new Set(
    names
      .filter((name) => name !== speaker)
      .flatMap((name) => guestLines.flatMap((line) => [...stepsGivenTo(line, name)])),
  );
  return claimed.some((word) => {
    const stem = stepStem(word);
    return stem !== undefined && givenToOthers.has(stem) && !givenToSpeaker.has(stem);
  });
}

/** The host is pointing the visitor at their follow-up card. */
const CARD_POINT_RE =
  /\b(?:your card|the card|card on the right|screen on the right|panel on the right|right-hand panel|on your screen)\b/i;

/** Merge the readings of the lines gathered into one guest turn, so the planner sees one meaning. */
function mergeReadings(readings: readonly GuestReading[]): GuestReading | undefined {
  if (readings.length === 0) return undefined;
  const order: GuestReading['kind'][] = [
    'park', 'idea', 'question', 'answer', 'agree', 'unsure', 'off_topic', 'backchannel', 'noise',
  ];
  const kind = order.find((candidate) => readings.some((reading) => reading.kind === candidate)) ?? readings[0]!.kind;
  const addressee = readings.find((reading) => reading.addressee !== undefined)?.addressee;
  const chosenOption = [...readings].reverse().find((reading) => reading.chosenOption !== undefined)?.chosenOption;
  // The turn's meaning is only a stand-in when every line that gave it was a failed read (#68).
  const failed = readings.every((reading) => reading.kind !== kind || reading.failed === true);
  const mergedSlot = (slot: 'action' | 'catchAddressed' | 'practical') =>
    readings.find((reading) => reading.readiness[slot].covered)?.readiness[slot] ?? { covered: false };
  return {
    kind,
    ...(addressee === undefined ? {} : { addressee }),
    answersOpenQuestion: readings.some((reading) => reading.answersOpenQuestion),
    relevantFactIds: [...new Set(readings.flatMap((reading) => reading.relevantFactIds))],
    relevantCatchIds: [...new Set(readings.flatMap((reading) => reading.relevantCatchIds))],
    readiness: {
      action: mergedSlot('action'),
      catchAddressed: mergedSlot('catchAddressed'),
      practical: mergedSlot('practical'),
    },
    ...(chosenOption === undefined ? {} : { chosenOption }),
    ...(failed ? { failed: true as const } : {}),
  };
}

/**
 * A host sentence that tells the visitor to send the follow-up themselves. The code points at the card, so the
 * model must not repeat that instruction in its own words.
 */
const HOST_SEND_INSTRUCTION_RE = new RegExp(
  `\\b(?:(?:send|post|email|e-mail|share|message|circulate|forward|announce|broadcast|text)(?:s|ed|ing)?|sharing|emailing|messaging|circulating|announcing)\\b` +
    `[^.!?]*\\b(?:note|decision|update|follow-?up|summary|invite|announcement|card|message|channel|chat|group|team)\\b`,
  'i',
);

/**
 * "Worth putting that on the staff channel": a place to post names the send even without a send verb or a "you",
 * and a confirmation of the visitor's call never mentions the channel, so this shape is always dropped.
 */
const HOST_SEND_PLACE_RE =
  /\b(?:put|putting|drop|dropping|stick|sticking|get|getting)\b[^.!?]*\b(?:on|in|into|onto)\s+(?:the\s+)?(?:\w+\s+)?(?:channel|chat|group)\b/i;

/** The host opens with the instruction itself ("Send the card rules...") rather than describing what happened. */
const HOST_IMPERATIVE_START_RE =
  /^(?:please\s+)?(?:send|post|email|e-mail|share|message|circulate|forward|announce|broadcast|text|put|drop|stick)\b/i;

/** The host's sentence names the visitor or says "you", so it is an instruction to them and not a confirmation. */
function addressesVisitor(text: string, visitorName: string | undefined): boolean {
  if (/\byou(?:['’]ll|['’]re|['’]ve)?\b|\byour\b/i.test(text)) return true;
  return visitorName !== undefined && namesVisitor(text, visitorName);
}

/** True when the sentence says the visitor's name (not just "you"). */
function namesVisitor(text: string, visitorName: string): boolean {
  const name = visitorName.trim();
  return name.length > 0 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/** True when the sentence names one of the colleagues, so it hands them a task rather than instructing the visitor. */
function namesColleague(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const who = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return who.length > 0 && new RegExp(`\\b${who}\\b`, 'i').test(text);
  });
}

/** Timing and budget overrides for the AI conversation, with the scenario it plays. */
export interface ConversationOptions {
  topicTurnBudget?: number;
  /** Overrides every topic's time budget; otherwise each agenda item's own minutes are used. */
  topicTimeBudgetMs?: number;
  budgetSilenceMs?: number;
  /** How long before the host nudges the visitor to work from their follow-up card (see {@link DEFAULT_REVIEW_NUDGE_MS}). */
  reviewNudgeMs?: number;
  /** How long before the host moves on from a settled topic whose card is still unfinished (see {@link DEFAULT_REVIEW_WINDOW_MS}). */
  reviewWindowMs?: number;
  openLiveGraceMs?: number;
  observeDelayMs?: number;
  /** When the visitor should HEAR the silence nudge, counted from the end of the room's speech. */
  silencePromptMs?: number;
  /** How much of that wait is used to write the nudge, so the model has it ready on time. */
  silenceNudgeLeadMs?: number;
  bargeInMs?: number;
  /** How long an early colleague brief may wait for its first spoken sentence (see {@link DEFAULT_BRIEF_FIRST_CHUNK_MS}). */
  briefFirstChunkMs?: number;
  /** Pause after an agenda announcement before the host asks the person for their decision. */
  askDelayMs?: number;
  scenario: Scenario;
  /** Quiet needed after the person's last words before the AI answers. */
  responseDelayMs?: number;
  /** Pause between one character and the next (see {@link DEFAULT_SPEAKER_GAP_MS}). */
  speakerGapMs?: number;
  /** Pause between two sentences of the same speaker (see {@link DEFAULT_SENTENCE_GAP_MS}). */
  sentenceGapMs?: number;
  /** See {@link DEFAULT_RETRY_MS}. */
  retryMs?: number;
  /** See {@link DEFAULT_RESUME_MS}. */
  resumeMs?: number;
  /** How many past messages the Director sees. */
  maxHistory?: number;
  /** How long the guest-line reader may take before it retries on the backup model. */
  readerTimeoutMs?: number;
  /** Tests supply a fake reading; the live meeting uses the real reader. */
  readGuestLine?: (input: GuestReaderInput, ports: GuestReaderPorts) => Promise<GuestReading>;
  /** Tests supply the read-back/offer writer; the live meeting streams it from the model. */
  gateStream?: (request: GateSpeakerRequest, signal: AbortSignal) => AsyncIterable<string>;
  gate?: SpeechGate;
  memory?: MeetingMemory;
}

interface DispatchCue {
  /** How the cue is named in a log line when nothing was said. */
  what: string;
  /** The task title that must never be read aloud; a line carrying it is dropped. */
  forbiddenText?: string;
  /** The task may have moved on; checked again right before a line is spoken. */
  shouldStillSpeak?: () => boolean;
  /** Runs once: `true` when at least one line was heard, otherwise `false` and the ask is skipped. */
  onDone?: (spoken: boolean) => void;
}

interface Turn {
  topic?: string;
  /** Do not start playing this turn before this time (the silence nudge is written early and held). */
  notBefore?: number;
  abort: AbortController;
  /** Stops sound, gaps and text waits without cancelling the model stream; replaced when a held turn carries on. */
  soundAbort: AbortController;
  spoken: Array<{
    utterance: Utterance;
    complete: boolean;
    startedAt: number;
    durationMs?: number;
    shadowLineId?: string;
    /** The transcript line this sentence was emitted as, so a cut can replace it and a resume can restore it. */
    transcriptLineId?: string;
    /** This sentence's transcript line is currently shown as cut. */
    transcriptCut?: boolean;
    /** True when the sentence was shown as text instead of played as audio. */
    textOnly?: boolean;
  }>;
  enqueued: Utterance[];
  streamFinished: boolean;
  streamFailed?: boolean;
  /** A sound-only cut-in paused this turn instead of discarding it; its unsaid lines play if no words follow. */
  held?: boolean;
  /** A silence nudge (a check-in, a colleague line or the statement bridge); its note is dropped if it is never heard. */
  nudge?: boolean;
  /** This scripted silence line keeps a live confirmation or offer gate open. */
  gateReask?: boolean;
  /** A scripted lock-in offer, marked on its transcript line so tools need not match the wording. */
  lockOffer?: boolean;
  /** The history entry the nudge note was written from, removed when the visitor speaks before any of it is heard. */
  nudgeNote?: ChatMessage;
  /** Wakes the playback loop when a held turn carries on or is discarded. */
  heldWake?: () => void;
  /** Resolves a planned step's `done` once the step is over (`finishPlannedStep`). */
  release?: () => void;
  aborted: boolean;
  finalized: boolean;
  done: Promise<void>;
  startedAt: number;
  firstSentenceAt?: number;
  /** A line the Host was told to say (an opening, a time-out, a closing), not an answer to the person. */
  scripted?: boolean;
  replay?: boolean;
  scriptedUtterance?: Utterance;
  onScriptedDone?: (spoken: boolean) => void;
  /** A closing line: a cut-off still ends the topic, so its completion callback runs as a failure. */
  endsOnCutoff?: boolean;
  /** A follow-up after a hand-over: this character answers first. */
  forced?: { target: string; from: string };
  /**
   * A spoken request from the host caused by a task (asking a colleague in the room, or pointing the visitor at
   * their card). It has its own completion callback and never hands over by itself.
   */
  dispatchCue?: DispatchCue;
  /** Whether the dispatch cue's completion callback has already run. */
  cueDone?: boolean;
  /** This turn is the single retry after the model failed before saying anything. */
  recoveryRetry?: boolean;
  /** A one-speaker planned step: one ledger line for the whole call, complete only when every sentence is heard. */
  planned?: {
    kind: 'opening' | 'reply';
    factIds: readonly string[];
    catchId?: string;
    /** The whole call's spoken text, stored on its one heard event. */
    text?: string;
    question?: OpenQuestion;
    /** This line was written to answer the open question put to its speaker. */
    answersQuestion?: boolean;
    lastUtterance?: Utterance;
    eventId?: string;
  };
  control?: ReplyControl;
  /** This reply's reactions have been sent; they go out with the first line, not when the reply ends. */
  reactionsSent?: boolean;
}

/** One opening or reply speaker's request, fetched while the previous line is still playing. */
interface PrefetchedOpening {
  kind: 'opening' | 'reply';
  title?: string;
  epoch: number;
  expected: { speaker: string; purpose: SpeakDecision['purpose']; factIds: readonly string[]; catchId?: string };
  controller: AbortController;
  chunks: string[];
  done: boolean;
  failure?: unknown;
  /** A typed first-sentence timeout, so the backup model is chosen without matching an error string. */
  failureKind?: 'firstSentenceTimeout';
  startedAt: number;
  wake?: () => void;
  firstChunkTimer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
}

interface OpeningRun {
  title: string;
  kind: 'opening' | 'reply';
  epoch: number;
  cancelled: boolean;
  /** The guest lines gathered for this reply, merged for first-idea detection and responder choice. */
  guestTurn?: { ids: ReadonlySet<string>; line: HeardLine };
}

/** Minimal async queue so playback can start on the first sentence while the rest is written. */
class SentenceQueue<Item> implements AsyncIterable<Item> {
  private items: Item[] = [];
  private waiting: Array<() => void> = [];
  private closed = false;

  push(item: Item): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Item> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      }
    }
  }
}

/**
 * The AI attendees' conversation with one person, as a small state machine:
 *
 *   idle -> (person finishes speaking) -> thinking -> speaking -> idle
 *
 * and from thinking or speaking, the person starting to talk drops straight back to listening.
 * One turn exists at a time; each has its own abort controller, which stops the model, the
 * synthesis and the sound together. The history records only what the person actually heard.
 */
export class NpcConversation<Clip> {
  private readonly gate: SpeechGate;
  private readonly names: string[];
  private readonly responseDelayMs: number;
  private readonly speakerGapMs: number;
  private readonly sentenceGapMs: number;
  private readonly retryMs: number;
  private readonly resumeMs: number;
  /** The person cut something off that was being said aloud, and nothing recognisable has followed. */
  private cutOff = false;
  /** The last thing the person said was cut off before any answer was spoken. */
  private unanswered = false;
  private lastText = '';
  private readonly maxHistory: number;
  private history: ChatMessage[] = [];
  private human: (HumanInfo & { transcriptName: string }) | undefined;
  private pending: string[] = [];
  /** The guest ledger ids gathered since the last reply, so they can be treated as one guest turn. */
  private pendingGuestLineIds: string[] = [];
  /**Lines the person has said (heard or typed) since they joined; the host asks them for their decision after a few. */
  private humanLines = 0;
  /** Visitor words on this topic, retained for the task context and the lock safety net. */
  private decisionLines: string[] = [];
  private humanSettledOnCurrentItem = false;
  /** That question, captured just before the visitor's latest line, so settling can fold it into the follow-up. */
  private questionBeforeGuestLine: string | undefined;
  private topicOpenedAt = Date.now();
  /** When the person last stopped talking: a line they finished before the topic opened belongs to the last topic. */
  private humanSpeechEndedAt: number | undefined;
  private budgetOffered = false;
  private budgetRecoveryPending = false;
  private budgetOfferAtLine = 0;
  private lastLockAskAt = -Infinity;
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private topicBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  /** Re-checks a time-up close that was held because the guest was answering (#67). */
  private timeUpTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the current topic's time-up close was first held. */
  private timeUpGrace: { title: string | undefined; since: number; logged: boolean } | undefined;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewNudged = false;
  private reviewWarned = false;
  private readonly topicTasks = new Map<string, Map<string, 'pending' | 'done'>>();
  /**
   * The latest visitor card still held as a suggestion on each topic. A settlement names this exact
   * card, so the server never has to guess which held card the decision belongs to.
   */
  private readonly suggestedCardByTopic = new Map<string, string>();
  /** The follow-up kind of the visitor's card on each topic, so a card nudge names what is actually there. */
  private readonly reviewActionKind = new Map<string, ActionKind>();
  /** Topics that have already had their one card nudge. */
  private readonly cardNudgedTopics = new Set<string>();
  /** The single owner of the once-per-topic card pointer, shared by every path that points. */
  private readonly cardPointer = new CardPointer();
  /** Topics the visitor parked or tabled, so moving on needs no "Let's leave it there" wrap-up. */
  private readonly parkedTopics = new Set<string>();
  /** Lines the room actually heard, for the last-resort word-overlap repeat check. */
  private readonly recentSpoken: Array<{ speaker: string; text: string; at: number; topic: string | undefined }> = [];
  /** Everything said on the current topic, and the question still open on it. */
  private readonly topicRecord = new TopicRecord();
  /** Shadow-only heard-event state; its planner decisions are logged and never acted on in this checkpoint. */
  private readonly meetingState: MeetingState;
  private shadowLineSeq = 0;
  /** The open question already named in a `[card] waited` log, so one wait is logged once. */
  private cardWaitLoggedFor: string | undefined;
  /** Lines the visitor said, so the host can tell when they already gave the follow-up to a colleague. */
  private readonly guestLinesByTopic = new Map<string | undefined, string[]>();
  /** Who said aloud they would take on a follow-up, per topic. */
  private readonly volunteersByTopic = new Map<string | undefined, Set<string>>();
  /** People the host has already asked, by name. */
  private readonly asked = new Set<string>();
  /** The agenda has moved on and the host has not asked this person yet. */
  private askDue = false;
  /** Speakers who have already spoken, so a repeated name or job can be stripped from their later lines. */
  private readonly introduced = new Set<string>();
  /** Items where the AI colleagues have already briefed the room before asking the human for a decision. */
  private readonly briefed = new Set<string>();
  /** The item waiting for the room to be free so its colleague briefing can start. */
  private pendingBrief: string | undefined;
  /** The opening currently being written one speaker at a time; undefined when no one-speaker opening is running. */
  private openingRun: OpeningRun | undefined;
  /** The reply to the guest currently being written one speaker at a time. */
  private replyRun: OpeningRun | undefined;
  /** One reader call per finished guest line, started as soon as the line is final. */
  private readonly readingJobs = new Map<string, Promise<void>>();
  /**
   * What the room looked like just before each guest line was recorded: the AI speaker whose line was playing
   * (for the reader's backchannel rule) and the open question the guest was answering.
   */
  private readonly guestLineContext = new Map<string, {
    saidWhileSpeaking?: string;
    openQuestion?: { from: string; to?: string; text: string };
  }>();
  /**
   * Bumped whenever the topic moves on, reopens, is settled or closes unresolved. A reading that finishes
   * against an older epoch belongs to a topic the room has left, so it changes nothing.
   */
  private topicEpoch = 0;
  /** A clarify line that asks which of two offers was meant must not clear the offer it belongs to. */
  private reaskingWhichOne = false;
  /** Bumped when a guest line, interruption, topic change or close makes a prefetched line unsafe. */
  private openingEpoch = 0;
  private openingPrefetch: PrefetchedOpening | undefined;
  /** The next topic's first opening speaker, fetched while the current topic winds down. */
  private upcomingOpeningPrefetch: PrefetchedOpening | undefined;
  /** Guest invitations the fallback has already used, so a meeting never hears the same canned wording twice. */
  private readonly usedGuestInvites = new Set<string>();
  /** Items the meeting has already been asked to leave. */
  private readonly advanced = new Set<string>();
  private linesAtMove = 0;
  /** The agenda item the meeting is on now (the first until the host announces another). */
  private agendaItem: string | undefined;
  private humanTalking = false;
  /** Whether the visitor's most recent accepted line was typed, so recovery never asks a typist to say it again. */
  private lastHumanInputWasTyped = false;
  private recognizingSpeech = false;
  private recognizingTimer: ReturnType<typeof setTimeout> | undefined;
  private respondTimer: ReturnType<typeof setTimeout> | undefined;
  private turn: Turn | undefined;
  private closed = false;
  private concluded = false;
  private paused = false;
  private pausedCutOff = false;
  private cutOffSpeaker: string | undefined;
  private pausedUtterances: Utterance[] | undefined;
  private pausedScripted: { utterance: Utterance; onDone?: (spoken: boolean) => void } | undefined;
  /** A one-speaker opening that Stop interrupted; Resume continues it from the last line the room heard. */
  private pausedOpening: { title: string; restore?: { lineId: string; key: string } } | undefined;
  /** A one-speaker reply that Stop interrupted; Resume replans from the last line the room heard. */
  private pausedReply: {
    title: string | undefined;
    guestTurn?: OpeningRun['guestTurn'];
    /** The last line fully heard before the pause, so the rejoin answer starts from it, not from the welcome. */
    from?: HeardLine;
    /** Guest words heard before the reply could start, kept so the resumed reply can still log and answer them. */
    pendingText?: string;
  } | undefined;
  /** Host cues waiting for a quiet moment to play. */
  private pendingAnnouncements = 0;
  /** The one decision gate being written, queued or spoken for the current topic. */
  private pendingGate: { title: string; kind: 'confirmation' | 'offer'; abort: AbortController } | undefined;
  /** Consecutive follow-up turns the AI started by itself after a hand-over; the person speaking again resets it. */
  private chain = 0;
  private forcedSpeaker: { target: string; from: string } | undefined;
  private decisionWrappedUpOnItem = false;
  /** Whether the room has already asked the visitor a question in the current turn round. */
  private askedGuestInRound = false;
  private readonly memory: MeetingMemory;
  private reopenedTitle: string | undefined;
  private resumeAfterReopen: { lines: string[]; settled: boolean; wrapped: boolean } | undefined;
  private memoryGeneration = 0;

  constructor(
    private readonly ports: NpcPorts<Clip>,
    private readonly options: ConversationOptions,
  ) {
    this.gate = options.gate ?? new SpeechGate();
    this.names = (options.scenario.npcs ?? []).map((npc) => npc.attendee);
    this.meetingState = new MeetingState({
      topics: options.scenario.agenda.map((item, index) => {
        const topic = meetingTopic(item, index);
        const owner = options.scenario.attendees.find((attendee) => attendee.role === item.ownerRole)?.name;
        return owner === undefined ? topic : { ...topic, owner };
      }),
      present: this.names,
      host: (options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee ?? this.names[0],
      colleagues: (options.scenario.npcs ?? []).map((npc) => {
        const attendee = options.scenario.attendees.find((candidate) => candidate.name === npc.attendee);
        const role = options.scenario.roles.find((candidate) => candidate.id === attendee?.role)?.label ?? '';
        return {
          name: npc.attendee,
          text: [role, npc.personality, npc.agenda, ...npc.concerns, npc.speechStyle ?? '', ...(npc.knows ?? [])].join(' '),
        };
      }),
    });
    this.memory = options.memory ?? new MeetingMemory(options.scenario,
      (entries) => this.ports.onMemoryChange?.(entries), (line) => this.ports.log?.(line));
    this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
    this.speakerGapMs = options.speakerGapMs ?? DEFAULT_SPEAKER_GAP_MS;
    this.sentenceGapMs = options.sentenceGapMs ?? DEFAULT_SENTENCE_GAP_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.resumeMs = options.resumeMs ?? DEFAULT_RESUME_MS;
    this.maxHistory = options.maxHistory ?? 30;
    if (this.names.length === 0) throw new Error(`Scenario "${options.scenario.id}" has no npcs`);
    const hostName = (options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    if (hostName !== undefined) {
      this.introduced.add(hostName);
    }
  }

  /** Who the AI attendees are talking to; `transcriptName` is how Kaki's transcript labels them. */
  setHuman(human: HumanInfo & { transcriptName?: string }): void {
    if (this.human?.name !== human.name) this.humanLines = 0;
    this.human = { ...human, transcriptName: human.transcriptName ?? human.name };
    this.meetingState.setGuest(this.human.name);
  }

  resetMemory(): void {
    this.memoryGeneration += 1;
    this.memory.reset();
    this.reopenedTitle = undefined;
    this.resumeAfterReopen = undefined;
    this.recentSpoken.length = 0;
    this.topicRecord.reset();
    this.meetingState.reset();
    this.pendingGuestLineIds = [];
    this.readingJobs.clear();
    this.cancelOpening('the meeting was reset');
    this.cancelReplyRun('the meeting was reset');
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    this.clearUpcomingOpeningPrefetch('the meeting was reset');
    this.shadowLineSeq = 0;
    this.cardWaitLoggedFor = undefined;
    this.lastLockAskAt = -Infinity;
    this.guestLinesByTopic.clear();
    this.volunteersByTopic.clear();
    this.cardNudgedTopics.clear();
    this.cardPointer.clear();
    this.parkedTopics.clear();
    this.reviewActionKind.clear();
    this.suggestedCardByTopic.clear();
    this.usedGuestInvites.clear();
  }

  memorySnapshot(): MeetingMemoryEntry[] { return this.memory.snapshot(); }

  /** The last sentence the room said, if it was a question: then it is the person's turn, and the screen says so. */
  private lastSpoken = '';
  private lastTranscriptEmit = '';
  /** One stable transcript id per spoken sentence, so replaying the same object updates its line. */
  private readonly transcriptLineIds = new WeakMap<Utterance, string>();
  /** Sentences already recorded as a chunk, so a replay only restores what is shown instead of recording them again. */
  private readonly transcriptEmitted = new WeakSet<Utterance>();
  /**
   * The cut opening sentence a resumed opening may re-say. Only that same sentence (same speaker and words) restores
   * the cut line; any other first sentence is new speech and is recorded as a new line. Cleared by the first sentence.
   */
  private pendingTranscriptRestore: { lineId: string; key: string } | undefined;
  private transcriptLineSeq = 0;
  private wingmanHintActive = false;

  private transcriptLineId(utterance: Utterance): string {
    const existing = this.transcriptLineIds.get(utterance);
    if (existing !== undefined) return existing;
    this.transcriptLineSeq += 1;
    const id = `line-${this.transcriptLineSeq}`;
    this.transcriptLineIds.set(utterance, id);
    return id;
  }

  private idleState(): NpcUiState {
    const line = this.lastSpoken.trim();
    const hint = { ...(this.wingmanHintActive ? { wingmanHint: true } : {}),
      canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem };
    return line.endsWith('?') ? { kind: 'idle', yourTurn: line, ...hint } : { kind: 'idle', ...hint };
  }

  /** True while the AI is thinking or speaking. */
  get busy(): boolean {
    return this.turn !== undefined;
  }

  /** The person typed something: it goes straight in, with no check that it is a voice and not an echo. */
  humanTyped(text: string): void {
    const typed = text.trim();
    if (this.closed || this.concluded || typed.length === 0) return;
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.restoreTopicTimers();
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    const abandonedScripted = this.pausedScripted;
    this.pausedScripted = undefined;
    abandonedScripted?.onDone?.(false);
    this.ports.log?.(`typed "${typed}"`);
    this.lastHumanInputWasTyped = true;
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.recoveryCueSpoken = false;
    this.askedGuestInRound = false;
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    if (this.turn !== undefined) this.emitCutTranscript(this.turn);
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed, { human: true });
    this.pending.push(typed);
    this.noteHumanLine(typed);
    this.noteDecisionLine(typed);
    this.discardUnheardNudge();
    this.cancelOpening('the guest typed during the opening');
    this.cancelReplyRun('the guest typed');
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    this.interrupt('the person typed something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
    this.ports.emitState(this.idleState());
  }

  /** The person pressed Stop/Pause: everyone goes quiet and timers are held until they press Resume (or type). */
  stop(): void {
    if (this.closed || this.concluded || this.paused) return;
    const plannedKind = this.replyRun?.kind ?? this.openingRun?.kind ?? this.turn?.planned?.kind;
    const plannedTitle = this.replyRun?.title ?? this.openingRun?.title ??
      (this.turn?.planned !== undefined ? this.turn.topic : undefined);
    const replyScope = this.replyRun?.guestTurn;
    const viewNow = this.meetingState.view(Date.now());
    const replyFrom = this.replyRun === undefined
      ? undefined
      : this.replyPlanView(this.replyRun, viewNow).lastHeard;
    // A guest line heard before its reply started (response delay or a pending reading) is kept, not dropped.
    const pendingIds = [...this.pendingGuestLineIds];
    const pendingText = this.pending.filter((text) => !text.startsWith('[')).join(' ').trim();
    const pendingScope = replyScope ?? (pendingIds.length === 0
      ? undefined
      : this.guestTurnFor(viewNow, new Set(pendingIds)));
    const hasUnansweredGuestLine = pendingScope !== undefined || pendingText.length > 0;
    if (this.turn !== undefined) {
      if (this.turn.scripted === true && this.turn.scriptedUtterance !== undefined) {
        const allSentences = splitSentences(this.turn.scriptedUtterance.text);
        const completedCount = this.turn.spoken.filter((entry) => entry.complete).length;
        const remaining = allSentences.slice(completedCount).join(' ').trim();
        if (remaining.length > 0) {
          this.pausedScripted = {
            utterance: { speaker: this.turn.scriptedUtterance.speaker, text: remaining },
            onDone: this.turn.onScriptedDone,
          };
          this.turn.onScriptedDone = undefined;
        }
      } else {
        const completedCount = this.turn.spoken.filter((entry) => entry.complete).length;
        const remaining = this.turn.enqueued.slice(completedCount);
        if (this.turn.streamFinished && remaining.length > 0) {
          this.pausedUtterances = remaining;
        } else {
          this.pausedCutOff = true;
          this.cutOffSpeaker = remaining[0]?.speaker ?? this.turn.spoken.at(-1)?.utterance.speaker;
        }
      }
    }
    this.paused = true;
    this.humanTalking = false;
    this.humanRecognizing(false);
    this.gate.setHumanTalking(false);
    this.clearBargeTimer();
    this.clearRespondTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    const openingLine = this.turn?.spoken.at(-1);
    const restore = openingLine !== undefined && !openingLine.complete && openingLine.transcriptLineId !== undefined
      ? { lineId: openingLine.transcriptLineId, key: `${openingLine.utterance.speaker}:${openingLine.utterance.text}` }
      : undefined;
    this.cancelOpening('the person pressed stop');
    this.cancelReplyRun('the person pressed stop');
    const pausedFrom = replyFrom ?? viewNow.lastHeard;
    const pausedTitle = plannedTitle ?? this.currentItem()?.title;
    this.pausedOpening = !hasUnansweredGuestLine && plannedKind === 'opening' && plannedTitle !== undefined
      ? { title: plannedTitle, ...(restore === undefined ? {} : { restore }) }
      : undefined;
    this.pausedReply = plannedKind === 'reply' || hasUnansweredGuestLine
      ? {
        title: pausedTitle,
        ...(pendingScope === undefined ? {} : { guestTurn: pendingScope }),
        ...(pausedFrom === undefined ? {} : { from: pausedFrom }),
        ...(pendingText.length === 0 ? {} : { pendingText }),
      }
      : undefined;
    this.clearDeferredFollowUpTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    if (this.timeUpTimer !== undefined) clearTimeout(this.timeUpTimer);
    this.timeUpTimer = undefined;
    this.topicBudgetTimer = undefined;
    this.clearBudgetTimer();
    this.clearReviewTimer();
    this.pending = [];
    this.pendingGuestLineIds = [];
    this.interrupt('the person pressed stop');
    this.unanswered = false;
    this.cutOff = false;
  }

  /**
   * The person came back after the room emptied: drop whatever sentence was cut off before they left, carry on,
   * and let `speaker` say one welcome-back line. A two-minute-old half sentence would only confuse them.
   */
  resumeAfterRejoin(speaker: string, text: string): void {
    if (this.closed || this.concluded || !this.paused) return;
    const reply = this.pausedReply;
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    this.pausedScripted = undefined;
    this.pausedUtterances = undefined;
    this.pausedCutOff = false;
    this.cutOffSpeaker = undefined;
    this.resumeFromPause();
    if (reply === undefined || this.currentItem()?.title !== reply.title) {
      this.announce(speaker, text);
      return;
    }
    this.announce(speaker, text, DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
      if (!spoken || this.closed || this.concluded || this.paused) return;
      if (this.replyRun !== undefined || this.turn !== undefined) return;
      this.ports.log?.('[reply] answering the guest point after the welcome');
      this.startReplyRun(reply.guestTurn, reply.from, reply.pendingText);
    });
  }

  /** The person pressed Resume after pausing: pick back up where the room left off. */
  resumeFromPause(): void {
    if (this.closed || this.concluded || !this.paused) return;
    this.paused = false;
    this.restoreTopicTimers();
    const scripted = this.pausedScripted;
    this.pausedScripted = undefined;
    const utterances = this.pausedUtterances;
    this.pausedUtterances = undefined;
    const wasCutOff = this.pausedCutOff;
    this.pausedCutOff = false;
    const speaker = this.cutOffSpeaker;
    this.cutOffSpeaker = undefined;
    const opening = this.pausedOpening;
    this.pausedOpening = undefined;
    if (opening !== undefined && this.currentItem()?.title === opening.title) {
      this.pausedCutOff = false;
      this.cutOffSpeaker = undefined;
      this.cutOff = false;
      this.unanswered = false;
      this.ports.log?.(`[opening] resuming "${opening.title}" from the last line the room heard`);
      this.pendingTranscriptRestore = opening.restore;
      this.startOpening(opening.title);
      return;
    }
    const reply = this.pausedReply;
    this.pausedReply = undefined;
    if (reply !== undefined && this.currentItem()?.title === reply.title) {
      this.pausedCutOff = false;
      this.cutOffSpeaker = undefined;
      this.cutOff = false;
      this.unanswered = false;
      this.ports.log?.(`[reply] resuming on "${reply.title ?? 'this topic'}" from the last line the room heard`);
      this.startReplyRun(reply.guestTurn, reply.from, reply.pendingText);
      return;
    }
    const item = this.currentItem();
    if (item !== undefined && !this.briefed.has(item.title)) {
      this.pendingBrief = item.title;
      this.prefetchBrief(item.title);
    }
    if (scripted !== undefined) {
      this.startScripted(scripted.utterance, scripted.onDone);
      return;
    }
    if (utterances !== undefined && utterances.length > 0) {
      this.startReplayTurn(utterances);
      return;
    }
    if (wasCutOff) {
      const who = this.human?.name ?? 'The person';
      const speakerHint =
        speaker !== undefined ? ` Begin your reply with "${speaker}:" so ${speaker} finishes their thought first.` : '';
      if (speaker !== undefined) this.forcedSpeaker = { target: speaker, from: speaker };
      this.lastText = `[${who} unpaused the meeting. Carry on from where you left off, briefly, without mentioning the pause.${speakerHint}]`;
      this.history.push({ role: 'user', content: this.lastText });
      this.startTurn(true);
      return;
    }
    if (this.maybeBrief()) return;
    if (this.askDue) {
      this.ask();
      return;
    }
    this.scheduleSilencePrompt();
  }

  private restoreTopicTimers(): void {
    if (this.humanSettledOnCurrentItem) {
      this.startReviewWindow();
      this.checkTopicAdvance();
    } else {
      this.topicBudgetTimer = setTimeout(() => this.offerBudgetLock(true),
        this.topicTimeBudgetMs()).unref();
    }
  }

  /** The person is pressing keys in the chat input: push back any active silence timer so nobody cuts in while they type. */
  humanTyping(): void {
    if (this.closed || this.concluded || this.paused) return;
    if (this.silenceTimer !== undefined) {
      this.scheduleSilencePrompt();
    }
  }

  /** Speech-to-text is currently transcribing a finished stretch of the person's microphone audio. */
  humanRecognizing(active: boolean): void {
    if (this.recognizingTimer !== undefined) {
      clearTimeout(this.recognizingTimer);
      this.recognizingTimer = undefined;
    }
    this.recognizingSpeech = active && !this.closed && !this.concluded;
    if (this.recognizingSpeech) {
      this.clearSilenceTimer();
      this.recognizingTimer = setTimeout(() => {
        this.recognizingTimer = undefined;
        this.recognizingSpeech = false;
        this.maybeBrief();
      }, 4_500);
      this.recognizingTimer.unref?.();
    }
  }

  /** Speech recognition heard nothing in the last stretch of the person's microphone: it was not words. */
  humanNothing(): void {
    this.humanRecognizing(false);
    if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0) return;
    if (!(this.cutOff || this.unanswered)) {
      if (this.maybeBrief()) return;
      if (this.turn === undefined && this.respondTimer === undefined && !this.decisionWrappedUpOnItem) {
        this.scheduleSilencePrompt();
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0) return;
      if (this.cutOff) this.resume();
      else if (this.unanswered && this.openingRun === undefined) this.startTurn(true);
    }, DEFAULT_NOTHING_MS);
  }

  /** The person's microphone started or stopped carrying speech. */
  humanSpeech(talking: boolean): void {
    if (this.closed || this.concluded || this.paused) return;
    if (talking === this.humanTalking) {
      // Should not happen: a start while already marked talking, with an answer running, means a stop was missed.
      if (talking && this.turn !== undefined) this.ports.log?.('ignored the person starting to talk: already marked as talking, a stop was missed');
      return;
    }
    this.humanTalking = talking;
    this.gate.setHumanTalking(talking);
    this.humanSpeechEndedAt = talking ? undefined : Date.now();
    if (talking) {
      this.clearRespondTimer();
      this.clearSilenceTimer();
      // A held turn is already silent; it waits for words (real interrupt) or none (carry on).
      if (this.turn === undefined || this.turn.held === true) return;
      // The microphone can pick up the room's own voice or a noise for a moment. Stopping the speaker for that makes it
      // stutter and start again, so it is only cut off once the person has kept talking a while; a shorter burst waits for
      // recognised words (`humanText` interrupts then), and carries on if there were none.
      this.clearBargeTimer();
      const baseWaitMs = this.options.bargeInMs ?? DEFAULT_BARGE_IN_MS;
      const waitMs = baseWaitMs;
      if (waitMs <= 0) {
        this.interrupt('the person started talking');
        return;
      }
      this.bargeTimer = setTimeout(() => {
        this.bargeTimer = undefined;
        if (this.humanTalking && !this.closed) this.interrupt('the person kept talking');
      }, waitMs);
    } else {
      this.clearBargeTimer();
      this.scheduleRespond();
    }
  }

  /**
   * The browser recognised some of the person's words.
   * Returns the accepted words (which may have the AI's own echo trimmed out), or undefined when
   * the line was ignored. The runner uses that to forward only accepted speech to the transcript.
   */
  humanText(text: string): string | undefined {
    this.humanRecognizing(false);
    const heard = text.trim();
    // One stop belongs to one recognised line, accepted or not: a stop left behind by a rejected line (often the AI's
    // own echo) would make the next line look older than the topic, and it would be shown but never answered.
    const endedAt = this.humanSpeechEndedAt;
    this.humanSpeechEndedAt = undefined;
    if (this.closed || this.concluded || heard.length === 0) return undefined;
    if (this.paused) {
      this.ports.log?.(`ignored "${heard}": the meeting is paused`);
      return undefined;
    }

    const decision = this.gate.check(heard);
    if (!decision.ok) {
      const mic = this.ports.describeMic?.();
      this.ports.log?.(`ignored "${heard}" (${decision.reason}${mic === undefined ? '' : `; ${mic}`})`);
      return undefined;
    }

    const accepted = decision.text ?? heard;
    // The recogniser can finish a line just after the agenda moved on. Said whole before this topic opened, it was
    // about the last topic: it is shown, but it is not this topic's first guest line, so the opening carries on.
    if (!this.humanTalking && endedAt !== undefined && endedAt < this.topicOpenedAt) {
      const topic = this.currentItem()?.title ?? 'this topic';
      this.ports.log?.(`[topic] "${accepted}" was said before "${topic}" opened: shown, but not answered as a line on it`);
      this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted, { human: true });
      this.scheduleRespond();
      return accepted;
    }
    this.lastHumanInputWasTyped = false;
    // Recognised words over a line that is still playing, without a barge-in, are held: the AI line finishes
    // and is heard whole, then this line goes to the reader like any other. Only the voice-timing barge-in
    // (a held turn) makes it a real interruption. A turn the model is still writing, with nothing heard yet, is not
    // a line playing: the guest's words replace it, or the cancelled reply would leave them waiting forever.
    const heldOverAiLine = this.turn !== undefined && this.turn.held !== true && this.turn.finalized !== true &&
      this.turn.spoken.length > 0;
    if (heldOverAiLine) this.clearBargeTimer();
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    const abandonedScripted = this.pausedScripted;
    this.pausedScripted = undefined;
    abandonedScripted?.onDone?.(false);
    if (decision.text !== undefined) {
      this.ports.log?.(`heard "${accepted}" (cut the AI's own words "${decision.removed ?? ''}" out of "${heard}")`);
    } else {
      this.ports.log?.(`heard "${accepted}"`);
    }
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    if (!heldOverAiLine && this.turn !== undefined) this.emitCutTranscript(this.turn);
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted, { human: true });
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.recoveryCueSpoken = false;
    this.askedGuestInRound = false;
    this.clearSilenceTimer();
    this.pending.push(accepted);
    this.noteHumanLine(accepted);
    this.noteDecisionLine(accepted);
    // The voice detector normally got here first; this covers a quiet person it missed.
    this.discardUnheardNudge();
    this.cancelOpening('the guest spoke during the opening', !heldOverAiLine);
    this.cancelReplyRun('the guest spoke', !heldOverAiLine);
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    if (!heldOverAiLine) this.interrupt('the person said something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
    this.ports.emitState(this.idleState());
    return accepted;
  }

  /**
   * The Host's spoken cue (opening, time-out, closing): `speaker` says `text` aloud, with no model call.
   * It waits for a quiet moment, so it never talks over the person or an answer, and is dropped if the
   * room stays busy for `giveUpMs`. It becomes a transcript line when it starts to play, like anything else a character says,
   * so the feed shows it in the order it is heard.
   * The person talking over it stops it, as with any other speech.
   */
  announce(
    speaker: string,
    text: string,
    giveUpMs = DEFAULT_ANNOUNCE_GIVE_UP_MS,
    onDone?: (spoken: boolean) => void,
    shouldStillSpeak?: () => boolean,
    options: { endsOnCutoff?: boolean; gateReask?: boolean; lockOffer?: boolean } = {},
  ): void {
    const line = text.trim();
    if (this.closed || line.length === 0 || !this.names.includes(speaker)) return;
    if (this.pendingBrief !== undefined) this.prefetchBrief(this.pendingBrief);
    if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
      this.ports.log?.(`skipped ${speaker}'s cue "${line}": already handled`);
      onDone?.(false);
      return;
    }
    this.cueWhenQuiet(
      `${speaker}'s cue "${line}"`,
      () => this.startScripted(
        { speaker, text: line }, onDone, options.endsOnCutoff === true, options.gateReask === true, options.lockOffer === true),
      giveUpMs,
      () => onDone?.(false),
      shouldStillSpeak,
    );
  }

  /**
   * Sam announces the agenda item the meeting has moved to. A cue for a topic whose opening already ran is stale
   * and is dropped, so an announcement can never arrive after the room has already started discussing it.
   */
  announceNextTopic(speaker: string, title: string, text: string, onDone?: (spoken: boolean) => void): void {
    if (this.topicAlreadyOpened(title)) {
      this.ports.log?.(`[opening] dropped a stale announcement for "${title}": the topic already opened`);
      onDone?.(false);
      return;
    }
    this.announce(speaker, text, DEFAULT_ANNOUNCE_GIVE_UP_MS, onDone);
  }

  /** True once the one-speaker opening for `title` has started (or its brief has been delivered). */
  private topicAlreadyOpened(title: string): boolean {
    const wanted = cleanSpokenTopic(title).toLowerCase();
    const matches = (candidate: string): boolean => cleanSpokenTopic(candidate).toLowerCase() === wanted;
    return [...this.briefed].some(matches) || (this.openingRun !== undefined && matches(this.openingRun.title));
  }

  /**
   * Sam asks an AI colleague in the room to take on a task: the request comes from the model, in his own words,
   * from `note`. It waits for a quiet moment, and `onDone` runs when it was heard or skipped. A line that reads
   * the task title aloud is dropped; if nothing can be said, the ask is skipped rather than read from a template.
   */
  askColleague(
    target: string,
    note: string,
    options: {
      /** The task title the spoken line must never carry. */
      forbiddenText?: string;
      shouldStillSpeak?: () => boolean;
      onDone?: (spoken: boolean) => void;
    } = {},
  ): void {
    const host = this.facilitatorOrCoHost();
    if (this.closed || this.paused || host === undefined || !this.names.includes(target)) {
      this.ports.log?.(`[dispatch] cannot ask ${target}: the conversation is not running`);
      options.onDone?.(false);
      return;
    }
    const what = `${host}'s request to ${target}`;
    this.cueWhenQuiet(
      what,
      () => {
        this.forcedSpeaker = { target: host, from: host };
        this.pending.push(note);
        this.startTurn(false, false, undefined, {
          what,
          forbiddenText: options.forbiddenText,
          shouldStillSpeak: options.shouldStillSpeak,
          onDone: options.onDone,
        });
      },
      DEFAULT_ANNOUNCE_GIVE_UP_MS,
      () => options.onDone?.(false),
      options.shouldStillSpeak,
    );
  }

  /**
   * Marks the visitor's follow-up card on the current topic as pointed out, once per topic. Kaki's pop-up on the
   * visitor's screen is what points at the card: Sam is a colleague in the meeting, not Kaki, so he never says it.
   * `onDone(true)` means this call claimed the topic's pointer; `false` means it was refused or already claimed.
   */
  markCardShown(options: { onDone?: (claimed: boolean) => void } = {}): void {
    const topic = this.currentItem()?.title;
    const view = this.meetingState.view(Date.now());
    if (!this.humanSettledOnCurrentItem) {
      this.ports.log?.('[card] refused to point at the card before the decision was committed');
      options.onDone?.(false);
      return;
    }
    if (view.openQuestion?.to === this.human?.name) {
      this.ports.log?.('[card] refused to point at the card while a question to the guest is open');
      options.onDone?.(false);
      return;
    }
    if (!this.hasVisitorCardOnTopic(topic)) {
      this.ports.log?.('[card] refused to point at the card before a TASK_UPDATED card exists');
      options.onDone?.(false);
      return;
    }
    if (this.closed || this.concluded || this.paused) {
      this.ports.log?.('[dispatch] cannot mark the card: the conversation is not running');
      options.onDone?.(false);
      return;
    }
    if (topic === undefined) {
      this.ports.log?.('[dispatch] skipped the card pointer: no topic is open');
      options.onDone?.(false);
      return;
    }
    if (!this.cardPointer.claim(topic)) {
      this.ports.log?.(`skipped the card pointer on "${topic}": the visitor was already pointed to their card`);
      options.onDone?.(false);
      return;
    }
    this.ports.log?.(`[card] the follow-up on "${topic}" is on the visitor's screen; Kaki's pop-up points at it, Sam says nothing`);
    options.onDone?.(true);
  }

  /**
   * Runs `start` at the next quiet moment. The cue counts as pending speech while it waits, so the silence prompt
   * does not talk over it. It is given up after `giveUpMs`, or as soon as `shouldStillSpeak` turns false.
   */
  private cueWhenQuiet(
    label: string,
    start: () => void,
    giveUpMs: number,
    onDropped: () => void,
    shouldStillSpeak?: () => boolean,
  ): void {
    this.pendingAnnouncements += 1;
    let deadline = Date.now() + giveUpMs;
    const drop = (message: string): void => {
      this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
      this.ports.log?.(message);
      onDropped();
    };
    const attempt = (): void => {
      if (this.closed) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        return;
      }
      if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
        drop(`skipped ${label}: already handled`);
        return;
      }
      if (this.paused) {
        deadline += 500;
        setTimeout(attempt, 500);
        return;
      }
      const busy =
        this.cutOff ||
        this.unanswered ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        // A reply that is still reading the guest's line has no turn yet, but it will speak next (#66).
        this.replyRun !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined;
      if (!busy) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        start();
      } else if (Date.now() >= deadline) {
        drop(`dropped ${label}: the room stayed busy`);
      } else {
        setTimeout(attempt, 500);
      }
    };
    attempt();
  }

  /**
   * Whether an origin token refers to the item the meeting is on. `undefined` means the conversation itself
   * is speaking for the current topic; `null` means an external task with no recorded origin, which must
   * never move or hold the current topic.
   */
  private originIsCurrent(origin: string | null | undefined): boolean {
    if (origin === undefined) return true;
    if (origin === null) return false;
    const current = this.currentItem()?.title;
    if (current === undefined) return false;
    return origin === current || cleanSpokenTopic(origin).toLowerCase() === cleanSpokenTopic(current).toLowerCase();
  }

  /** True when the host has already pointed the visitor at their card on the topic the meeting is on now. */
  cardPointedOnCurrentTopic(): boolean {
    return this.cardPointer.hasPointed(this.currentItem()?.title);
  }

  /** The open question on the topic the meeting is on now, if any. */
  openQuestionOnCurrentTopic(): OpenQuestion | undefined {
    this.startTopic(this.currentItem()?.title);
    return this.topicRecord.openQuestion;
  }

  /** True while the current topic is inside its own time budget, so a wait for an answer can never hold the meeting. */
  private topicStillHasTime(): boolean {
    return Date.now() - this.topicOpenedAt < this.topicTimeBudgetMs();
  }

  /** Log a wait once per question text, so a poll every half second does not flood the log. */
  private logCardWait(text: string): void {
    if (this.cardWaitLoggedFor === text) return;
    this.cardWaitLoggedFor = text;
    this.ports.log?.(`[card] waited: open question "${text}"`);
  }

  /** The visitor or the colleague the question was put to has answered it. */
  private answerTopicQuestion(): void {
    this.topicRecord.answered();
    this.cardWaitLoggedFor = undefined;
  }

  /** True when the current topic has, or is about to have, a follow-up card for the visitor. */
  private currentTopicHasVisitorFollowUp(): boolean {
    const title = this.currentItem()?.title;
    return title !== undefined && this.reviewActionKind.has(title);
  }

  /** The title of the agenda item the meeting is on now, for a welcome-back line. */
  currentTopicTitle(): string | undefined {
    return this.currentItem()?.title;
  }

  /** True when `title` names the item the meeting is on now; external task events use this to stay on their own topic. */
  onCurrentAgenda(title: string | undefined): boolean {
    if (title === undefined) return false;
    const current = this.currentItem()?.title;
    if (current === undefined) return false;
    return title === current || cleanSpokenTopic(title).toLowerCase() === cleanSpokenTopic(current).toLowerCase();
  }

  /** If the host is currently speaking a task-dispatch prompt and the visitor just clicked Accept/Decline, stop that prompt immediately. */
  cancelPendingDispatch(origin?: string | null): void {
    if (!this.originIsCurrent(origin)) return;
    if (
      this.turn?.scripted === true &&
      /\b(?:sent you a task|this one is yours|can you take on|Kaki panel on the right|on your screen)\b/i.test(
        this.turn.scriptedUtterance?.text ?? '',
      )
    ) {
      this.interrupt('visitor already handled the task');
    }
  }

  /** Interrupt any running AI turn, speak `text` aloud from `speaker` without transcribing it, and then pause the conversation. */
  announceClosing(speaker: string, text: string): void {
    const line = text.trim();
    if (this.closed || this.concluded || line.length === 0 || !this.names.includes(speaker)) return;
    this.stop();
    this.concluded = true;
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    this.pausedScripted = undefined;
    const abort = new AbortController();
    const turn: Turn = {
      abort,
      soundAbort: this.linkedSound(abort),
      spoken: [],
      enqueued: [],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      scripted: true,
      scriptedUtterance: { speaker, text: line },
    };
    this.turn = turn;
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    const player = this.playAll(turn, queue, false);
    for (const sentence of splitSentences(line)) {
      const item: Utterance = { speaker, text: sentence };
      const clip = this.synthesizeWithRetry(item, signal);
      queue.push({ utterance: item, clip });
    }
    queue.close();
    turn.done = player.then(() => {
      this.turn = undefined;
      this.gate.setAiAudible(false);
      this.ports.emitState(this.idleState());
      this.paused = true;
    });
  }

  /** True while `speaker` is a character this conversation voices. */
  plays(speaker: string): boolean {
    return !this.closed && this.names.includes(speaker);
  }

  /**
   * True when `speaker` said aloud, at any point on the current topic, that they would take on a follow-up. Tasks are
   * handed out when the topic settles, often minutes later, so this is not limited to a time window.
   */
  volunteeredOnTopic(speaker: string): boolean {
    return this.volunteersByTopic.get(this.currentItem()?.title)?.has(speaker) ?? false;
  }

  /**
   * The completed lines the room actually heard on the current topic, oldest first, with the agenda item they
   * were heard on. A line that was merely queued or was cut off is not a commitment. Capped so a long topic
   * cannot keep growing the prompt.
   */
  completedLinesOnTopic(): Array<{ speaker: string; text: string; agendaItemTitle: string }> {
    const view = this.meetingState.view(Date.now());
    const title = this.currentItem()?.title ?? view.topic;
    if (title === undefined) return [];
    return view.lines
      .filter((line) => line.complete)
      .slice(-40)
      .map((line) => ({ speaker: line.speaker, text: line.text, agendaItemTitle: title }));
  }

  /**
   * Any speaker must not restate a point that the room already heard on this topic in the last minute
   * or since this turn was requested (`sinceAt`).
   */
  private repeatsRecently(
    text: string,
    sinceAt?: number,
  ): { speaker: string; text: string; at: number; topic: string | undefined } | undefined {
    const words = contentWords(text);
    const topic = this.currentItem()?.title;
    const now = Date.now();
    return this.recentSpoken.find((entry) =>
      ((entry.topic === topic && now - entry.at <= DEFAULT_REPEAT_WINDOW_MS) ||
        (sinceAt !== undefined && entry.at >= sinceAt)) &&
      closelyRepeats(words, contentWords(entry.text), negates(text), negates(entry.text)));
  }

  /** Mirror a topic change into the shadow state without changing what the existing path says. */
  private startTopic(topic: string | undefined): void {
    this.topicRecord.start(topic);
    if (this.meetingState.openTopic(topic, Date.now())) this.topicEpoch += 1;
  }

  private nextShadowLineId(): string {
    this.shadowLineSeq += 1;
    return `heard-${this.shadowLineSeq}`;
  }

  /** Log the planner's choice for a heard event; nothing it returns is acted on in this checkpoint. */
  private planNextTurn(event: PlannerEvent): void {
    const log = this.ports.log;
    if (log === undefined) return;
    const decision = nextPlannerDecision(this.meetingState.view(Date.now()), event);
    log(`[planner] ${describeDecision(decision)} because ${decision.reason}`);
  }

  /** Mark a played line complete or cut off, then ask the planner what the room would do next. */
  private shadowLineEnded(
    eventId: string | undefined,
    complete: boolean,
    heard?: { factIds?: readonly string[]; sentencesHeard?: number },
  ): void {
    if (eventId === undefined) return;
    const line = this.meetingState.lineEnded(eventId, complete, Date.now(), heard);
    if (line === undefined) return;
    this.planNextTurn({ kind: complete ? 'heard' : 'interrupted', line });
  }

  /** Open the one heard event for a planned call when its first sentence starts playing. */
  private startPlannedLine(turn: Turn, utterance: Utterance): void {
    const planned = turn.planned;
    if (planned === undefined || planned.eventId !== undefined) return;
    planned.eventId = this.nextShadowLineId();
    this.meetingState.lineStarted({
      id: planned.eventId,
      speaker: utterance.speaker,
      text: planned.text ?? utterance.text,
      at: Date.now(),
      ...(planned.question === undefined
        ? {}
        : { question: { to: planned.question.to, text: planned.question.text } }),
      ...(planned.answersQuestion === true ? { answersQuestion: true } : {}),
      ...(planned.factIds.length === 0 ? {} : { factIds: planned.factIds }),
      ...(planned.catchId === undefined ? {} : { catchId: planned.catchId }),
    });
  }

  /** Close a planned call's single heard event; it is complete only when every sentence was heard. */
  private endPlannedLine(turn: Turn, complete: boolean): void {
    const planned = turn.planned;
    if (planned === undefined) return;
    const spoken = turn.spoken.filter((entry) => entry.complete);
    const heardText = spoken.map((entry) => entry.utterance.text).join(' ');
    const view = this.meetingState.view(Date.now());
    const heardFactIds = heardText.length === 0 ? [] : (planned.factIds ?? []).filter((id) => {
      const text = view.facts.find((fact) => fact.id === id)?.text;
      return text !== undefined && carriesFact(heardText, text);
    });
    this.shadowLineEnded(planned.eventId, complete, { factIds: heardFactIds, sentencesHeard: spoken.length });
  }

  /** A guest line is heard whole the moment it is typed or recognised; it never has a partial playback. */
  private recordShadowGuestLine(text: string): string | undefined {
    const guest = this.human?.name;
    if (guest === undefined) return undefined;
    const eventId = this.nextShadowLineId();
    // The reader says what kind of line this is; it is never guessed from words.
    // Capture the question as it stood before this line: recording the guest line clears it from the view
    // until the reader says whether the line answers, so afterwards the reader would be told there was none.
    const openQuestion = this.meetingState.view(Date.now()).openQuestion;
    this.meetingState.lineStarted({
      id: eventId,
      speaker: guest,
      text,
      at: Date.now(),
      proposal: false,
    });
    this.shadowLineEnded(eventId, true);
    const turn = this.turn;
    const saidWhileSpeaking = turn === undefined
      ? undefined
      : turn.spoken.at(-1)?.utterance.speaker ?? turn.planned?.lastUtterance?.speaker ?? turn.scriptedUtterance?.speaker;
    this.guestLineContext.set(eventId, {
      ...(saidWhileSpeaking === undefined ? {} : { saidWhileSpeaking }),
      ...(openQuestion === undefined
        ? {}
        : { openQuestion: { from: openQuestion.from, to: openQuestion.to, text: openQuestion.text } }),
    });
    void this.readingJob(eventId);
    return eventId;
  }

  /** Start (or reuse) the reader call for one finished guest line. */
  private readingJob(eventId: string): Promise<void> {
    const existing = this.readingJobs.get(eventId);
    if (existing !== undefined) return existing;
    const guest = this.human?.name;
    const view = this.meetingState.view(Date.now());
    const line = view.lines.find((entry) => entry.eventId === eventId && entry.complete && entry.speaker === guest);
    if (line === undefined || line.reading !== undefined) return Promise.resolve();
    const topic = this.currentItem()?.title;
    const epoch = this.topicEpoch;
    const job: Promise<void> = this.readOneGuestLine(view, line)
      .then((reading) => {
        if (this.currentItem()?.title !== topic || this.topicEpoch !== epoch) {
          this.ports.log?.('[reader] stale reading dropped');
          return;
        }
        this.meetingState.recordReading(eventId, reading);
        const fresh = this.meetingState.view(Date.now());
        const choseAnOffer = reading.chosenOption !== undefined &&
          fresh.offer?.choices?.[reading.chosenOption] !== undefined;
        // A failed read is not a "no": the confirmation or offer stays live and Sam asks again (#68).
        if (reading.failed !== true && reading.kind !== 'agree' && reading.kind !== 'backchannel' &&
            !choseAnOffer && !fresh.whichOneAsked) {
          if (fresh.confirmationAsked) {
            this.meetingState.setConfirmationAsked(false);
            this.ports.log?.('[confirm] the guest corrected the call; it is open again');
          }
          if (fresh.offerAsked) {
            this.meetingState.setOfferAsked(false);
            this.ports.log?.('[offer] the guest did not agree; the offer is no longer live');
          }
        }
      })
      .catch((error: unknown) => {
        this.ports.log?.(`[reader] failed to start: ${error instanceof Error ? error.message : String(error)}`);
      });
    this.readingJobs.set(eventId, job);
    void job.finally(() => {
      if (this.readingJobs.get(eventId) === job) this.readingJobs.delete(eventId);
      this.guestLineContext.delete(eventId);
    });
    return job;
  }

  /**
   * Any colleague line heard after an offer or confirmation makes it no longer the last thing the guest
   * heard, so an "agree" can no longer commit it. Only a direct reply to that exact line can.
   */
  private clearAskedGates(): void {
    if (this.reaskingWhichOne || this.turn?.gateReask === true) return;
    const view = this.meetingState.view(Date.now());
    if (!view.offerAsked && !view.confirmationAsked) return;
    this.meetingState.setOfferAsked(false);
    this.meetingState.setConfirmationAsked(false);
    this.ports.log?.('[gate] another line was heard after the offer or confirmation; it is no longer live');
  }

  /** The conversation's own memory of a spoken sentence, without touching the heard-event ledger. */
  private noteSpokenSides(
    utterance: Utterance,
    topic: string | undefined,
    procedural = false,
  ): OpenQuestion | undefined {
    this.clearAskedGates();
    if (utterance.speaker === this.facilitatorOrCoHost() && LOCK_ASK_RE.test(utterance.text)) {
      this.lastLockAskAt = Date.now();
    }
    if (isVolunteer(utterance.text)) {
      this.volunteersByTopic.set(topic, new Set([...(this.volunteersByTopic.get(topic) ?? []), utterance.speaker]));
    }
    if (isQuestionToVisitor(utterance.text, utterance.speaker, this.names, this.human?.name)) {
      this.askedGuestInRound = true;
    }
    this.startTopic(topic);
    // The colleague the last question was put to has answered it by speaking; a new question then replaces it.
    if (this.topicRecord.openQuestion?.to === utterance.speaker) this.answerTopicQuestion();
    const question = this.questionFrom(utterance);
    if (question !== undefined) this.topicRecord.ask(procedural ? { ...question, procedural: true } : question);
    this.topicRecord.said({ speaker: utterance.speaker, text: utterance.text });
    const now = Date.now();
    this.recentSpoken.push({ speaker: utterance.speaker, text: utterance.text, at: now, topic });
    return question;
  }

  private rememberSpoken(
    utterance: Utterance,
    topic: string | undefined,
    factIds?: readonly string[],
    procedural = false,
  ): string | undefined {
    const question = this.noteSpokenSides(utterance, topic, procedural);
    const eventId = this.nextShadowLineId();
    this.meetingState.lineStarted({
      id: eventId,
      speaker: utterance.speaker,
      text: utterance.text,
      at: Date.now(),
      ...(question === undefined ? {} : { question: { to: question.to, text: question.text } }),
      ...(factIds === undefined || factIds.length === 0 ? {} : { factIds }),
    });
    return eventId;
  }

  /**
   * The question a colleague's line leaves open: put to the colleague it names, or to the visitor when it
   * names nobody else. A question with no one to answer it is not recorded.
   */
  private questionFrom(utterance: Utterance): OpenQuestion | undefined {
    const text = utterance.text.trim();
    if (!text.endsWith('?')) return undefined;
    const target = findHandover([{ speaker: utterance.speaker, text }], this.names, this.human?.name)?.target;
    if (target !== undefined && target !== utterance.speaker) {
      return { from: utterance.speaker, to: target, text };
    }
    const guest = this.human?.name;
    return guest === undefined ? undefined : { from: utterance.speaker, to: guest, text };
  }

  /** Remember when the host points the visitor at their follow-up card, so the review nudge does not repeat it. */
  private noteCardPoint(utterance: Utterance): void {
    if (utterance.speaker !== this.facilitatorOrCoHost() || !CARD_POINT_RE.test(utterance.text)) return;
    const view = this.meetingState.view(Date.now());
    if (!this.humanSettledOnCurrentItem) {
      this.ports.log?.('[card] ignored a card pointer before the decision was committed');
      return;
    }
    if (view.openQuestion?.to === this.human?.name) {
      this.ports.log?.('[card] ignored a card pointer while a question to the guest is open');
      return;
    }
    if (!this.hasVisitorCardOnTopic()) {
      this.ports.log?.('[card] ignored a card pointer before a TASK_UPDATED card exists');
      return;
    }
    this.cardPointer.claim(this.currentItem()?.title);
  }

  /** Resolves when no turn is running. */
  async settled(): Promise<void> {
    while (this.turn !== undefined) await this.turn.done;
  }

  close(): void {
    this.closed = true;
    this.humanRecognizing(false);
    this.clearRespondTimer();
    this.clearBargeTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.cancelOpening('the meeting ended');
    this.cancelReplyRun('the meeting ended');
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    this.clearUpcomingOpeningPrefetch('the meeting ended');
    this.clearDeferredFollowUpTimer();
    this.clearBudgetTimer();
    this.clearReviewTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    if (this.timeUpTimer !== undefined) clearTimeout(this.timeUpTimer);
    this.timeUpTimer = undefined;
    this.topicBudgetTimer = undefined;
    this.interrupt('the meeting ended');
  }

  private bargeTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private briefTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredFollowUpTimer: ReturnType<typeof setTimeout> | undefined;
  private silencePromptStage = 0;
  /** The current read-back has already had its one "Still with me?" nudge. */
  private confirmationNudged = false;
  private bridgedStatementOnTurn = false;
  /** The host has already asked the visitor to repeat themselves since their last line. */
  private recoveryCueSpoken = false;

  private clearBargeTimer(): void {
    if (this.bargeTimer !== undefined) clearTimeout(this.bargeTimer);
    this.bargeTimer = undefined;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private clearBriefTimer(): void {
    if (this.briefTimer !== undefined) clearTimeout(this.briefTimer);
    this.briefTimer = undefined;
  }

  private clearDeferredFollowUpTimer(): void {
    if (this.deferredFollowUpTimer !== undefined) clearTimeout(this.deferredFollowUpTimer);
    this.deferredFollowUpTimer = undefined;
  }

  private clearRespondTimer(): void {
    if (this.respondTimer !== undefined && this.pending.length > 0) {
      const caller = new Error().stack?.split('\n')[2]?.trim() ?? 'unknown';
      this.ports.log?.(`[respond] cancelled a pending reply (${caller})`);
    }
    if (this.respondTimer !== undefined) clearTimeout(this.respondTimer);
    this.respondTimer = undefined;
  }

  private scheduleRespond(): void {
    if (this.humanTalking || this.paused) {
      if (this.pending.length > 0) this.ports.log?.(`[respond] held: ${this.humanTalking ? 'the person is talking' : 'paused'}`);
      return;
    }
    if (this.pending.length === 0) {
      // The person cut in but no words came (a cough, a click, a word the recogniser missed): carry on.
      if (this.cutOff && !this.closed) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && !this.paused && this.cutOff && this.pending.length === 0) this.resume();
        }, this.resumeMs);
        return;
      }
      // Something cut the answer off (a cough, a click) and the person said nothing more: answer anyway.
      if (this.unanswered && !this.closed && this.openingRun === undefined) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && !this.paused && this.unanswered && this.pending.length === 0) this.startTurn(true);
        }, this.retryMs);
        return;
      }
      if (!this.recognizingSpeech && this.briefTimer === undefined) {
        this.maybeBrief();
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (!this.humanTalking && !this.closed && !this.paused) {
        // A line held over a line that is still playing waits for that line to finish and is read then.
        if (this.turn !== undefined) return;
        if (this.shouldStartReplyRun()) this.startReplyRun();
        else this.startTurn();
      } else this.ports.log?.(`[respond] skipped: ${this.closed ? 'closed' : this.paused ? 'paused' : 'the person is talking'}`);
    }, this.responseDelayMs);
  }

  /** A guest line that was held while an AI line played, waiting for that line to finish. */
  private hasHeldGuestLine(): boolean {
    return this.pending.some((text) => !text.startsWith('['));
  }

  /** True when the pending words are a guest line that the one-speaker reply path should answer. */
  private shouldStartReplyRun(): boolean {
    if (this.human === undefined || this.openingRun !== undefined || this.replyRun !== undefined) return false;
    const guestText = this.pending.filter((text) => !text.startsWith('[')).join(' ').trim();
    // Every finished guest line goes to the reader, including a bare "yes": it may be the answer to Sam's question.
    return guestText.length > 0;
  }

  /**
   * The AI host (or NPC co-host when a human plays the host seat) asks a person directly, once, for the call their role owns:
   * it comes when the meeting moves to the next agenda item (`agendaMoved`), or, as a backstop, after many lines from them.
   */
  private facilitatorOrCoHost(): string | undefined {
    const npcs = this.options.scenario.npcs ?? [];
    const host = npcs.find((npc) => npc.role === 'host')?.attendee;
    if (host !== undefined && this.names.includes(host)) return host;
    return npcs.find((npc) => npc.role === 'participant' && this.names.includes(npc.attendee))?.attendee ?? this.names[0];
  }

  private askLine(): string | undefined {
    const human = this.human;
    if (human === undefined || this.asked.has(human.name) || this.mode() === 'observe' ||
        this.openingRun !== undefined) return undefined;
    const host = this.facilitatorOrCoHost();
    const owns = responsibilityFor(this.options.scenario, human);
    if (host === undefined || owns === undefined) return undefined;
    this.asked.add(human.name);
    this.askDue = false;
    const decision = this.options.scenario.agenda.find((item) => item.title === (this.agendaItem ?? this.options.scenario.agenda[0]?.title))?.decision;
    if (/decide/i.test(owns) && decision !== undefined) return `${human.name}, ${decision}`;
    return `${human.name}, as ${human.role}, what's your take?`;
  }

  private ask(): void {
    const line = this.askLine();
    const host = this.facilitatorOrCoHost();
    if (line !== undefined && host !== undefined) this.announce(host, line, ASK_GIVE_UP_MS);
  }

  /** True when the visitor gave `name` a follow-up in any of their lines on the current topic. */
  askedByGuestOnTopic(name: string): boolean {
    const lines = this.guestLinesByTopic.get(this.currentItem()?.title) ?? [];
    if (lines.some((text) => assignedByGuest(text, name))) return true;
    // The reader's own judgement also counts: a guest line it read as addressed to `name` AND carrying a
    // concrete call gave them the follow-up, even when the words match no pattern ("Can Ada share the
    // decision with the team?"). Merely being addressed is not enough.
    const view = this.meetingState.view(Date.now());
    return view.readings.some(({ eventId, reading }) =>
      reading.addressee === name && reading.readiness.action.covered === true &&
      view.lines.some((line) => line.eventId === eventId && line.speaker === this.human?.name));
  }

  /** Forget a silence nudge that was written but never heard: the visitor's own line is what the room answers now. */
  private discardUnheardNudge(): void {
    const turn = this.turn;
    if (turn === undefined || turn.nudge !== true || turn.spoken.length > 0) return;
    const note = turn.nudgeNote;
    if (note === undefined) return;
    const at = this.history.indexOf(note);
    if (at !== -1) this.history.splice(at, 1);
    this.ports.log?.('dropped an unheard silence nudge: the visitor spoke first');
  }

  /** The person said another line: ask if they have talked a long time without being asked. */
  private noteHumanLine(text: string): void {
    // The guest's own line is what the room answers now, so any gate still being written or waiting is stale.
    this.clearPendingGate();
    const topic = this.currentItem()?.title;
    this.guestLinesByTopic.set(topic, [...(this.guestLinesByTopic.get(topic) ?? []), text]);
    this.startTopic(topic);
    // A new line starts the silence escalation again at the check-in.
    this.silencePromptStage = 0;
    this.clearSilenceTimer();
    const open = this.topicRecord.openQuestion;
    this.questionBeforeGuestLine = open !== undefined && open.procedural !== true && open.to === this.human?.name
      ? open.text
      : undefined;
    // The visitor speaking is the answer the room was waiting for.
    if (open !== undefined && open.to === this.human?.name) this.answerTopicQuestion();
    this.humanLines += 1;
    const eventId = this.recordShadowGuestLine(text);
    if (eventId !== undefined) this.pendingGuestLineIds.push(eventId);
    if (this.humanLines >= ASK_BACKSTOP_LINES || this.askDue) this.ask();
    if (!this.humanSettledOnCurrentItem && !this.budgetOffered &&
        (this.humanLines - this.linesAtMove >= (this.options.topicTurnBudget ?? DEFAULT_TOPIC_TURN_BUDGET) ||
         Date.now() - this.topicOpenedAt >= this.topicTimeBudgetMs())) {
      queueMicrotask(() => this.offerBudgetLock());
    }
    if (this.budgetOffered && this.humanLines > this.budgetOfferAtLine) {
      this.clearBudgetTimer();
      this.budgetOffered = false;
      this.budgetRecoveryPending = true;
    }
  }

  /** True when the one-speaker path decides from the guest's checked reading. */
  private readinessApplies(): boolean {
    return this.currentItem() !== undefined;
  }

  /**
   * A terminal topic transition: nothing more is planned or read for the topic the room is leaving.
   * Bumping the epoch makes any reading already in flight stale; cancelling the run stops its planning.
   */
  private closeTopicTurn(reason: string): void {
    this.topicEpoch += 1;
    this.cancelReplyRun(reason, false);
    this.cancelOpening(reason, false);
    this.pending = this.pending.filter((text) => text.startsWith('['));
    this.pendingGuestLineIds = [];
    this.clearRespondTimer();
    this.clearBudgetTimer();
    this.clearSilenceTimer();
    this.clearReviewTimer();
    this.clearDeferredFollowUpTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    if (this.timeUpTimer !== undefined) clearTimeout(this.timeUpTimer);
    this.timeUpTimer = undefined;
    this.topicBudgetTimer = undefined;
    // A budget ask owed to the topic being closed must never fire on the next one.
    this.budgetRecoveryPending = false;
    this.meetingState.setConfirmationAsked(false);
    this.meetingState.setOfferAsked(false);
    this.confirmationNudged = false;
    this.clearPendingGate();
  }

  /** The topic closed with nothing usable: record it unresolved honestly, with no decision and no card. */
  private resolveUnresolved(reason = 'no usable call before time ran out'): void {
    const item = this.currentItem();
    const host = this.facilitatorOrCoHost();
    if (item === undefined || host === undefined || this.advanced.has(item.title)) return;
    this.advanced.add(item.title);
    this.closeTopicTurn(`the topic "${item.title}" closed unresolved`);
    // The topic is leaving: no question heard on it may stay open and block the card or the next item.
    this.meetingState.clearOpenQuestion();
    const topicName = spokenAgendaName(this.options.scenario, item.title);
    this.ports.log?.(`[topic] "${item.title}" is unresolved: ${reason}`);
    this.humanSettledOnCurrentItem = false;
    this.budgetOffered = false;
    this.announce(host, `Okay, we'll leave ${topicName} open for now, and come back if there's time.`,
      DEFAULT_ANNOUNCE_GIVE_UP_MS, () => {
        if (this.closed || this.currentItem()?.title !== item.title) return;
        this.advanceOrEnd();
      }, undefined, { endsOnCutoff: true });
  }

  /**
   * Settle once and create the matching visitor task through the task store. In one-speaker mode it returns
   * whether a confirmation or offer was actually queued, so the budget is not spent on a call it never made.
   */
  lockDecision(
    followUp?: { kind: ActionKind; title: string },
    options: { timeout?: boolean; confirmed?: boolean } = {},
  ): boolean {
    const item = this.currentItem();
    const human = this.human;
    if (this.closed || this.concluded || item === undefined || human === undefined ||
        this.humanSettledOnCurrentItem || this.decisionLines.length === 0) return false;
    if (this.readinessApplies() && options.confirmed !== true) {
      const view = this.meetingState.view(Date.now());
      if (options.timeout === true) {
        this.ports.log?.('[lock] time is up with no confirmed call; marking the topic unresolved');
        this.resolveUnresolved();
        return false;
      }
      // A one-speaker reply already producing Sam's line owns the next move; a lock must not queue a second
      // confirmation behind a line that may itself restate the call.
      if (this.turn !== undefined && this.turn.planned?.kind === 'reply' && this.turn.finalized !== true) {
        this.ports.log?.('[lock] a reply line is already being spoken; its plan owns the confirmation');
        return false;
      }
      if (readinessMet(view)) {
        this.ports.log?.('[lock] readiness holds, but the guest has not confirmed the call yet');
        return this.askConfirmation(view);
      }
      if (mergedReadiness(view).action.covered) {
        this.ports.log?.('[lock] the guest has an action but has not confirmed it; asking for confirmation');
        return this.askConfirmation(view);
      }
      this.ports.log?.('[lock] nothing usable is covered; offering a concrete call');
      return this.askOffer(view);
    }
    const role = this.options.scenario.roles.find((candidate) =>
      candidate.id === human.role)?.id;
    if (role === undefined) return false;
    this.humanSettledOnCurrentItem = true;
    this.decisionWrappedUpOnItem = true;
    this.closeTopicTurn(`the topic "${item.title}" was settled`);
    // The visitor's call answers whatever was still being asked of them on this topic.
    this.answerTopicQuestion();
    this.wingmanHintActive = false;
    this.clearSilenceTimer();
    this.clearBudgetTimer();
    const chosen = followUp ?? (item.followUp === undefined ? undefined : {
      kind: item.followUp.kind, title: item.followUp.hint,
    });
    const kind = chosen?.kind ?? 'mattermost_post';
    const title = chosen?.title ?? `Share the decision on ${item.title}`;
    this.reviewActionKind.set(item.title, kind);
    const decision = this.decisionLines.join(' ');
    const openQuestion = this.questionBeforeGuestLine;
    this.questionBeforeGuestLine = undefined;
    const reopening = this.reopenedTitle === item.title;
    const generation = this.memoryGeneration;
    const previousMemory = this.memory.snapshot();
    this.memory.decision(item.title, decision);
    const cardId = this.suggestedCardByTopic.get(item.title);
    const input: SuggestInput = {
      title,
      context: `Agenda: ${item.title}. Visitor decision: ${decision}` +
        (openQuestion === undefined ? '' : ` Open question to carry into the follow-up: ${openQuestion}`),
      suggestedAssignee: role, actionKind: kind, agendaItemTitle: item.title,
      decisionSource: decision,
      ...(cardId === undefined ? {} : { cardId }),
    };
    const succeeded = (): void => {
      if (generation !== this.memoryGeneration) return;
      if (this.closed || this.currentItem()?.title !== item.title) return;
      // Only a successful settle closes the questions heard on the topic; a failed one keeps the room's open gate.
      this.meetingState.clearOpenQuestion();
      if (reopening) {
        this.reopenedTitle = undefined;
        this.decisionLines = this.resumeAfterReopen?.lines ?? [];
        this.humanSettledOnCurrentItem = this.resumeAfterReopen?.settled ?? false;
        this.decisionWrappedUpOnItem = this.resumeAfterReopen?.wrapped ?? false;
        this.resumeAfterReopen = undefined;
        const host = this.facilitatorOrCoHost();
        if (host !== undefined && this.agendaItem !== undefined) {
          this.announce(host, `Back to ${spokenAgendaName(this.options.scenario, this.agendaItem)}. What do you think?`);
        }
        this.ports.emitState(this.idleState());
        return;
      }
      this.prefetchUpcomingBrief();
      this.startReviewWindow();
      this.checkTopicAdvance();
    };
    const failed = (error: unknown): void => {
      if (generation !== this.memoryGeneration || this.closed) return;
      this.memory.replace(previousMemory);
      this.ports.log?.(`ERROR: could not create follow-up for "${item.title}": ${String(error)}`);
      if (this.closed || this.currentItem()?.title !== item.title) return;
      this.humanSettledOnCurrentItem = false;
      this.decisionWrappedUpOnItem = false;
      this.clearReviewTimer();
      this.ports.emitState(this.idleState());
    };
    try {
      if (this.ports.settleTopic === undefined) throw new Error('No follow-up task port');
      const result = this.ports.settleTopic(input, reopening);
      if (result === undefined) succeeded();
      else void result.then(succeeded, failed);
    } catch (error) { failed(error); }
    this.ports.emitState(this.idleState());
    return true;
  }

  /** Task lifecycle is the only normal reason to leave a settled topic. */
  taskStatus(id: string, origin: string | undefined, status: string, isVisitorTask: boolean, declined = false): void {
    const title = this.currentItem()?.title;
    if (!isVisitorTask || title === undefined || !this.onCurrentAgenda(origin)) return;
    const tasks = this.topicTasks.get(title) ?? new Map<string, 'pending' | 'done'>();
    if (status === 'DISMISSED') tasks.delete(id);
    else tasks.set(id, status === 'SYNCED' || declined ? 'done' : 'pending');
    this.topicTasks.set(title, tasks);
    const cardTitle = origin ?? title;
    if (status === 'DISMISSED' || status === 'SUPERSEDED') {
      if (this.suggestedCardByTopic.get(cardTitle) === id) this.suggestedCardByTopic.delete(cardTitle);
    } else if (status === 'SUGGESTED') {
      this.suggestedCardByTopic.set(cardTitle, id);
    }
    // The visitor is working on the card: the review window counts from their last step, not from the decision.
    if (tasks.get(id) === 'pending' && this.humanSettledOnCurrentItem && !this.reviewWarned) {
      this.clearReviewTimer();
      this.startReviewWindow();
    }
    this.checkTopicAdvance();
  }

  private clearBudgetTimer(): void {
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
  }

  /** Why closing the topic on time would cut across the guest right now, if it would. */
  private timeUpBusyReason(): string | undefined {
    if (this.humanTalking) return 'the guest is talking';
    if (this.recognizingSpeech) return "the guest's words are still being recognised";
    if (this.replyRun !== undefined) return 'a reply to the guest is still running';
    // Only a line already sounding counts; a turn still waiting to start (a held nudge) does not.
    if (this.turn !== undefined && !this.turn.finalized && this.turn.spoken.some((entry) => !entry.complete)) {
      return 'a line is still playing';
    }
    const view = this.meetingState.view(Date.now());
    if (view.confirmationAsked || view.offerAsked) return "Sam is waiting for the guest's answer";
    return undefined;
  }

  /**
   * When the topic's time is up while the guest is answering (or Sam is waiting for an answer), hold the close
   * and check again shortly, for at most TIME_UP_GRACE_MS on this topic. True when the close was deferred (#67).
   */
  private deferTimeUp(): boolean {
    const reason = this.timeUpBusyReason();
    if (reason === undefined) return false;
    const title = this.currentItem()?.title;
    const grace = this.timeUpGrace?.title === title && this.timeUpGrace !== undefined
      ? this.timeUpGrace
      : { title, since: Date.now(), logged: false };
    this.timeUpGrace = grace;
    if (Date.now() - grace.since >= TIME_UP_GRACE_MS) {
      this.ports.log?.(`[lock] time is up and the grace is spent (${reason}); closing anyway`);
      return false;
    }
    if (!grace.logged) {
      grace.logged = true;
      this.ports.log?.(`[lock] time is up, but ${reason}; holding the close`);
    }
    if (this.timeUpTimer !== undefined) clearTimeout(this.timeUpTimer);
    this.timeUpTimer = setTimeout(() => {
      this.timeUpTimer = undefined;
      if (this.closed || this.currentItem()?.title !== title) return;
      this.offerBudgetLock(true);
    }, TIME_UP_RECHECK_MS);
    this.timeUpTimer.unref?.();
    return true;
  }

  private offerBudgetLock(timeUp = false): void {
    if (this.budgetOffered || this.humanSettledOnCurrentItem) return;
    if (timeUp && this.readinessApplies()) {
      if (this.deferTimeUp()) return;
      this.ports.log?.('[lock] time is up; closing the topic honestly rather than inventing a call');
      this.resolveUnresolved();
      return;
    }
    if (this.decisionLines.length === 0) return;
    if (this.readinessApplies()) {
      // The budget only asks a gate the planner understands; the guest's checked reading still decides.
      this.ports.log?.('[lock] the budget is up; readiness decides the call');
      // The budget is only spent once a confirmation or offer was actually queued. A reply line still speaking
      // owns the next move, so keep the budget owed and retry as soon as that run finishes.
      if (this.lockDecision()) {
        this.budgetOffered = true;
        this.budgetOfferAtLine = this.humanLines;
      } else {
        this.budgetRecoveryPending = true;
        this.ports.log?.('[lock] the budget could not ask yet; it will retry when the line finishes');
      }
      return;
    }
    const remaining = DEFAULT_REPEAT_WINDOW_MS - (Date.now() - this.lastLockAskAt);
    if (remaining > 0) {
      this.clearBudgetTimer();
      this.budgetTimer = setTimeout(() => this.offerBudgetLock(timeUp), remaining).unref();
      return;
    }
    this.budgetOffered = true;
    this.budgetOfferAtLine = this.humanLines;
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return;
    const title = this.currentItem()?.title;
    const topicName = title === undefined ? 'this topic' : spokenAgendaName(this.options.scenario, title);
    this.announce(host, `${this.human?.name ?? 'You'}, shall we lock in what you've said on ${topicName}?`,
      DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        // Never heard: the offer is still owed, and the visitor's next line brings it back.
        if (!spoken) {
          this.budgetOffered = false;
          return;
        }
        this.clearBudgetTimer();
        this.budgetTimer = setTimeout(() => {
          if (this.currentItem()?.title !== title || this.humanSettledOnCurrentItem) return;
          if (this.humanLines === this.budgetOfferAtLine) this.lockDecision(undefined, { timeout: true });
        }, 2 * (this.options.budgetSilenceMs ?? DEFAULT_BUDGET_SILENCE_MS)).unref();
      }, undefined, { lockOffer: true });
  }

  /**
   * The clock's overtime cue would pile another decision request onto Sam's recent ask, or repeat the time-up
   * close Sam already owns: while readiness runs an unsettled topic whose budget is not spent, its time-up at the
   * agenda item's minutes closes the topic. Once the budget was spent on a lock-in ask, the cue is the backstop.
   */
  shouldSkipOvertimeCue(): boolean {
    const timeUpOwnsIt = this.readinessApplies() && !this.budgetOffered && !this.humanSettledOnCurrentItem;
    return timeUpOwnsIt || Date.now() - this.lastLockAskAt < 15_000;
  }

  /** The current topic's time budget: the option when set, else the agenda item's own minutes. */
  private topicTimeBudgetMs(): number {
    if (this.options.topicTimeBudgetMs !== undefined) return this.options.topicTimeBudgetMs;
    const minutes = this.currentItem()?.minutes;
    return minutes !== undefined && minutes > 0 ? minutes * 60_000 : DEFAULT_TOPIC_TIME_BUDGET_MS;
  }

  /** The card line's variant for this topic, so two topics never use the same wording. */
  private topicIndex(title: string): number {
    const index = this.options.scenario.agenda.findIndex((item) => item.title === title);
    return index < 0 ? 0 : index;
  }

  /**
   * The fallback invitation used only when a colleague's brief ends without asking the visitor in.
   * It starts from the topic's usual variant, then skips any wording already heard in this meeting.
   */
  private nextGuestInvite(who: string, title: string | undefined): string {
    const lines: ReadonlyArray<(name: string) => string> = [
      (name) => `${name}, what would you do?`,
      (name) => `How would you handle that, ${name}?`,
      (name) => `What feels workable, ${name}?`,
      (name) => `Where would you start, ${name}?`,
      (name) => `${name}, what's your call on this?`,
      (name) => `What would you try first, ${name}?`,
    ];
    const start = this.topicIndex(title ?? '') % lines.length;
    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = lines[(start + offset) % lines.length]!(who);
      if (!this.usedGuestInvites.has(line)) {
        this.usedGuestInvites.add(line);
        return line;
      }
    }
    // More topics than stock wordings: make one from the topic itself so no wording is ever repeated.
    const topic = spokenAgendaName(this.options.scenario, title ?? 'this');
    const fresh = `${who}, what would you do about ${topic}?`;
    this.usedGuestInvites.add(fresh);
    return fresh;
  }


  /** True once a TASK_UPDATED for the visitor's card on this topic has reached the conversation. */
  private hasVisitorCardOnTopic(title = this.currentItem()?.title): boolean {
    return title !== undefined && (this.topicTasks.get(title)?.size ?? 0) > 0;
  }

  private startReviewWindow(): void {
    const title = this.currentItem()?.title;
    if (title === undefined || !this.humanSettledOnCurrentItem || this.reviewTimer !== undefined) return;
    const total = this.options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    const nudgeAt = this.options.reviewNudgeMs ?? DEFAULT_REVIEW_NUDGE_MS;
    const delay = this.reviewNudged ? Math.max(total - nudgeAt, 0) : Math.min(nudgeAt, total);
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = undefined;
      this.nudgeOrWarn(title);
    }, delay).unref();
  }

  /** The next step of the review window, held while a question on this topic is still open. */
  private nudgeOrWarn(title: string): void {
    if (this.currentItem()?.title !== title || this.reviewWarned) return;
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return;
    const view = this.meetingState.view(Date.now());
    if (!this.humanSettledOnCurrentItem) {
      this.ports.log?.('[card] skipped the review nudge before the decision was committed');
      return;
    }
    if (view.openQuestion?.to === this.human?.name) {
      this.ports.log?.('[card] skipped the review nudge while a question to the guest is open');
      this.startReviewWindow();
      return;
    }
    if (!this.hasVisitorCardOnTopic(title)) {
      if (!this.reviewNudged) {
        this.ports.log?.('[card] skipped the review nudge: no follow-up card exists yet');
        this.reviewNudged = true;
        this.startReviewWindow();
        return;
      }
    }
    const total = this.options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    const nudgeAt = this.options.reviewNudgeMs ?? DEFAULT_REVIEW_NUDGE_MS;
    if (!this.reviewNudged && nudgeAt < total) {
      this.startTopic(title);
      const open = this.topicRecord.openQuestion;
      if (open !== undefined && this.topicStillHasTime()) {
        this.logCardWait(open.text);
        this.reviewTimer = setTimeout(() => {
          this.reviewTimer = undefined;
          this.nudgeOrWarn(title);
        }, CARD_WAIT_POLL_MS).unref();
        return;
      }
      this.reviewNudged = true;
      if (this.cardNudgedTopics.has(title) || this.cardPointer.hasPointed(title)) {
        this.ports.log?.(`skipped the card nudge on "${title}": the visitor was already pointed to their card`);
        this.startReviewWindow();
        return;
      }
      // Kaki's pop-up already points at the card, so the review nudge only marks it; Sam says nothing.
      this.cardPointer.claim(title);
      this.cardNudgedTopics.add(title);
      this.ports.log?.(`[card] review nudge on "${title}": Kaki's pop-up points at the card, Sam says nothing`);
      this.startReviewWindow();
      return;
    }
    this.reviewWarned = true;
    if (this.parkedTopics.has(title)) {
      this.ports.log?.(`skipped the leave-there wrap-up on "${title}": the topic was parked`);
      this.checkTopicAdvance(true);
      return;
    }
    const wrapUp = liveWrapUpLine(this.options.scenario, title);
    if (!this.hasVisitorCardOnTopic(title)) {
      this.reviewWarned = true;
      this.ports.log?.('[card] moving on without a pointer: no follow-up card arrived');
      this.announce(host, wrapUp, DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        if (!spoken) {
          this.reviewWarned = false;
          this.startReviewWindow();
          return;
        }
        if (this.hasVisitorCardOnTopic(title)) {
          this.ports.log?.('[card] a card arrived during the wrap-up; pointing at it instead of moving on');
          this.reviewWarned = false;
          this.reviewNudged = false;
          this.startReviewWindow();
          return;
        }
        this.checkTopicAdvance(true);
      });
      return;
    }
    this.announce(host, wrapUp,
      DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        if (spoken) this.checkTopicAdvance(true);
        else {
          this.reviewWarned = false;
          this.startReviewWindow();
        }
      });
  }

  private checkTopicAdvance(expired = false, afterGrace = false): void {
    const title = this.currentItem()?.title;
    if (title === undefined || !this.humanSettledOnCurrentItem || this.advanced.has(title)) return;
    const tasks = this.topicTasks.get(title);
    if (!expired && (tasks === undefined || tasks.size === 0 || [...tasks.values()].some((state) => state !== 'done'))) return;
    if (!expired && !afterGrace && this.graceTimer === undefined) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = undefined;
        if (this.currentItem()?.title === title) this.checkTopicAdvance(false, true);
      }, this.options.openLiveGraceMs ?? DEFAULT_OPEN_LIVE_GRACE_MS).unref();
      return;
    }
    if (!expired && !afterGrace) return;
    // Sam does not move on while a question on this topic is still waiting for an answer; the topic's own
    // time limit releases the wait, so the meeting can never get stuck on a question nobody answers.
    this.startTopic(title);
    const open = this.topicRecord.openQuestion;
    if (open !== undefined && this.topicStillHasTime()) {
      this.logCardWait(open.text);
      this.reviewTimer = setTimeout(() => this.checkTopicAdvance(expired, afterGrace), CARD_WAIT_POLL_MS).unref();
      return;
    }
    if (this.paused || this.turn !== undefined || this.pendingAnnouncements > 0 || this.humanTalking) {
      this.reviewTimer = setTimeout(() => this.checkTopicAdvance(expired, afterGrace), 500).unref();
      return;
    }
    this.advanced.add(title);
    this.clearReviewTimer();
    if (expired) this.ports.log?.(`review window expired on "${title}"`);
    this.advanceOrEnd();
  }

  /** Clear the review sequence; any progress on the card starts it again from the nudge. */
  private clearReviewTimer(): void {
    if (this.reviewTimer !== undefined) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.reviewNudged = false;
    this.reviewWarned = false;
  }

  /**
   * Keep a visitor line as part of their decision on this item. A repeat of an earlier line adds nothing, and a line
   * that is only a question asks rather than decides; both would otherwise show up in the task's accepted decision.
   */
  private noteDecisionLine(line: string): void {
    const text = line.trim();
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (text === '' || /^[^.!?]*\?$/.test(text)) return;
    if (this.decisionLines.some((kept) => kept.toLowerCase().replace(/\s+/g, ' ') === key)) return;
    this.decisionLines.push(text);
  }

  /** The agenda item the meeting is on, and how this person takes part in it. */
  private currentItem() {
    const title = this.reopenedTitle ?? this.agendaItem ?? this.options.scenario.agenda[0]?.title;
    if (title === undefined) return undefined;
    const cleanTitle = cleanSpokenTopic(title).toLowerCase();
    return this.options.scenario.agenda.find(
      (item) => item.title === title || cleanSpokenTopic(item.title).toLowerCase() === cleanTitle,
    );
  }

  private mode() {
    return itemMode(this.options.scenario, this.currentItem(), this.human?.role);
  }

  private advanceOrEnd(): void {
    this.prefetchUpcomingBrief();
    const agenda = this.options.scenario.agenda;
    const current = this.currentItem();
    const currentIdx = current === undefined ? -1 : agenda.findIndex((item) => item.title === current.title);
    if (currentIdx >= 0 && currentIdx + 1 >= agenda.length && this.ports.endMeeting !== undefined) {
      this.ports.endMeeting();
      return;
    }
    this.ports.advanceAgenda?.();
  }

  /**
   * The meeting is on a new agenda item (also called for the first one, once the welcome is spoken). If the person takes part in
   * it, the host asks them for their call after the announcement. If they only watch, the characters start talking it through
   * between themselves, unless the person speaks first: a newcomer sees how the team works before being asked anything.
   */
  agendaMoved(title?: string): void {
    this.reopenedTitle = undefined;
    this.resumeAfterReopen = undefined;
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.cancelOpening('the agenda moved');
    this.cancelReplyRun('the agenda moved');
    this.pausedOpening = undefined;
    this.pausedReply = undefined;
    this.pendingBrief = undefined;
    if (title === undefined) {
      this.clearUpcomingOpeningPrefetch('the agenda moved');
    } else {
      const previousTitle = this.currentItem()?.title;
      const cleanTitle = cleanSpokenTopic(title).toLowerCase();
      const matched = this.options.scenario.agenda.find(
        (candidate) => candidate.title === title || cleanSpokenTopic(candidate.title).toLowerCase() === cleanTitle,
      );
      const incomingTitle = matched?.title ?? title;
      // Keep a request already fetched for this incoming topic while the previous item wound down.
      if (this.upcomingOpeningPrefetch?.title !== incomingTitle) {
        this.clearUpcomingOpeningPrefetch('the agenda moved');
      }
      if (previousTitle !== undefined && previousTitle !== incomingTitle) {
        this.closeTopicTurn(`the agenda moved from "${previousTitle}" to "${incomingTitle}"`);
        this.meetingState.clearOpenQuestion();
        this.interrupt('agenda moved');
        // A reply that was cut off belongs to the topic the room just left; it must not hold back the new announcement.
        this.unanswered = false;
        this.cutOff = false;
        this.cutOffSpeaker = undefined;
      }
      this.agendaItem = incomingTitle;
      this.silencePromptStage = 0;
      this.bridgedStatementOnTurn = false;
      this.recoveryCueSpoken = false;
    }
    if (this.closed || this.human === undefined) return;
    this.linesAtMove = this.humanLines;
    this.humanSettledOnCurrentItem = false;
    this.askedGuestInRound = false;
    this.questionBeforeGuestLine = undefined;
    this.startTopic(this.currentItem()?.title);
    this.cardWaitLoggedFor = undefined;
    this.wingmanHintActive = false;
    this.decisionLines = [];
    this.topicOpenedAt = Date.now();
    this.budgetOffered = false;
    this.budgetRecoveryPending = false;
    this.lastLockAskAt = -Infinity;
    this.reviewWarned = false;
    this.clearBudgetTimer();
    this.clearReviewTimer();
    this.clearDeferredFollowUpTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    if (this.timeUpTimer !== undefined) clearTimeout(this.timeUpTimer);
    this.timeUpTimer = undefined;
    this.topicBudgetTimer = setTimeout(() => this.offerBudgetLock(true),
      this.topicTimeBudgetMs()).unref();
    this.ports.emitState(this.idleState());
    this.decisionWrappedUpOnItem = false;
    const item = this.currentItem();
    // Let the AI colleagues briefly explain the background and trade-offs of the item first before asking the
    // visitor for their decision, so the visitor isn't asked cold — in any meeting that has AI colleagues.
    if (item !== undefined && !this.briefed.has(item.title)) {
      this.askDue = false;
      this.briefLater(item.title);
      return;
    }
    if (this.asked.has(this.human.name)) return;
    this.askDue = true;
    setTimeout(() => {
      if (!this.closed && !this.paused && this.askDue) this.ask();
    }, this.options.askDelayMs ?? DEFAULT_ASK_DELAY_MS).unref();
  }

  private briefLater(title: string): void {
    if (this.closed || this.paused) return;
    this.pendingBrief = title;
    this.clearBriefTimer();
    this.briefTimer = setTimeout(() => {
      this.briefTimer = undefined;
      this.maybeBrief();
    }, this.options.observeDelayMs ?? DEFAULT_OBSERVE_DELAY_MS).unref();
  }

  /**
   * Start the pending briefing as soon as the room is free, and keep it pending until then. The room may be busy
   * with a scripted line or a turn for as long as it likes; whoever finishes checks here instead of retrying on a timer.
   */
  private maybeBrief(): boolean {
    const title = this.pendingBrief;
    if (title === undefined || this.closed || this.paused) return false;
    if (this.briefed.has(title) || this.currentItem()?.title !== title || this.humanLines > this.linesAtMove) {
      this.pendingBrief = undefined;
      return false;
    }
    if (
      this.turn !== undefined ||
      this.humanTalking ||
      this.recognizingSpeech ||
      this.pending.length > 0 ||
      this.respondTimer !== undefined ||
      this.pendingAnnouncements > 0
    ) {
      return false;
    }
    this.pendingBrief = undefined;
    if (this.openingRun !== undefined) return true;
    this.briefed.add(title);
    this.ports.log?.(`[opening] starting "${title}" one speaker at a time`);
    this.startOpening(title);
    return true;
  }

  briefsOnTopic(title: string): boolean {
    if (this.closed || !this.onCurrentAgenda(title)) return false;
    const current = this.currentItem()?.title;
    if (current === undefined || this.briefed.has(current) || this.pendingBrief !== current) return false;
    return true;
  }

  private prefetchBrief(title: string): void {
    if (this.human === undefined || this.pendingBrief !== title || this.currentItem()?.title !== title) return;
    // The first speaker's line is written while the host welcomes and hands over, so it is ready when they finish.
    this.startUpcomingOpeningPrefetch(title);
  }

  /**
   * The next item's brief is fetched while the room winds the current item down, so it is ready by the
   * time the host finishes moving on. This is the same head start topic 1 gets from the long welcome.
   */
  private prefetchUpcomingBrief(): void {
    if (this.closed || this.paused || this.human === undefined) return;
    const next = this.nextAgendaItem();
    if (next === undefined || this.briefed.has(next.title) || this.currentItem()?.title === next.title) return;
    this.startUpcomingOpeningPrefetch(next.title);
  }

  private nextAgendaItem() {
    const agenda = this.options.scenario.agenda;
    const anchor = this.agendaItem ?? this.currentItem()?.title;
    if (anchor === undefined) return undefined;
    const wanted = cleanSpokenTopic(anchor).toLowerCase();
    const index = agenda.findIndex((item) =>
      item.title === anchor || cleanSpokenTopic(item.title).toLowerCase() === wanted);
    return index < 0 ? undefined : agenda[index + 1];
  }

  /** Start the one-speaker opening for `title`; it runs one planned speaker at a time. */
  private startOpening(title: string): void {
    if (this.openingRun !== undefined) return;
    this.openingEpoch += 1;
    const run: OpeningRun = { title, kind: 'opening', epoch: this.openingEpoch, cancelled: false };
    this.openingRun = run;
    if (this.upcomingOpeningPrefetch?.title === title) {
      this.clearOpeningPrefetch('replaced by the next topic request');
      const prefetched = this.upcomingOpeningPrefetch;
      this.upcomingOpeningPrefetch = undefined;
      prefetched.epoch = run.epoch;
      this.openingPrefetch = prefetched;
    } else {
      this.clearUpcomingOpeningPrefetch('the topic opened');
    }
    void this.runOpening(run).catch((error: unknown) => {
      this.ports.log?.(`[opening] failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.openingRun === run) this.openingRun = undefined;
      this.clearOpeningPrefetch('the opening failed');
    });
  }

  /** One planned speaker per step, replanned from the state after each fully heard line. */
  private async runOpening(run: OpeningRun): Promise<void> {
    let previous = this.meetingState.view(Date.now()).lastHeard;
    if (previous !== undefined && previous.speaker === this.human?.name) {
      this.finishOpening(run);
      return;
    }
    for (;;) {
      if (run.cancelled || this.closed || this.paused) {
        this.finishOpening(run);
        return;
      }
      const view = this.meetingState.view(Date.now());
      let decision = previous === undefined
        ? nextPlannerDecision(view, { kind: 'topicOpened' })
        : nextPlannerDecision(view, { kind: 'heard', line: previous });
      if (decision.kind === 'Speak' && decision.purpose === 'handover') {
        // No handover line is in the ledger (a direct agenda move): plan the first speaker as if the host had just named the topic.
        const synthetic: HeardLine = {
          eventId: `opening-start-${run.epoch}`, speaker: decision.speaker, text: '', at: Date.now(),
          complete: true, proposal: false, catch: false,
        };
        decision = nextPlannerDecision(view, { kind: 'heard', line: synthetic });
      }
      if (decision.kind !== 'Speak' || (decision.purpose !== 'brief' && decision.purpose !== 'invite') ||
          decision.speaker === this.human?.name || !this.names.includes(decision.speaker)) {
        this.ports.log?.(`[opening] ended: ${describeDecision(decision)} (${decision.reason})`);
        this.finishOpening(run);
        return;
      }
      this.ports.log?.(
        `[opening] ${decision.speaker} (${decision.purpose}) asked; responding to "${(previous?.text ?? 'the topic opening').slice(0, 60)}"`,
      );
      const heard = await this.plannedStepWithRetry(run, decision, previous);
      if (run.cancelled) {
        this.finishOpening(run);
        return;
      }
      if (heard === undefined) {
        if (this.closed || this.paused) {
          this.finishOpening(run);
          return;
        }
        if (decision.purpose === 'invite') {
          this.finishWithFallbackInvite(run);
          return;
        }
        this.ports.log?.(`[opening] skipping to the host's question after ${decision.speaker}'s line could not be heard`);
        const invite = this.inviteDecision(previous, 'the opening skipped to the host question');
        if (invite === undefined) {
          this.finishOpening(run);
          return;
        }
        const invited = await this.plannedStepWithRetry(run, invite, previous);
        if (run.cancelled) {
          this.finishOpening(run);
          return;
        }
        if (invited === undefined) {
          this.finishWithFallbackInvite(run);
          return;
        }
        this.afterOpeningQuestion(run);
        return;
      }
      previous = heard;
      if (decision.purpose === 'invite') {
        this.afterOpeningQuestion(run);
        return;
      }
    }
  }

  private finishOpening(run: OpeningRun): void {
    if (this.openingRun !== run) return;
    this.openingRun = undefined;
    this.clearOpeningPrefetch('the opening finished');
    if (this.hasHeldGuestLine()) this.scheduleRespond();
  }

  /** The invite was heard: mark the guest asked, then finish the opening like any other heard turn. */
  private afterOpeningQuestion(run: OpeningRun): void {
    this.finishOpening(run);
    const guest = this.human?.name;
    if (guest !== undefined) this.asked.add(guest);
    this.scheduleSilencePrompt();
  }

  /** The invite could not be heard after its retry: still ask the guest with the meeting's own wording. */
  private finishWithFallbackInvite(run: OpeningRun): void {
    this.finishOpening(run);
    const host = this.facilitatorOrCoHost();
    const guest = this.human?.name;
    if (this.closed || host === undefined || guest === undefined || !this.names.includes(host)) return;
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === run.title);
    const line = item?.decision === undefined
      ? this.nextGuestInvite(guest, run.title)
      : `${guest}, ${item.decision}`;
    this.ports.log?.(`[opening] the host's question could not be heard; using the fallback question`);
    this.announce(host, line, ASK_GIVE_UP_MS, (spoken) => {
      if (spoken) this.asked.add(guest);
      this.scheduleSilencePrompt();
    });
  }

  /** The host's one question to the guest, used as a recovery when a brief step could not be heard. */
  private inviteDecision(previous: HeardLine | undefined, reason: string): SpeakDecision | undefined {
    const host = this.facilitatorOrCoHost();
    if (host === undefined || !this.names.includes(host)) return undefined;
    return { kind: 'Speak', speaker: host, purpose: 'invite', respondsTo: previous?.eventId, reason };
  }

  private async plannedStepWithRetry(
    run: OpeningRun,
    decision: SpeakDecision,
    previous: HeardLine | undefined,
  ): Promise<HeardLine | undefined> {
    let prefetched = this.takeOpeningPrefetch(decision);
    let useFallback = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (run.cancelled || this.closed || this.paused) return undefined;
      const result = await this.playPlannedStep(
        run, decision, previous, attempt === 0 ? prefetched : undefined, useFallback);
      if (result.line !== undefined) return result.line;
      if (run.cancelled) return undefined;
      const missedFirstSentence = result.failure === 'firstSentenceTimeout';
      if (attempt === 0 && missedFirstSentence && this.ports.fallbackStream !== undefined) {
        useFallback = true;
        this.ports.log?.(`[llm-fallback] ${decision.speaker}'s first sentence missed its deadline; using the backup model`);
      }
      const nextStep = attempt === 0
        ? (useFallback ? 'retrying once on the backup model' : 'retrying once with a fresh request')
        : (run.kind === 'opening' ? 'skipping to the host question' : 'ending this reply');
      this.ports.log?.(
        `[${run.kind}] ${decision.speaker} (${decision.purpose}) rejected: ${result.reason ?? 'unknown'}; ${nextStep}`,
      );
      prefetched = undefined;
    }
    return undefined;
  }

  /** Write, check and play one planned line. Nothing is played unless the whole reply passes the check. */
  private async playPlannedStep(
    run: OpeningRun,
    decision: SpeakDecision,
    previous: HeardLine | undefined,
    prefetched: PrefetchedOpening | undefined,
    useFallback = false,
  ): Promise<{ line?: HeardLine; reason?: string; failure?: 'firstSentenceTimeout' }> {
    const view = run.kind === 'reply'
      ? this.replyPlanView(run, this.meetingState.view(Date.now()))
      : this.meetingState.view(Date.now());
    const messages = prefetched === undefined
      ? run.kind === 'opening'
        ? this.openingMessages(decision, previous, view)
        : this.replyMessages(run, decision, previous, view)
      : [];
    if (prefetched === undefined && messages.length === 0) return { reason: 'no request could be built' };
    const factIds = decision.factIds ?? [];
    const abort = prefetched?.controller ?? new AbortController();
    const turn: Turn = {
      topic: run.title,
      abort,
      soundAbort: this.linkedSound(abort),
      spoken: [],
      enqueued: [],
      streamFinished: false,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: prefetched?.startedAt ?? Date.now(),
      planned: { kind: run.kind, factIds, ...(decision.catchId === undefined ? {} : { catchId: decision.catchId }) },
      // Re-asking a confirmation or offer whose answer could not be read keeps that gate live (#68).
      ...(decision.gateReask === true ? { gateReask: true } : {}),
    };
    // `done` settles when the step is over, so a line waiting for the floor (or `settled()`) really waits for it.
    turn.done = new Promise<void>((resolve) => {
      turn.release = resolve;
    });
    // One voice at a time: a line already playing (a scripted cue, or the previous step) finishes first (#66).
    await this.waitForFloor(abort.signal);
    if (abort.signal.aborted || this.closed) return { reason: 'cancelled while another line was playing' };
    this.turn = turn;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    abort.signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking', canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
    const player = this.playAll(turn, queue);

    let reply = '';
    let failure: unknown;
    let timeoutReason: string | undefined;
    let timeoutFailure: 'firstSentenceTimeout' | undefined;
    const firstChunkMs = this.options.briefFirstChunkMs ?? DEFAULT_BRIEF_FIRST_CHUNK_MS;
    const completionMs = DEFAULT_OPENING_COMPLETION_MS;
    const DEADLINE = Symbol('deadline');
    const STOPPED = Symbol('stopped');
    let reachDeadline: (() => void) | undefined;
    const deadline = new Promise<void>((resolve) => {
      reachDeadline = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const clearFirstChunkTimer = (): void => {
      if (firstChunkTimer !== undefined) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = undefined;
      }
    };
    const clearCompletionTimer = (): void => {
      if (completionTimer !== undefined) {
        clearTimeout(completionTimer);
        completionTimer = undefined;
      }
    };
    if (firstChunkMs > 0) {
      firstChunkTimer = setTimeout(() => {
        firstChunkTimer = undefined;
        if (abort.signal.aborted) return;
        timeoutReason ??= `the first sentence did not arrive within ${firstChunkMs} ms`;
        timeoutFailure ??= 'firstSentenceTimeout';
        reachDeadline?.();
        abort.abort();
      }, firstChunkMs);
      firstChunkTimer.unref?.();
    }
    completionTimer = setTimeout(() => {
      completionTimer = undefined;
      if (abort.signal.aborted) return;
      timeoutReason ??= `the line did not finish within ${completionMs} ms`;
      reachDeadline?.();
      abort.abort();
    }, completionMs);
    completionTimer.unref?.();
    try {
      const stream = prefetched !== undefined
        ? this.openingPrefetchedStream(prefetched)
        : useFallback && this.ports.fallbackStream !== undefined
          ? this.ports.fallbackStream(messages, abort.signal)
          : this.ports.stream(messages, abort.signal);
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const raced = await Promise.race([iterator.next(), deadline.then(() => DEADLINE), stopped.then(() => STOPPED)]);
        if (typeof raced === 'symbol') break;
        if (raced.done === true) break;
        if (abort.signal.aborted) break;
        reply += raced.value;
        if (/[.!?]["')\]]*(?:\s|$)/.test(reply)) clearFirstChunkTimer();
      }
      if (!abort.signal.aborted) turn.streamFinished = true;
    } catch (error) {
      if (prefetched?.failure !== undefined) {
        failure = prefetched.failure;
        timeoutFailure = prefetched.failureKind;
      } else if (!abort.signal.aborted) failure = error;
    } finally {
      clearFirstChunkTimer();
      clearCompletionTimer();
    }

    if (run.cancelled || turn.aborted) {
      queue.close();
      await player;
      this.finishPlannedStep(turn);
      return { reason: run.cancelled ? 'the line was cancelled' : 'the line was interrupted' };
    }
    // A prefetched stream can be aborted by its own completion deadline just before the race is read;
    // that is a failed step, never a partial line to accept.
    if (failure === undefined && prefetched?.failure !== undefined) {
      failure = prefetched.failure;
      timeoutFailure = prefetched.failureKind;
    }
    if (failure === undefined && timeoutReason === undefined && abort.signal.aborted) {
      timeoutReason = 'the line was cut off before it finished';
    }
    if (failure !== undefined || timeoutReason !== undefined) {
      queue.close();
      await player;
      this.finishPlannedStep(turn);
      return {
        reason: timeoutReason ?? (failure instanceof Error ? failure.message : String(failure)),
        ...(timeoutFailure === undefined ? {} : { failure: timeoutFailure }),
      };
    }
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === run.title);
    const purpose = decision.purpose === 'invite'
      ? 'invite'
      : run.kind === 'opening' ? 'brief' : (decision.purpose as 'answer' | 'catch' | 'clarify' | 'defer');
    const parsed = parsePlannedReply(reply, {
      expectedSpeaker: decision.speaker,
      names: this.names,
      guestName: this.human?.name,
      purpose,
      topicTitle: item?.title ?? run.title,
    });
    if (!parsed.ok) {
      queue.close();
      await player;
      this.finishPlannedStep(turn);
      return { reason: parsed.reason };
    }
    const keptSentences = parsed.sentences.filter((sentence) => {
      const dropped = run.kind === 'reply'
        ? this.plannedOwnershipDrop(sentence, decision.speaker)
        : undefined;
      if (dropped !== undefined) {
        this.ports.log?.(dropped);
        return false;
      }
      return true;
    });
    const text = keptSentences.join(' ').trim();
    if (keptSentences.length === 0) {
      queue.close();
      await player;
      this.finishPlannedStep(turn);
      return { reason: 'every sentence gave the visitor\'s follow-up away' };
    }
    if (decision.purpose === 'brief' || (run.kind === 'reply' && decision.purpose === 'answer' && factIds.length > 0)) {
      const missing = factIds
        .map((id) => view.facts.find((fact) => fact.id === id))
        .find((fact) => fact !== undefined &&
          !(run.kind === 'reply' && decision.purpose === 'answer' && fact.told) &&
          !carriesFact(text, fact.text));
      if (missing !== undefined) {
        queue.close();
        await player;
        this.finishPlannedStep(turn);
        return { reason: `did not carry the fact "${missing.text.slice(0, 80)}"` };
      }
    }
    if (run.kind === 'reply' && decision.purpose === 'catch' && decision.catchId !== undefined) {
      const catchText = view.catches.find((entry) => entry.id === decision.catchId)?.text;
      if (catchText !== undefined && !carriesCatch(text, catchText)) {
        queue.close();
        await player;
        this.finishPlannedStep(turn);
        return { reason: `did not carry the catch "${catchText.slice(0, 80)}"` };
      }
    }

    if (run.kind === 'reply') {
      const control = this.controlFromReply(reply);
      if (control !== undefined) {
        let moveBack: Utterance | undefined;
        const applied = this.applyReplyControl(turn, control,
          previous !== undefined && previous.speaker === this.human?.name ? previous.text : undefined,
          (line) => {
            moveBack = line;
          });
        if (applied.refuseSpeech) {
          if (moveBack !== undefined) this.announce(moveBack.speaker, moveBack.text);
          queue.close();
          await player;
          // This reply is over: the host has said the move-back line, and nothing is retried.
          run.cancelled = true;
          this.finishPlannedStep(turn);
          return { reason: 'the reply tried to reopen a topic that was already reopened' };
        }
      }
    }

    const utterances: Utterance[] = keptSentences.map((sentence) => ({ speaker: decision.speaker, text: sentence }));
    if (utterances.length === 0) {
      queue.close();
      await player;
      this.finishPlannedStep(turn);
      return { reason: 'no speakable line' };
    }
    const question = utterances
      .map((utterance) => this.questionFrom(utterance))
      .find((candidate) => candidate !== undefined);
    // The reply's purpose is the reply generation's judgement: only a step written to answer the open
    // question closes it. A reaction, catch or clarification that happens to end without a question does not.
    const openQuestion = view.openQuestion;
    const answersQuestion = openQuestion !== undefined &&
      decision.speaker === openQuestion.to &&
      decision.respondsTo === openQuestion.eventId &&
      (decision.purpose === 'answer' || decision.purpose === 'brief');
    turn.planned = {
      kind: run.kind,
      factIds,
      lastUtterance: utterances.at(-1),
      text,
      ...(decision.catchId === undefined ? {} : { catchId: decision.catchId }),
      ...(question === undefined ? {} : { question }),
      ...(answersQuestion ? { answersQuestion: true } : {}),
    };
    for (const utterance of utterances) {
      turn.enqueued.push(utterance);
      queue.push({ utterance, clip: this.synthesizeWithRetry(utterance, abort.signal) });
    }
    // Start the next speaker while this line plays; it is used only if this line is fully heard and the epoch holds.
    this.startPlannedPrefetch(run, decision, text, factIds);
    queue.close();
    await player;
    if (turn.control !== undefined && turn.topic !== undefined && turn.spoken.length > 0) {
      this.memory.invented(this.reopenedTitle ?? turn.topic, turn.control.newFacts ?? []);
    }
    if (run.kind === 'reply' && turn.spoken.length > 0) this.scheduleDeferredFollowUp(turn);
    const complete = !turn.aborted && !run.cancelled &&
      turn.spoken.length === utterances.length && turn.spoken.every((entry) => entry.complete);
    if (!complete) this.clearOpeningPrefetch('the line before it was not fully heard');
    const eventId = turn.planned.eventId;
    const line = complete && eventId !== undefined
      ? this.meetingState.view(Date.now()).lines.find((candidate) => candidate.eventId === eventId)
      : undefined;
    this.finishPlannedStep(turn);
    if (line === undefined) {
      return { reason: turn.aborted || run.cancelled ? 'the line was interrupted' : 'the line was not fully heard' };
    }
    return { line };
  }

  private finishPlannedStep(turn: Turn): void {
    if (this.turn === turn) this.turn = undefined;
    this.finalize(turn);
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
    turn.release?.();
  }

  private openingMessages(
    decision: SpeakDecision,
    previous: HeardLine | undefined,
    view: ReturnType<MeetingState['view']>,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === view.topic) ??
      this.options.scenario.agenda.find((candidate) => candidate.title === this.currentItem()?.title);
    const facts = (decision.factIds ?? [])
      .map((id) => view.facts.find((fact) => fact.id === id)?.text)
      .filter((text): text is string => text !== undefined);
    if (decision.purpose === 'brief' && facts.length === 0) return [];
    return openingSpeakerMessages({
      scenario: this.options.scenario,
      speaker: decision.speaker,
      human: this.human,
      topicTitle: item?.title ?? view.topic ?? 'this topic',
      purpose: decision.purpose === 'invite' ? 'invite' : 'brief',
      facts,
      decision: item?.decision,
      previous: previous === undefined ? undefined : { speaker: previous.speaker, text: previous.text },
    });
  }

  private replyMessages(
    run: OpeningRun,
    decision: SpeakDecision,
    previous: HeardLine | undefined,
    view: ReturnType<MeetingState['view']>,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    if (decision.purpose !== 'answer' && decision.purpose !== 'catch' && decision.purpose !== 'clarify' && decision.purpose !== 'defer') return [];
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === view.topic) ??
      this.options.scenario.agenda.find((candidate) => candidate.title === run.title);
    const facts = (decision.factIds ?? [])
      .map((id) => view.facts.find((fact) => fact.id === id)?.text)
      .filter((text): text is string => text !== undefined);
    const catchText = decision.catchId === undefined
      ? undefined
      : view.catches.find((entry) => entry.id === decision.catchId)?.text;
    const respondsTo = (decision.respondsTo === undefined
      ? previous
      : view.lines.find((line) => line.eventId === decision.respondsTo) ?? previous);
    if (respondsTo === undefined) return [];
    return replySpeakerMessages({
      scenario: this.options.scenario,
      speaker: decision.speaker,
      human: this.human,
      topicTitle: item?.title ?? view.topic ?? run.title,
      decision: item?.decision,
      purpose: decision.purpose,
      ...(decision.purpose === 'defer' && view.deadline !== undefined ? { laterSlot: view.deadline } : {}),
      transcript: view.lines
        .filter((line) => line.complete)
        .slice(-8)
        .map((line) => ({ speaker: line.speaker, text: line.text })),
      respondsTo: { speaker: respondsTo.speaker, text: respondsTo.text },
      facts,
      ...(catchText === undefined ? {} : { catchText }),
      ...(decision.clarifyNote === undefined ? {} : { clarifyNote: decision.clarifyNote }),
      asksControl: previous !== undefined && previous.speaker === this.human?.name,
    });
  }

  /** The hidden control line at the start of a reply, if the model sent one. */
  private controlFromReply(reply: string): ReplyControl | undefined {
    for (const raw of reply.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (!isReplyControlLine(line)) return undefined;
      return parseReplyControl(line, (message) => this.ports.log?.(message)) ?? OPEN_REPLY_CONTROL;
    }
    return undefined;
  }

  /** The log line for a planned sentence that gives the visitor's follow-up to a colleague or the host. */
  private plannedOwnershipDrop(sentence: string, speaker: string): string | undefined {
    const aiHost = (this.options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    if (aiHost !== undefined && speaker === aiHost &&
        this.currentTopicHasVisitorFollowUp() && !namesColleague(sentence, this.names) &&
        (HOST_SEND_PLACE_RE.test(sentence) ||
          (HOST_SEND_INSTRUCTION_RE.test(sentence) &&
            (HOST_IMPERATIVE_START_RE.test(sentence) || addressesVisitor(sentence, this.human?.name))))) {
      return `[card] dropped host send-instruction: ${sentence}`;
    }
    if (this.human !== undefined &&
        claimsStepGivenToOther(sentence, speaker, this.guestLinesByTopic.get(this.currentItem()?.title) ?? [], this.names)) {
      return `[owner] ${speaker}: dropped a sentence that claims a step the visitor gave someone else: "${sentence}"`;
    }
    if (this.human !== undefined) {
      const addressed = addressedShareTarget(sentence, this.names);
      if (addressed !== undefined || MODEL_SHARE_TAKEOVER_RE.test(sentence)) {
        const owner = addressed ?? speaker;
        if (!this.askedByGuestOnTopic(owner)) {
          return `[owner] ${speaker}: dropped a sentence that gives the visitor's follow-up to a colleague: "${sentence}"`;
        }
      }
    }
    return undefined;
  }

  /** While line N plays, write line N+1 from N's text and a projected view; the real ledger decides later. */
  private startPlannedPrefetch(run: OpeningRun, decision: SpeakDecision, text: string, factIds: readonly string[]): void {
    if (this.closed || this.paused || run.cancelled) return;
    if (run.kind === 'opening' && decision.purpose !== 'brief') return;
    if (run.kind === 'reply' &&
        decision.purpose !== 'answer' && decision.purpose !== 'catch' && decision.purpose !== 'clarify') return;
    if (this.openingPrefetch !== undefined) return;
    const view = run.kind === 'reply'
      ? this.replyPlanView(run, this.meetingState.view(Date.now()))
      : this.meetingState.view(Date.now());
    const synthetic: HeardLine = {
      eventId: `${run.kind}-projection-${run.epoch}-${this.shadowLineSeq}`,
      speaker: decision.speaker,
      text,
      at: Date.now(),
      complete: true,
      proposal: false,
      ...(decision.catchId === undefined ? {} : { catchId: decision.catchId }),
      catch: decision.purpose === 'catch',
    };
    const projected = projectHeard(view, synthetic, factIds);
    const next = nextPlannerDecision(projected, { kind: 'heard', line: synthetic });
    const allowed = run.kind === 'opening'
      ? next.kind === 'Speak' && (next.purpose === 'brief' || next.purpose === 'invite')
      : next.kind === 'Speak' && (next.purpose === 'answer' || next.purpose === 'catch' || next.purpose === 'clarify');
    if (next.kind !== 'Speak' || !allowed) return;
    if (next.speaker === this.human?.name || !this.names.includes(next.speaker)) return;
    const messages = run.kind === 'opening'
      ? this.openingMessages(next, { ...synthetic }, projected)
      : this.replyMessages(run, next, { ...synthetic }, projected);
    if (messages.length === 0) return;
    const prefetched: PrefetchedOpening = {
      kind: run.kind,
      epoch: run.epoch,
      expected: { speaker: next.speaker, purpose: next.purpose, factIds: next.factIds ?? [], ...(next.catchId === undefined ? {} : { catchId: next.catchId }) },
      controller: new AbortController(),
      chunks: [],
      done: false,
      startedAt: Date.now(),
    };
    this.openingPrefetch = prefetched;
    this.ports.log?.(`[${run.kind}] asking early for ${next.speaker} (${next.purpose}) while ${decision.speaker} speaks`);
    void this.pumpOpeningPrefetch(prefetched, messages);
  }

  private takeOpeningPrefetch(decision: SpeakDecision): PrefetchedOpening | undefined {
    const prefetched = this.openingPrefetch;
    if (prefetched === undefined) return undefined;
    this.openingPrefetch = undefined;
    const expectedIds = decision.factIds ?? [];
    const same = prefetched.epoch === this.openingEpoch &&
      prefetched.expected.speaker === decision.speaker &&
      prefetched.expected.purpose === decision.purpose &&
      prefetched.expected.factIds.length === expectedIds.length &&
      prefetched.expected.factIds.every((id, index) => id === expectedIds[index]) &&
      prefetched.expected.catchId === decision.catchId;
    if (!same || prefetched.controller.signal.aborted) {
      this.ports.log?.(
        `[${prefetched.kind}] discarded the early request for ${prefetched.expected.speaker}: ` +
        `${prefetched.controller.signal.aborted ? 'it was aborted or timed out' : 'the plan changed'}`,
      );
      if (prefetched.firstChunkTimer !== undefined) clearTimeout(prefetched.firstChunkTimer);
      if (prefetched.completionTimer !== undefined) clearTimeout(prefetched.completionTimer);
      if (!prefetched.done) prefetched.controller.abort();
      return undefined;
    }
    return prefetched;
  }

  private clearOpeningPrefetch(reason?: string): void {
    const prefetched = this.openingPrefetch;
    if (prefetched === undefined) return;
    this.openingPrefetch = undefined;
    if (prefetched.firstChunkTimer !== undefined) {
      clearTimeout(prefetched.firstChunkTimer);
      prefetched.firstChunkTimer = undefined;
    }
    if (prefetched.completionTimer !== undefined) {
      clearTimeout(prefetched.completionTimer);
      prefetched.completionTimer = undefined;
    }
    if (!prefetched.done) {
      this.ports.log?.(`[${prefetched.kind}] dropped the early request for ${prefetched.expected.speaker}${reason === undefined ? '' : `: ${reason}`}`);
      prefetched.controller.abort();
    }
  }

  private clearUpcomingOpeningPrefetch(reason?: string): void {
    const prefetched = this.upcomingOpeningPrefetch;
    if (prefetched === undefined) return;
    this.upcomingOpeningPrefetch = undefined;
    if (prefetched.firstChunkTimer !== undefined) {
      clearTimeout(prefetched.firstChunkTimer);
      prefetched.firstChunkTimer = undefined;
    }
    if (prefetched.completionTimer !== undefined) {
      clearTimeout(prefetched.completionTimer);
      prefetched.completionTimer = undefined;
    }
    if (!prefetched.done) {
      this.ports.log?.(`[${prefetched.kind}] dropped the next topic request${reason === undefined ? '' : `: ${reason}`}`);
      prefetched.controller.abort();
    }
  }

  private async pumpOpeningPrefetch(prefetched: PrefetchedOpening, messages: ChatMessage[]): Promise<void> {
    const firstChunkMs = this.options.briefFirstChunkMs ?? DEFAULT_BRIEF_FIRST_CHUNK_MS;
    const completionMs = DEFAULT_OPENING_COMPLETION_MS;
    const DEADLINE = Symbol('deadline');
    const STOPPED = Symbol('stopped');
    let reachDeadline: (() => void) | undefined;
    const deadline = new Promise<void>((resolve) => {
      reachDeadline = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      if (prefetched.controller.signal.aborted) resolve();
      else prefetched.controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const fail = (message: string, kind?: 'firstSentenceTimeout'): void => {
      if (prefetched.done || prefetched.controller.signal.aborted) return;
      prefetched.failure = new Error(message);
      prefetched.failureKind ??= kind;
      this.ports.log?.(`[${prefetched.kind}] the early request for ${prefetched.expected.speaker} timed out: ${message}`);
      prefetched.controller.abort();
      prefetched.done = true;
      reachDeadline?.();
      prefetched.wake?.();
      prefetched.wake = undefined;
    };
    const clearFirstChunkTimer = (): void => {
      if (prefetched.firstChunkTimer !== undefined) {
        clearTimeout(prefetched.firstChunkTimer);
        prefetched.firstChunkTimer = undefined;
      }
    };
    const clearCompletionTimer = (): void => {
      if (prefetched.completionTimer !== undefined) {
        clearTimeout(prefetched.completionTimer);
        prefetched.completionTimer = undefined;
      }
    };
    if (firstChunkMs > 0) {
      prefetched.firstChunkTimer = setTimeout(() => {
        prefetched.firstChunkTimer = undefined;
        fail(`the first spoken sentence did not arrive within ${firstChunkMs} ms`, 'firstSentenceTimeout');
      }, firstChunkMs);
      prefetched.firstChunkTimer.unref?.();
    }
    prefetched.completionTimer = setTimeout(() => {
      prefetched.completionTimer = undefined;
      fail(`the opening line did not finish within ${completionMs} ms`);
    }, completionMs);
    prefetched.completionTimer.unref?.();
    const iterator = this.ports.stream(messages, prefetched.controller.signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const raced = await Promise.race([
          iterator.next(),
          deadline.then(() => DEADLINE),
          stopped.then(() => STOPPED),
        ]);
        if (typeof raced === 'symbol') break;
        if (raced.done === true) break;
        prefetched.chunks.push(raced.value);
        const speech = prefetched.chunks.join('').replace(/^\s*KAKI_CONTROL[^\n]*\n?/i, '');
        if (/[.!?]["')\]]*(?:\s|$)/.test(speech)) clearFirstChunkTimer();
        prefetched.wake?.();
        prefetched.wake = undefined;
      }
    } catch (error) {
      if (!prefetched.controller.signal.aborted && prefetched.failure === undefined) {
        prefetched.failure = error;
        this.ports.log?.(`[${prefetched.kind}] the early request for ${prefetched.expected.speaker} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearFirstChunkTimer();
      clearCompletionTimer();
      prefetched.done = true;
      prefetched.wake?.();
      prefetched.wake = undefined;
    }
  }

  private openingPrefetchedStream(prefetched: PrefetchedOpening): AsyncIterable<string> {
    return {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        for (;;) {
          if (index < prefetched.chunks.length) {
            yield prefetched.chunks[index++]!;
            continue;
          }
          if (prefetched.failure !== undefined) throw prefetched.failure;
          if (prefetched.done) return;
          await new Promise<void>((resolve) => (prefetched.wake = resolve));
        }
      },
    };
  }

  /** The guest spoke, the topic changed, or the meeting stopped: no more opening lines, including the prefetched one. */
  private cancelOpening(reason: string, interruptCurrent = true): void {
    const run = this.openingRun;
    this.clearOpeningPrefetch(reason);
    if (run === undefined || run.cancelled) return;
    run.cancelled = true;
    this.openingEpoch += 1;
    this.ports.log?.(`[opening] cancelled: ${reason}`);
    if (interruptCurrent && this.turn !== undefined && this.turn.planned?.kind === 'opening') {
      this.interrupt('the opening was cancelled');
    }
    if (this.openingRun === run) this.openingRun = undefined;
  }

  /** The guest's gathered lines as one turn for the planner; the ledger itself keeps each line. */
  private guestTurnFor(view: MeetingView, ids: ReadonlySet<string>): OpeningRun['guestTurn'] {
    const guest = this.human?.name;
    if (guest === undefined || ids.size === 0) return undefined;
    const gathered = view.lines.filter((line) =>
      line.complete && line.speaker === guest && ids.has(line.eventId));
    if (gathered.length === 0) return undefined;
    const last = gathered.at(-1)!;
    const reading = mergeReadings(gathered.flatMap((line) => line.reading === undefined ? [] : [line.reading]));
    return {
      ids,
      line: {
        eventId: last.eventId,
        speaker: guest,
        text: gathered.map((line) => line.text).join(' ').trim(),
        at: last.at,
        complete: true,
        proposal: gathered.some((line) => line.reading?.kind === 'idea' || line.proposal),
        catch: false,
        ...(reading === undefined ? {} : { reading }),
      },
    };
  }

  /** Replace the guest lines gathered for this response with one turn, so the planner sees one idea, not fragments. */
  private replyPlanView(run: OpeningRun, view: MeetingView): MeetingView {
    const scope = run.guestTurn;
    if (scope === undefined) return view;
    const lines: HeardLine[] = [];
    let placed = false;
    for (const line of view.lines) {
      if (scope.ids.has(line.eventId)) {
        if (!placed) {
          lines.push(scope.line);
          placed = true;
        }
        continue;
      }
      lines.push(line);
    }
    if (!placed) return view;
    const firstIsMerged = (view.guestFirstIdea !== undefined && scope.ids.has(view.guestFirstIdea.eventId)) ||
      (view.guestFirstIdea === undefined && scope.line.proposal);
    return {
      ...view,
      lines,
      lastHeard: view.lastHeard !== undefined && scope.ids.has(view.lastHeard.eventId)
        ? scope.line
        : view.lastHeard,
      lastLine: view.lastLine !== undefined && scope.ids.has(view.lastLine.eventId)
        ? scope.line
        : view.lastLine,
      guestFirstIdea: firstIsMerged ? scope.line : view.guestFirstIdea,
      guestLastLine: view.guestLastLine !== undefined && scope.ids.has(view.guestLastLine.eventId)
        ? scope.line
        : view.guestLastLine,
    };
  }

  /** Answer the guest's latest line with one planned speaker per model call, replanning after each heard line. */
  private startReplyRun(guestTurn?: OpeningRun['guestTurn'], from?: HeardLine, heldText?: string): void {
    if (this.closed || this.paused || this.human === undefined) return;
    if (this.replyRun !== undefined) return;
    const pendingText = this.pending.some((text) => !text.startsWith('['))
      ? this.pending.filter((text) => !text.startsWith('[')).join(' ').trim()
      : heldText;
    this.pending = [];
    const gatheredIds = new Set(this.pendingGuestLineIds);
    this.pendingGuestLineIds = [];
    if (pendingText !== undefined && pendingText.length > 0) {
      this.ports.log?.(`[reply] answering "${pendingText}"`);
      this.interrupt('a new reply started');
      this.unanswered = false;
      this.cutOff = false;
      this.lastText = pendingText;
      this.history.push({ role: 'user', content: pendingText });
    }
    const view = this.meetingState.view(Date.now());
    this.openingEpoch += 1;
    const run: OpeningRun = {
      title: this.currentItem()?.title ?? '',
      kind: 'reply',
      epoch: this.openingEpoch,
      cancelled: false,
      ...(guestTurn === undefined ? {} : { guestTurn }),
    };
    if (run.guestTurn === undefined) {
      const scope = this.guestTurnFor(view, gatheredIds);
      if (scope !== undefined) run.guestTurn = scope;
    }
    const planView = this.replyPlanView(run, view);
    // A line held over an AI line finishes after that AI line was heard; the reply still starts from the guest's
    // own gathered line, not from the colleague line that happened to finish after it.
    const previous = from ?? run.guestTurn?.line ?? planView.lastHeard;
    if (previous === undefined || planView.guestLastLine === undefined) return;
    this.replyRun = run;
    void this.readThenRunReply(run, previous, gatheredIds).catch((error: unknown) => {
      this.ports.log?.(`[reply] failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.replyRun === run) this.replyRun = undefined;
      this.clearOpeningPrefetch('the reply failed');
    });
  }

  /** Read every gathered guest line before planning, so the planner works from meaning and not from words. */
  private async readThenRunReply(
    run: OpeningRun,
    previous: HeardLine,
    ids: ReadonlySet<string>,
  ): Promise<void> {
    await this.readGuestTurn(run, ids);
    if (run.cancelled || this.closed || this.paused) {
      this.finishReplyRun(run);
      return;
    }
    // Once the call is made, "let's move on" is the guest closing the review, not parking an open topic.
    const title = this.currentItem()?.title;
    if (title !== undefined && this.humanSettledOnCurrentItem && !this.advanced.has(title)) {
      const readings = this.meetingState.view(Date.now()).readings.filter((entry) => ids.has(entry.eventId));
      if (readings.at(-1)?.reading.kind === 'park') {
        this.ports.log?.(`[topic] "${title}" is already decided; the guest asked to move on, so the meeting moves on`);
        this.finishReplyRun(run);
        this.checkTopicAdvance(true);
        return;
      }
    }
    await this.runReply(run, previous);
  }

  /** One reader call per finished guest line, recorded against its heard event. */
  private async readGuestTurn(run: OpeningRun, ids: ReadonlySet<string>): Promise<void> {
    const guest = this.human?.name;
    if (guest === undefined || ids.size === 0) return;
    for (const id of ids) {
      await this.readingJob(id);
      if (run.cancelled || this.closed || this.paused) return;
    }
    if (run.guestTurn !== undefined) {
      const refreshed = this.guestTurnFor(this.meetingState.view(Date.now()), ids);
      if (refreshed !== undefined) run.guestTurn = refreshed;
    }
  }

  private readerInput(view: MeetingView, line: HeardLine): GuestReaderInput {
    const guest = this.human?.name ?? '';
    const openOffer = view.confirmationAsked && view.confirmationCall !== undefined
      ? { proposal: view.confirmationSpoken ?? view.confirmationCall }
      : view.offerAsked && view.offer !== undefined
        ? (view.offer.spoken === undefined ? view.offer : { proposal: view.offer.spoken })
        : undefined;
    // The view after the guest line no longer shows the question the guest was answering, so use the one
    // captured before it was recorded.
    const context = this.guestLineContext.get(line.eventId);
    const saidWhileSpeaking = context?.saidWhileSpeaking;
    const openQuestion = context === undefined ? view.openQuestion : context.openQuestion;
    return {
      topic: {
        title: view.topic ?? '',
        ...(view.decision === undefined ? {} : { decision: view.decision }),
        canWait: view.canWait,
        deadline: view.deadline ?? 'soon',
      },
      guest,
      ...(openQuestion === undefined
        ? {}
        : { openQuestion: { from: openQuestion.from, to: openQuestion.to, text: openQuestion.text } }),
      guestLines: view.lines
        .filter((entry) => entry.complete && entry.speaker === guest)
        .map((entry) => entry.text),
      colleagues: view.present
        .filter((name) => name !== guest)
        .map((name) => ({
          name,
          facts: view.facts.filter((fact) => fact.knownBy.includes(name)).map((fact) => ({ id: fact.id, text: fact.text })),
          catches: view.catches.filter((entry) => entry.attendee === name).map((entry) => ({ id: entry.id, idea: entry.idea, text: entry.text })),
        })),
      recentHeard: view.lines.filter((entry) => entry.complete).slice(-6).map((entry) => ({ speaker: entry.speaker, text: entry.text })),
      ...(openOffer === undefined ? {} : { offer: openOffer }),
      ...(saidWhileSpeaking === undefined ? {} : { saidWhileSpeaking }),
      line: line.text,
    };
  }

  private readerPorts(): GuestReaderPorts {
    const fallback = this.ports.readerFallbackStream ?? this.ports.fallbackStream;
    return {
      stream: (messages, signal) => (this.ports.readerStream ?? this.ports.stream)(messages, signal),
      ...(fallback === undefined
        ? {}
        : { fallbackStream: (messages: ChatMessage[], signal: AbortSignal) => fallback(messages, signal) }),
      ...(this.ports.log === undefined ? {} : { log: (message: string) => this.ports.log?.(message) }),
      ...(this.options.readerTimeoutMs === undefined ? {} : { firstOutputTimeoutMs: this.options.readerTimeoutMs }),
    };
  }

  private async readOneGuestLine(view: MeetingView, line: HeardLine): Promise<GuestReading> {
    const input = this.readerInput(view, line);
    const ports = this.readerPorts();
    const read = (): Promise<GuestReading> => this.options.readGuestLine === undefined
      ? readGuestLine(input, ports)
      : this.options.readGuestLine(input, ports);
    const reading = await read();
    // The answer to a confirmation or offer decides the topic: one slow read must not lose it (#68).
    if (reading.failed === true && (view.confirmationAsked || view.offerAsked) && !this.closed) {
      this.ports.log?.('[reader] the read failed while Sam waits for an answer; reading the line once more');
      return read();
    }
    return reading;
  }

  private async runReply(run: OpeningRun, first: HeardLine): Promise<void> {
    let previous = first;
    for (;;) {
      if (run.cancelled || this.closed || this.paused) {
        this.finishReplyRun(run);
        return;
      }
      const view = this.replyPlanView(run, this.meetingState.view(Date.now()));
      const reading = previous.reading ??
        view.readings.find((entry) => entry.eventId === previous.eventId)?.reading;
      const decision = nextPlannerDecision(view, {
        kind: 'heard', line: previous, ...(reading === undefined ? {} : { reading }),
      });
      if (decision.kind === 'ConfirmDecision') {
        this.ports.log?.(`[confirm] ${decision.reason}`);
        this.askConfirmation(view);
        this.finishReplyRun(run);
        return;
      }
      if (decision.kind === 'Offer') {
        this.ports.log?.(`[offer] ${decision.reason}`);
        this.askOffer(view, decision);
        this.finishReplyRun(run);
        return;
      }
      if (decision.kind === 'CommitDecision') {
        this.ports.log?.(`[confirm] ${decision.reason}`);
        this.commitConfirmedDecision(decision, previous, reading);
        this.finishReplyRun(run);
        return;
      }
      if (decision.kind === 'Unresolved') {
        this.ports.log?.(`[topic] ${decision.reason}`);
        this.resolveUnresolved(decision.reason);
        this.finishReplyRun(run);
        return;
      }
      if (decision.kind === 'Wait') {
        if (decision.allowedSilence !== true && previous.complete && previous.speaker === this.human?.name) {
          this.ports.log?.(`[planner] no reply to guest: ${decision.reason}`);
        }
        this.ports.log?.(`[reply] ended: ${describeDecision(decision)} (${decision.reason})`);
        this.finishReplyRun(run);
        return;
      }
      const isReply = decision.kind === 'Speak' &&
        (decision.purpose === 'answer' || decision.purpose === 'catch' || decision.purpose === 'clarify' ||
          decision.purpose === 'defer');
      if (!isReply || decision.speaker === this.human?.name || !this.names.includes(decision.speaker)) {
        this.ports.log?.(`[reply] ended: ${describeDecision(decision)} (${decision.reason})`);
        this.finishReplyRun(run);
        return;
      }
      this.ports.log?.(
        `[reply] ${decision.speaker} (${decision.purpose}) asked; responding to "${(previous.text ?? '').slice(0, 60)}"`,
      );
      if (decision.followUp === true) {
        this.ports.log?.(`[followup] ${decision.speaker} asks ${this.human?.name ?? 'the guest'} for a missing decision detail`);
      }
      if (decision.whichOne === true) this.reaskingWhichOne = true;
      const heard = await this.plannedStepWithRetry(run, decision, previous);
      this.reaskingWhichOne = false;
      if (run.cancelled) {
        this.finishReplyRun(run);
        return;
      }
      if (decision.purpose === 'defer') {
        // The defer line was heard, cut off or could not be written: either way the topic is parked and the
        // meeting moves on through the same terminal transition as any other closed topic.
        if (this.closed || this.paused) {
          this.finishReplyRun(run);
          return;
        }
        if (run.title.length > 0) {
          this.parkedTopics.add(run.title);
          this.ports.log?.(`[topic] "${run.title}" deferred to its later slot`);
          this.closeTopicTurn(`the topic "${run.title}" was deferred`);
          this.meetingState.clearOpenQuestion();
        }
        this.finishReplyRun(run);
        this.advanceOrEnd();
        return;
      }
      if (heard === undefined) {
        if (this.closed || this.paused) {
          this.finishReplyRun(run);
          return;
        }
        this.ports.log?.(`[reply] ${decision.speaker} (${decision.purpose}) could not be heard; ending this reply`);
        this.finishReplyRun(run);
        this.recoverFromFailedReply(decision.gateReask === true);
        return;
      }
      if (decision.whichOne === true) this.meetingState.noteWhichOneAsked();
      if (decision.followUp === true) this.meetingState.noteFollowUp();
      previous = heard;
    }
  }

  private offerChoices(view: MeetingView): string[] {
    return view.directions.slice(0, 2).map(plainDirection).filter((choice) => choice.length > 0);
  }

  /** A call written so it fits after "we": no trailing stop and no leading capital. */
  private plainCall(text: string): string {
    const plain = plainDirection(text);
    return plain.length === 0 ? plain : `${plain[0]!.toLowerCase()}${plain.slice(1)}`;
  }

  /** The exact offer line for an offer already put to the guest, so a silence re-ask repeats it. */
  private offerAskLine(guest: string, offer: MeetingView['offer']): string {
    if (offer?.spoken !== undefined) return offer.spoken;
    if (offer?.openAsk === true) return `${guest}, what would you rather do?`;
    if (offer?.proposal !== undefined) return `How about we ${this.plainCall(offer.proposal)}?`;
    const choices = offer?.choices ?? [];
    if (choices.length >= 1) return `How about we ${this.plainCall(choices[0]!)}?`;
    return `${guest}, shall we make the smallest call you can live with now?`;
  }

  /** The live offer Sam should re-ask after silence instead of a generic nudge. */
  private liveGateReask(): { line: string; gate: 'offer' } | undefined {
    const guest = this.human?.name;
    if (guest === undefined) return undefined;
    const view = this.meetingState.view(Date.now());
    if (view.offerAsked && view.offer !== undefined) {
      return { line: this.offerAskLine(guest, view.offer), gate: 'offer' };
    }
    return undefined;
  }

  /** Stop the gate being written or waiting to speak, so a closed topic never hears it. */
  private clearPendingGate(abort?: AbortController): void {
    const pending = this.pendingGate;
    if (pending === undefined || (abort !== undefined && pending.abort !== abort)) return;
    pending.abort.abort();
    this.pendingGate = undefined;
  }

  /** Write one gate line with the model; a failed, timed-out or badly shaped line falls back to plain speech. */
  private async writeGateLine(request: GateSpeakerRequest, signal: AbortSignal): Promise<string | undefined> {
    const timeoutMs = this.options.briefFirstChunkMs ?? DEFAULT_BRIEF_FIRST_CHUNK_MS;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    let reply = '';
    try {
      const stream = this.options.gateStream !== undefined
        ? this.options.gateStream(request, controller.signal)
        : this.ports.stream(gateSpeakerMessages(request), controller.signal);
      for await (const chunk of stream) reply += chunk;
    } catch {
      // The fallback below needs no model at all.
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
    if (timedOut || signal.aborted) return undefined;
    const parsed = parseGateReply(reply, {
      speaker: request.speaker,
      ...(request.human === undefined ? {} : { guestName: request.human.name }),
    });
    if (!parsed.ok) {
      this.ports.log?.(`[gate] no usable ${request.purpose} line: ${parsed.reason}`);
      return undefined;
    }
    return parsed.text;
  }

  private standingCallLines(view: MeetingView): string[] {
    const ids = standingCallEventIds(view);
    return view.lines.filter((line) => line.complete && ids.has(line.eventId)).map((line) => line.text);
  }

  private gateGuestLines(view: MeetingView): string[] {
    return view.lines
      .filter((line) => line.complete && line.speaker === this.human?.name)
      .map((line) => line.text)
      .slice(-6);
  }

  /** Sam proposes ONE concrete call in plain spoken words and asks the guest to agree. */
  private askOffer(view: MeetingView, offer?: OfferDecision): boolean {
    const host = this.facilitatorOrCoHost();
    const guest = this.human?.name;
    const title = this.currentItem()?.title;
    if (host === undefined || guest === undefined || !this.names.includes(host) || title === undefined) return false;
    if (view.offerAsked) {
      this.ports.log?.('[offer] an offer is already live; not offering again');
      return true;
    }
    if (this.pendingGate?.title === title) {
      this.ports.log?.(`[offer] a ${this.pendingGate.kind} is already queued or speaking; not offering again`);
      return true;
    }
    if (view.confirmationAsked) {
      this.ports.log?.('[offer] a confirmation is already live; not offering a call');
      return true;
    }
    const fresh = this.meetingState.view(Date.now());
    if (view.offers >= MAX_OFFERS || fresh.offers >= MAX_OFFERS) {
      this.ports.log?.('[offer] two offers have already been made; closing the topic honestly instead of offering again');
      this.resolveUnresolved('two offers have already been made and the guest did not choose a call');
      return false;
    }
    const choices = offer?.choices === undefined ? this.offerChoices(view) : [...offer.choices];
    const proposal = offer?.proposal ?? (choices.length === 0
      ? undefined
      : choices[Math.min(view.offers, choices.length - 1)]);
    const put = proposal === undefined ? { openAsk: true as const } : { proposal };
    const fallback = proposal === undefined
      ? `${guest}, what would you rather do?`
      : `How about we ${this.plainCall(proposal)}?`;
    const item = this.currentItem();
    const request: GateSpeakerRequest = {
      scenario: this.options.scenario,
      speaker: host,
      human: this.human,
      topicTitle: item?.title ?? title,
      purpose: 'offer',
      guestLines: this.gateGuestLines(view),
      call: proposal ?? 'the smallest call you can live with now',
      ...(view.lastHeard === undefined ? {} : {
        previous: { speaker: view.lastHeard.speaker, text: view.lastHeard.text },
      }),
    };
    const abort = new AbortController();
    this.pendingGate = { title, kind: 'offer', abort };
    this.meetingState.setConfirmationAsked(false);
    this.ports.log?.(`[offer] asking ${guest} to choose${proposal === undefined ? '' : `: "${proposal}"`}`);
    const speak = (line: string): void => {
      if (abort.signal.aborted || this.pendingGate?.abort !== abort) {
        this.ports.log?.('[offer] dropped an offer whose gate was cancelled');
        return;
      }
      if (this.closed || this.paused || this.currentItem()?.title !== title) {
        this.clearPendingGate(abort);
        return;
      }
      this.ports.log?.(`[offer] spoken: ${line}`);
      this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        this.clearPendingGate(abort);
        if (!spoken) {
          this.ports.log?.('[offer] the offer was not fully heard; the topic clock will close it honestly if no answer comes');
          return;
        }
        this.meetingState.noteOffer();
        this.meetingState.setOfferAsked(true, { ...put, spoken: line });
      }, () => this.pendingGate?.abort === abort && !abort.signal.aborted);
    };
    if (proposal === undefined) {
      speak(fallback);
      return true;
    }
    void this.writeGateLine(request, abort.signal).then((written) => speak(written ?? fallback));
    return true;
  }

  /** Sam restates the guest's own call in plain words and asks whether that is the call. */
  private askConfirmation(view: MeetingView, retry = true): boolean {
    const host = this.facilitatorOrCoHost();
    const guest = this.human?.name;
    const title = this.currentItem()?.title;
    if (host === undefined || guest === undefined || !this.names.includes(host) || title === undefined) return false;
    if (view.confirmationAsked) {
      this.ports.log?.('[confirm] a confirmation is already live; not asking again');
      return true;
    }
    if (this.pendingGate?.title === title) {
      this.ports.log?.(`[confirm] a ${this.pendingGate.kind} is already queued or speaking; not asking again`);
      return true;
    }
    const evidence = mergedReadiness(view).action.evidence;
    const item = this.currentItem();
    const fallback = `${guest}, is that your call?`;
    const abort = new AbortController();
    this.pendingGate = { title, kind: 'confirmation', abort };
    const speak = (line: string): void => {
      if (abort.signal.aborted || this.pendingGate?.abort !== abort) {
        this.ports.log?.('[confirm] dropped a read-back whose gate was cancelled');
        return;
      }
      if (this.closed || this.paused || this.currentItem()?.title !== title) {
        this.clearPendingGate(abort);
        return;
      }
      this.ports.log?.(`[confirm] read-back: ${line}`);
      this.ports.log?.(`[confirm] asking ${guest} to confirm${evidence === undefined ? '' : `: "${evidence}"`}`);
      this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        this.clearPendingGate(abort);
        if (!spoken) {
          this.ports.log?.('[confirm] the confirmation was not fully heard; it will be asked again, not counted');
          if (!retry || this.closed || this.paused || this.currentItem()?.title !== title ||
              this.humanSettledOnCurrentItem) return;
          const delay = Math.max(this.speakerGapMs, 500);
          setTimeout(() => {
            if (this.closed || this.paused || this.currentItem()?.title !== title || this.humanSettledOnCurrentItem) return;
            const fresh = this.meetingState.view(Date.now());
            if (fresh.confirmationAsked || !readinessMet(fresh)) return;
            this.askConfirmation(fresh, false);
          }, delay).unref();
          return;
        }
        this.meetingState.setOfferAsked(false);
        this.meetingState.setConfirmationAsked(true, evidence, line);
        this.confirmationNudged = false;
        // The read-back now owns the room's next move: silence after it must be nudged and then committed.
        this.scheduleSilencePrompt();
      }, () => this.pendingGate?.abort === abort && !abort.signal.aborted);
    };
    if (evidence === undefined) {
      speak(fallback);
      return true;
    }
    const request: GateSpeakerRequest = {
      scenario: this.options.scenario,
      speaker: host,
      human: this.human,
      topicTitle: item?.title ?? title,
      purpose: 'readback',
      // Only the lines that make up the standing call: a line that added nothing to it is not read back.
      guestLines: this.standingCallLines(view),
      call: evidence,
      ...(view.lastHeard === undefined ? {} : {
        previous: { speaker: view.lastHeard.speaker, text: view.lastHeard.text },
      }),
    };
    void this.writeGateLine(request, abort.signal).then((written) => speak(written ?? fallback));
    return true;
  }

  /**
   * The guest has already given a workable call and no gate is live: the next move is the read-back, never a
   * free model check-in. Called whenever a reply or responder chain ends, so a line that arrived mid-reply still
   * gets its confirmation once the room is quiet.
   */
  private askReadBackWhenReady(): boolean {
    if (!this.readinessApplies() || this.humanSettledOnCurrentItem || this.decisionWrappedUpOnItem) return false;
    const title = this.currentItem()?.title;
    if (title === undefined || this.advanced.has(title)) return false;
    const view = this.meetingState.view(Date.now());
    if (view.confirmationAsked || view.offerAsked || !readinessMet(view)) return false;
    if (this.pendingGate?.title === title) return false;
    this.ports.log?.('[confirm] the reply chain has ended with readiness met; asking for the read-back');
    return this.askConfirmation(view);
  }

  /** No answer after the one nudge: the call Sam read back is the guest's own call, so commit it and move on. */
  private commitReadBackOnSilence(view: MeetingView): void {
    const call = view.confirmationCall ?? mergedReadiness(view).action.evidence;
    const guest = this.human?.name;
    if (call === undefined || guest === undefined) {
      this.ports.log?.('[confirm] no answer after the nudge, but no read-back call to commit');
      this.resolveUnresolved('the read-back had no call to commit after silence');
      return;
    }
    this.ports.log?.('[confirm] no answer after nudge; committing the read-back call');
    const line: HeardLine = {
      eventId: `silence-confirm-${Date.now()}`,
      speaker: guest,
      text: call,
      at: Date.now(),
      complete: true,
      proposal: false,
      catch: false,
    };
    this.commitConfirmedDecision({
      kind: 'CommitDecision',
      reason: 'the guest did not answer the read-back after one nudge; their own call stands',
      respondsTo: line.eventId,
      call,
    }, line, undefined);
  }

  /** The guest agreed to one specific call: commit exactly that call through the normal task-store path. */
  private commitConfirmedDecision(
    decision: Extract<PlannerDecision, { kind: 'CommitDecision' }>,
    guestLine: HeardLine,
    reading: GuestReading | undefined,
  ): void {
    this.meetingState.setConfirmationAsked(false);
    this.meetingState.setOfferAsked(false);
    const lines = [decision.call];
    const addedDetail = (reading?.kind === 'idea' || reading?.kind === 'answer') &&
      guestLine.text.trim().toLowerCase().replace(/\s+/g, ' ') !==
      decision.call.trim().toLowerCase().replace(/\s+/g, ' ');
    if (addedDetail) lines.push(guestLine.text);
    this.decisionLines = lines;
    this.lockDecision(undefined, { confirmed: true });
  }

  private finishReplyRun(run: OpeningRun): void {
    if (this.replyRun !== run) return;
    this.replyRun = undefined;
    this.clearOpeningPrefetch('the reply finished');
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
    if (this.closed || this.concluded || this.paused) return;
    if (this.hasHeldGuestLine()) {
      this.scheduleRespond();
      return;
    }
    if (this.budgetRecoveryPending && !this.humanSettledOnCurrentItem) {
      this.budgetRecoveryPending = false;
      this.offerBudgetLock();
      return;
    }
    if (this.askReadBackWhenReady()) return;
    if (this.maybeBrief()) return;
    this.scheduleSilencePrompt();
  }

  /** Both writes for one reply failed: say honestly that the room is still working on it, not that it missed the guest. */
  private recoverFromFailedReply(gateReask = false): void {
    if (this.closed || this.concluded || this.paused || this.recoveryCueSpoken) return;
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return;
    this.recoveryCueSpoken = true;
    if (gateReask) {
      // The lost line was a re-ask of a live confirmation or offer: say that question again in its scripted form,
      // and keep the gate live while it is heard (#68).
      const view = this.meetingState.view(Date.now());
      const line = (view.confirmationAsked ? view.confirmationSpoken : undefined) ?? this.liveGateReask()?.line ??
        'Sorry, give me a second on that.';
      this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, () => this.scheduleSilencePrompt(), undefined, { gateReask: true });
      return;
    }
    this.announce(host, 'Sorry, give me a second on that.', DEFAULT_ANNOUNCE_GIVE_UP_MS, () => this.scheduleSilencePrompt());
  }

  /** The guest spoke again, the topic changed, or the meeting stopped: no more reply lines, including the prefetched one. */
  private cancelReplyRun(reason: string, interruptCurrent = true): void {
    const run = this.replyRun;
    this.clearOpeningPrefetch(reason);
    if (run === undefined || run.cancelled) return;
    run.cancelled = true;
    this.openingEpoch += 1;
    this.ports.log?.(`[reply] cancelled: ${reason}`);
    if (interruptCurrent && this.turn !== undefined && this.turn.planned?.kind === 'reply') {
      this.interrupt('the reply was cancelled');
    }
    if (this.replyRun === run) this.replyRun = undefined;
  }

  /** Fetch the next topic's first opening speaker while the host winds the current topic down. */
  private startUpcomingOpeningPrefetch(title: string): void {
    if (this.closed || this.paused || this.human === undefined) return;
    const existing = this.upcomingOpeningPrefetch;
    if (existing?.title === title && !existing.controller.signal.aborted) return;
    this.clearUpcomingOpeningPrefetch('the next topic changed');
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === title);
    if (item === undefined) return;
    const topics = this.options.scenario.agenda.map(meetingTopic);
    const host = (this.options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    const temp = new MeetingState({ topics, present: this.names, host, guest: this.human.name });
    temp.openTopic(title, Date.now());
    const visitor = this.visitorSeat();
    const handover = liveNextItemLine(this.options.scenario, title, visitor, true, (line) => this.ports.log?.(line));
    const synthetic: HeardLine = {
      eventId: `upcoming-${title}`,
      speaker: this.facilitatorOrCoHost() ?? this.names[0]!,
      text: handover,
      at: Date.now(),
      complete: true,
      proposal: false,
      catch: false,
    };
    const decision = nextPlannerDecision(temp.view(Date.now()), { kind: 'heard', line: synthetic });
    if (decision.kind !== 'Speak' || (decision.purpose !== 'brief' && decision.purpose !== 'invite')) return;
    if (decision.speaker === this.human.name || !this.names.includes(decision.speaker)) return;
    const messages = this.openingMessages(decision, synthetic, temp.view(Date.now()));
    if (messages.length === 0) return;
    const prefetched: PrefetchedOpening = {
      kind: 'opening',
      title,
      epoch: this.openingEpoch + 1,
      expected: { speaker: decision.speaker, purpose: decision.purpose, factIds: decision.factIds ?? [], ...(decision.catchId === undefined ? {} : { catchId: decision.catchId }) },
      controller: new AbortController(),
      chunks: [],
      done: false,
      startedAt: Date.now(),
    };
    this.upcomingOpeningPrefetch = prefetched;
    this.ports.log?.(`[opening] asking early for ${decision.speaker} (${decision.purpose}) on the next topic "${title}"`);
    void this.pumpOpeningPrefetch(prefetched, messages);
  }

  private visitorSeat(): { name: string; seat: string } | undefined {
    const human = this.human;
    if (human === undefined) return undefined;
    const role = this.options.scenario.roles.find((candidate) =>
      candidate.id === human.role);
    const seat = this.options.scenario.attendees.find((attendee) => attendee.role === role?.id)?.name;
    return seat === undefined ? undefined : { name: human.name, seat };
  }

  /**
   * Gentle silence handling when the room is waiting on the person (`decide` or `involve` mode):
   * - Stage 1: After `silencePromptMs`, the AI host gently checks in with the person by name and invites them to share a thought or ask a question.
   * - Stage 2: If the person stays silent again, the topic's owner says one short spoken sentence that helps them get unstuck — one thing that matters, or one smaller question, never a menu and never the answer.
   */
  private scheduleSilencePrompt(): void {
    const item = this.currentItem();
    const title = item?.title;
    const host = this.facilitatorOrCoHost();
    if (
      this.closed ||
      this.paused ||
      this.openingRun !== undefined ||
      this.human === undefined ||
      host === undefined ||
      title === undefined ||
      this.pendingBrief === title ||
      this.mode() === 'observe' ||
      this.decisionWrappedUpOnItem
    ) {
      return;
    }
    // A workable call that has not been read back yet outranks any free model check-in.
    if (this.askReadBackWhenReady()) return;
    this.clearSilenceTimer();
    const linesBefore = this.humanLines;
    const stageAtSchedule = this.silencePromptStage;
    const endedWithQuestion = /\?["')\]]*$/.test(this.lastSpoken.trim());
    const shouldBridgeStatement =
      !endedWithQuestion &&
      !this.bridgedStatementOnTurn &&
      stageAtSchedule === 0 &&
      this.deferredFollowUpTimer === undefined &&
      !this.decisionWrappedUpOnItem &&
      !this.humanSettledOnCurrentItem &&
      this.humanLines - this.linesAtMove <= 1;
    const baseMs = this.options.silencePromptMs ?? DEFAULT_SILENCE_PROMPT_MS;
    // Write the first nudge early, then hold it until the visitor should hear it. Tests with a small
    // silencePromptMs start the write at once and still hear it at that moment.
    const leadMs = Math.min(baseMs, this.options.silenceNudgeLeadMs ?? DEFAULT_SILENCE_NUDGE_LEAD_MS);
    const delayMs = shouldBridgeStatement ? Math.min(baseMs, 10_000) : Math.max(0, baseMs - leadMs);
    const scheduledAt = Date.now();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      if (
        this.closed ||
        this.paused ||
        this.openingRun !== undefined ||
        this.human === undefined ||
        this.currentItem()?.title !== title ||
        this.humanLines > linesBefore ||
        this.silencePromptStage !== stageAtSchedule
      ) {
        return;
      }
      if (this.pendingBrief === title) return;
      // A check-in after a real silence starts a new round of conversation.
      this.askedGuestInRound = false;
      if (
        this.humanTalking ||
        this.recognizingSpeech ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0 ||
        // A read-back or offer being written owns the room's next move; its own end schedules the silence check.
        this.pendingGate !== undefined
      ) {
        this.scheduleSilencePrompt();
        return;
      }
      // A live read-back gets one fixed nudge, then its own call stands and the meeting moves on.
      const confirmView = this.meetingState.view(Date.now());
      if (confirmView.confirmationAsked) {
        if (!this.confirmationNudged) {
          this.confirmationNudged = true;
          this.ports.log?.('[confirm] no answer to the read-back; asking "Still with me?" once');
          this.announce(host, 'Still with me?', DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
            if (!spoken) this.ports.log?.('[confirm] the nudge was not heard; the read-back stays live');
            this.scheduleSilencePrompt();
          }, undefined, { gateReask: true });
          return;
        }
        this.commitReadBackOnSilence(confirmView);
        return;
      }
      if (this.silencePromptStage >= 2) return;
      // A live offer is re-asked as that same question, so the gate stays the last thing heard.
      // It counts as this stage of the silence escalation, so the existing cap still stops it looping.
      const gateReask = this.liveGateReask();
      if (gateReask !== undefined) {
        this.silencePromptStage = stageAtSchedule + 1;
        this.ports.log?.(`[silence] re-asking the live ${gateReask.gate} instead of a generic nudge`);
        this.announce(host, gateReask.line, DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
          if (!spoken) this.ports.log?.(`[silence] the ${gateReask.gate} re-ask was not heard; the gate stays live`);
          this.scheduleSilencePrompt();
        }, undefined, { gateReask: true });
        return;
      }
      if (shouldBridgeStatement) {
        this.bridgedStatementOnTurn = true;
        const npcs = this.options.scenario.npcs ?? [];
        const spokenTitle = cleanSpokenTopic(title);
        if (npcs.length > 1) {
          this.forcedSpeaker = { target: host, from: host };
          this.pending.push(
            `[${this.human.name} just heard the team's answer on "${spokenTitle}", and the colleague finished on a statement without passing the floor. Begin your reply with "${host}:". ${host} steps in as the meeting chair in ONE short, natural spoken sentence connecting what was just said back to the decision and asking ${this.human.name} by name (ending with a question mark "?") how they want to play this or if they want to lock a direction in — never prescribe an answer, use only facts and names already heard, add no new open item, task, person or number, never mention a card or screen, never volunteer to do the work yourself, and never mention this note.]`,
          );
          this.startTurn(false, false, undefined, undefined, true);
          return;
        }
      }
      this.silencePromptStage = stageAtSchedule + 1;
      if (this.silencePromptStage === 1) {
        const npcs = this.options.scenario.npcs ?? [];
        const others = this.names.filter((name) => name !== host);
        const owner =
          others.find((name) => this.options.scenario.attendees.find((a) => a.name === name)?.role === item?.ownerRole) ??
          others[0];
        const spokenTitle = cleanSpokenTopic(title);
        if (owner !== undefined && npcs.length > 1) {
          this.forcedSpeaker = { target: host, from: host };
          this.pending.push(silenceCheckInNote(host, this.human.name, spokenTitle, this.humanSettledOnCurrentItem));
          this.startTurn(false, false, scheduledAt + baseMs, undefined, true);
        } else {
          this.announce(
            host,
            silenceCheckInLine(this.human.name, spokenAgendaName(this.options.scenario, title), this.topicIndex(title)),
            DEFAULT_ANNOUNCE_GIVE_UP_MS,
            () => this.scheduleSilencePrompt(),
          );
        }
      } else if (this.silencePromptStage === 2) {
        const npcs = this.options.scenario.npcs ?? [];
        const others = this.names.filter((name) => name !== host);
        const owner =
          others.find((name) => this.options.scenario.attendees.find((a) => a.name === name)?.role === item?.ownerRole) ??
          others[0] ??
          this.names[0];
        if (owner !== undefined && npcs.length > 1) {
          this.forcedSpeaker = { target: owner, from: host };
          this.pending.push(silenceColleagueNote(owner, this.human.name, title, item?.decision));
          this.startTurn(false, false, undefined, undefined, true);
        }
      }
    }, delayMs).unref();
  }

  /** A character handed over to another by name and nobody has answered yet: the named one answers, after a short pause. */
  private scheduleFollowUp(from: string, target: string): void {
    if (this.closed || this.paused || this.chain >= MAX_FOLLOW_UPS) return;
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.paused || this.humanTalking || this.pending.length > 0 || this.turn !== undefined) return;
      this.chain += 1;
      this.ports.log?.(`${from} handed over to ${target}: ${target} answers`);
      this.forcedSpeaker = { target, from };
      this.pending = [`[${from} handed over to ${target}. Begin your reply with "${target}:". ${target} answers now for their own side, briefly, and nobody else speaks.]`];
      this.startTurn();
    }, this.speakerGapMs);
  }

  private startTurn(
    retry = false,
    recoveryRetry = false,
    notBefore?: number,
    dispatchCue?: DispatchCue,
    nudge = false,
  ): void {
    if (this.closed || this.paused) return;
    const text = retry ? this.lastText : this.pending.join(' ').trim();
    this.pending = [];
    this.pendingGuestLineIds = [];
    if (text.length === 0) return;
    this.ports.log?.(`[respond] asking the model${retry ? ' (retry)' : ''}`);
    this.interrupt('a new turn started');
    const forced = this.forcedSpeaker;
    this.forcedSpeaker = undefined;
    this.unanswered = false;
    this.cutOff = false;
    this.lastText = text;

    // On a retry the question is already in the history.
    let note: ChatMessage | undefined;
    if (retry) {
      this.ports.log?.(
        recoveryRetry
          ? 'retrying the same request after the model said nothing'
          : 'answering again: the last answer was cancelled before anything was said',
      );
    } else {
      note = { role: 'user', content: text };
      this.history.push(note);
    }

    const abort = new AbortController();
    const turn: Turn = {
      topic: this.currentItem()?.title,
      abort,
      soundAbort: this.linkedSound(abort),
      spoken: [],
      enqueued: [],
      streamFinished: false,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      ...(notBefore === undefined ? {} : { notBefore }),
      ...(nudge ? { nudge: true } : {}),
      ...(nudge && note !== undefined ? { nudgeNote: note } : {}),
      forced,
      dispatchCue,
      recoveryRetry,
    };
    this.turn = turn;
    turn.done = this.runTurn(turn).catch((error: unknown) => {
      this.ports.log?.(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private startReplayTurn(utterances: Utterance[]): void {
    const abort = new AbortController();
    const turn: Turn = {
      abort,
      soundAbort: this.linkedSound(abort),
      spoken: [],
      enqueued: [...utterances],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      replay: true,
    };
    this.turn = turn;
    turn.done = this.runReplayTurn(turn, utterances).catch((error: unknown) => {
      this.ports.log?.(`replay turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async runReplayTurn(turn: Turn, utterances: Utterance[]): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking', canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
    const player = this.playAll(turn, queue);
    for (const utterance of utterances) {
      const clip = this.synthesizeWithRetry(utterance, signal);
      queue.push({ utterance, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    if (this.maybeBrief()) return;
    const handedTo = findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name);
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (turn.spoken.length > 0) {
      this.scheduleSilencePrompt();
    }
    this.ports.emitState(this.idleState());
  }

  private startScripted(
    utterance: Utterance,
    onDone?: (spoken: boolean) => void,
    endsOnCutoff = false,
    gateReask = false,
    lockOffer = false,
  ): void {
    const abort = new AbortController();
    const turn: Turn = {
      abort,
      soundAbort: this.linkedSound(abort),
      spoken: [],
      enqueued: [],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      scripted: true,
      gateReask,
      ...(lockOffer ? { lockOffer } : {}),
      scriptedUtterance: utterance,
      onScriptedDone: onDone,
      ...(endsOnCutoff ? { endsOnCutoff } : {}),
    };
    this.turn = turn;
    turn.done = this.runScripted(turn, utterance)
      .then(() => {
        if (!turn.aborted) onDone?.(true);
        else if (!this.closed && !this.paused && turn.onScriptedDone !== undefined) turn.onScriptedDone(false);
      })
      .catch((error: unknown) => {
        this.ports.log?.(`cue failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async runScripted(turn: Turn, utterance: Utterance): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking', canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
    const player = this.playAll(turn, queue);
    const sentences = splitSentences(utterance.text);
    for (const sentence of sentences) {
      const item: Utterance = { speaker: utterance.speaker, text: sentence };
      const clip = this.synthesizeWithRetry(item, signal);
      queue.push({ utterance: item, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
    if (this.hasHeldGuestLine()) {
      this.scheduleRespond();
      return;
    }
    if (this.maybeBrief()) return;
    if (this.lastSpoken.trim().endsWith('?') && turn.onScriptedDone === undefined) this.scheduleSilencePrompt();
  }

  /** Carry on from where the person cut in without saying anything. */
  private resume(): void {
    let speaker = this.cutOffSpeaker;
    const held = this.turn !== undefined && this.turn.held === true ? this.turn : undefined;
    if (held !== undefined) {
      const remaining = this.heldLineCount(held);
      const streamLive = held.streamFinished !== true && held.streamFailed !== true;
      // A held turn with lines still to hear (or a stream still writing them) carries on by itself.
      // A stream that failed, or that ended with nothing left, falls back to asking the model, as before.
      if (streamLive || (held.streamFailed !== true && remaining > 0)) {
        this.ports.log?.('cut-in had no words: carrying on held lines');
        this.cutOff = false;
        this.cutOffSpeaker = undefined;
        this.resumeHeldTurn(held);
        return;
      }
      speaker = held.spoken.at(-1)?.utterance.speaker ?? speaker;
      this.ports.log?.(held.streamFailed === true
        ? 'the held reply failed: asking the model to carry on'
        : 'the held reply had nothing left: asking the model to carry on');
      this.abandonHeldTurn(held);
    }
    this.cutOff = false;
    this.cutOffSpeaker = undefined;
    const scripted = this.pausedScripted;
    this.pausedScripted = undefined;
    if (scripted !== undefined) {
      if (scripted.utterance.text.length === 0) {
        this.ports.log?.('the person cut in but said nothing recognisable: scripted cue had finished');
        scripted.onDone?.(true);
        this.maybeBrief();
      } else {
        this.ports.log?.('the person cut in but said nothing recognisable: carrying on unspoken scripted cue');
        this.startScripted(scripted.utterance, scripted.onDone);
      }
      return;
    }
    const who = this.human?.name ?? 'The person';
    const speakerHint =
      speaker !== undefined ? ` Begin your reply with "${speaker}:" so ${speaker} finishes their thought first.` : '';
    if (speaker !== undefined) this.forcedSpeaker = { target: speaker, from: speaker };
    this.ports.log?.('the person cut in but said nothing recognisable: carrying on');
    this.lastText = `[${who} made a sound but said nothing. Carry on from where you were cut off, briefly, without mentioning it.${speakerHint}]`;
    this.history.push({ role: 'user', content: this.lastText });
    this.startTurn(true);
  }

  /** Stop the current turn, if any, and keep in the history only what was heard of it. */
  private interrupt(reason: string): void {
    const turn = this.turn;
    if (turn === undefined || turn.finalized) return;
    const soundOnly = reason === 'the person started talking' || reason === 'the person kept talking';
    const mic = soundOnly ? this.ports.describeMic?.() : undefined;
    this.ports.log?.(`interrupted: ${reason}${mic === undefined ? '' : ` (${mic})`}`);
    // Before an opening line's first sound there is nothing to hold: the opening run retries the step itself,
    // so this must not become an ordinary "unanswered" retry that competes with it.
    const openingBeforeAudio = turn.planned !== undefined && turn.spoken.length === 0;
    if (openingBeforeAudio) {
      this.clearOpeningPrefetch('a wordless cut-in during the opening');
      this.unanswered = false;
      this.cutOff = false;
      this.cutOffSpeaker = undefined;
    }
    // Sound alone (an echo, a cough, a noise) cannot be told from a voice. A model turn that has already
    // been heard is paused rather than thrown away, so its unsaid lines can carry on if no words follow.
    if (soundOnly && turn.scripted !== true && turn.spoken.length > 0) {
      this.holdTurn(turn);
      return;
    }
    if (turn.scripted === true) {
      if (soundOnly && turn.scriptedUtterance !== undefined) {
        if (turn.endsOnCutoff === true) {
          // A closing line that is cut off still ends its topic; do not wait for playback to settle.
          const done = turn.onScriptedDone;
          turn.onScriptedDone = undefined;
          done?.(false);
        } else {
          const remaining = this.scriptedRemainder(turn);
          this.cutOff = true;
          this.pausedScripted = {
            utterance: { speaker: turn.scriptedUtterance.speaker, text: remaining },
            onDone: turn.onScriptedDone,
          };
          turn.onScriptedDone = undefined;
        }
      }
    } else {
      if (turn.spoken.length === 0) {
        if (!openingBeforeAudio) this.unanswered = true;
      } else if (soundOnly) {
        this.cutOff = true;
        this.cutOffSpeaker = turn.spoken.at(-1)?.utterance.speaker;
      }
    }
    turn.aborted = true;
    turn.held = false;
    this.emitCutTranscript(turn);
    const wake = turn.heldWake;
    turn.heldWake = undefined;
    wake?.();
    this.finalize(turn);
    this.turn = undefined;
    turn.abort.abort();
    turn.soundAbort.abort();
    this.gate.setAiAudible(false);
    // The visitor heard the room accept their decision before the reply was cut short: it still counts.
    this.ports.emitState(this.idleState());
  }

  /** How many of this turn's accepted lines the room has not finished hearing. */
  private heldLineCount(turn: Turn): number {
    const completed = turn.spoken.filter((entry) => entry.complete).length;
    return Math.max(0, turn.enqueued.length - completed);
  }

  /** A sound-only cut-in: stop the sound now, but keep the model stream and its unsaid lines for a wordless resume. */
  private holdTurn(turn: Turn): void {
    if (this.isTurnHeld(turn)) return;
    turn.held = true;
    turn.soundAbort.abort();
    this.cutOff = true;
    this.cutOffSpeaker = turn.spoken.at(-1)?.utterance.speaker;
    this.ports.log?.(`held ${this.heldLineCount(turn)} unsaid lines`);
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
  }

  /** The person said nothing recognisable: play the held lines on the same turn, with no new model call. */
  private resumeHeldTurn(turn: Turn): void {
    if (turn !== this.turn || turn.finalized) return;
    turn.held = false;
    turn.soundAbort = this.linkedSound(turn.abort);
    const wake = turn.heldWake;
    turn.heldWake = undefined;
    wake?.();
  }

  /** Drop a held turn, keeping in the history only what was heard, so the meeting can carry on another way. */
  private abandonHeldTurn(turn: Turn): void {
    if (turn !== this.turn || turn.finalized) return;
    turn.held = false;
    turn.aborted = true;
    const wake = turn.heldWake;
    turn.heldWake = undefined;
    wake?.();
    this.finalize(turn);
    this.turn = undefined;
    turn.abort.abort();
    turn.soundAbort.abort();
    this.gate.setAiAudible(false);
    this.finishDispatchCue(turn);
    this.ports.emitState(this.idleState());
  }

  /** Resolves when the playback loop's held turn carries on, or when the turn is finally aborted. */
  private waitWhileHeld(turn: Turn): Promise<void> {
    if (turn.held !== true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        turn.abort.signal.removeEventListener('abort', wake);
        if (turn.heldWake === wake) turn.heldWake = undefined;
        resolve();
      };
      turn.heldWake = wake;
      turn.abort.signal.addEventListener('abort', wake, { once: true });
    });
  }

  /** Whether the turn is paused by a sound-only cut-in (read through a method so a long await cannot hide a change). */
  private isTurnHeld(turn: Turn): boolean {
    return turn.held === true;
  }

  /** The signal that stops sound without ending the model call; it also dies when the whole turn is aborted. */
  private linkedSound(abort: AbortController): AbortController {
    const sound = new AbortController();
    if (abort.signal.aborted) sound.abort();
    else abort.signal.addEventListener('abort', () => sound.abort(), { once: true });
    return sound;
  }

  private scriptedRemainder(turn: Turn): string {
    const sentences = splitSentences(turn.scriptedUtterance?.text ?? '');
    const completed = turn.spoken.filter((entry) => entry.complete).length;
    const current = turn.spoken[completed];
    const remaining = current === undefined
      ? sentences.slice(completed)
      : [unspokenRemainder(current.utterance.text, Date.now() - current.startedAt, current.durationMs),
        ...sentences.slice(completed + 1)];
    return remaining.filter(Boolean).join(' ').trim();
  }

  /** Remind a colleague of a promised check without pretending a new lookup happened off-screen. */
  private scheduleDeferredFollowUp(turn: Turn): void {
    if (this.closed || this.concluded || this.paused || turn.topic !== this.currentItem()?.title) return;
    const DEFERRED_PROMISE_RE =
      /\b(?:get (?:right )?back to you|come back to you|check (?:kaki|the numbers|the figures|our records)|pull (?:up )?the (?:numbers|figures)|give me)\b[^.?!]*\b(?:in\s+(?:a|one|two|1|2)\s+(?:minutes?|moments?|seconds?)|(?:a|one|two|1|2)\s+(?:minutes?|moments?)|30\s+seconds?|shortly|right\s+back)\b|\b(?:in\s+(?:a|one|two|1|2)\s+(?:minutes?|moments?)|30\s+seconds?)\b[^.?!]*\b(?:get back|come back|share|update|have the (?:numbers|figures))\b/i;
    const promised = [...turn.spoken]
      .reverse()
      .find(({ utterance }) => DEFERRED_PROMISE_RE.test(utterance.text));
    if (promised === undefined) return;
    const speaker = promised.utterance.speaker;
    const promisedTopic = this.currentItem()?.title ?? 'the earlier item';
    const isTwoMin = /\b(?:two|2)\s+minutes\b/i.test(promised.utterance.text);
    const delayMs = isTwoMin ? 75_000 : 45_000;
    this.clearDeferredFollowUpTimer();
    this.ports.log?.(`scheduled real-time callback from ${speaker} in ${Math.round(delayMs / 1000)}s on "${promisedTopic}"`);
    const fire = (): void => {
      this.deferredFollowUpTimer = undefined;
      if (this.closed || this.concluded || this.currentItem()?.title !== promisedTopic) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.deferredFollowUpTimer = setTimeout(fire, 5_000);
        this.deferredFollowUpTimer.unref?.();
        return;
      }
      this.forcedSpeaker = { target: speaker, from: speaker };
      this.pending.push(
        `[A minute has passed since ${speaker} offered to check something on "${promisedTopic}". Begin with "${speaker}:". In ONE short sentence, answer only from established scenario or meeting facts. If the answer is not established, say you still need to check. Never claim a new call, lookup or conversation happened off-screen. Then stop. Do not mention this note.]`,
      );
      this.startTurn();
    };
    this.deferredFollowUpTimer = setTimeout(fire, delayMs);
    this.deferredFollowUpTimer.unref?.();
  }

  private finalize(turn: Turn): void {
    if (turn.finalized) return;
    turn.finalized = true;
    // Safety net: any line the shadow ledger still has open was cut off before it was fully heard.
    if (turn.planned !== undefined) {
      const complete = turn.spoken.length > 0 && turn.spoken.every((entry) => entry.complete) &&
        turn.spoken.length === turn.enqueued.length;
      this.endPlannedLine(turn, complete);
    } else {
      for (const entry of turn.spoken) this.shadowLineEnded(entry.shadowLineId, entry.complete);
    }

    const stripSelfIntro = (speaker: string, text: string): string => {
      const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleaned = text
        .replace(
          new RegExp(
            `^(?:(?:hey|hi|hello)\\s+[a-z]+,\\s*)?(?:and\\s+)?(?:(?:i'm|i am)\\s+${escaped}(?:\\s+here)?|${escaped}\\s+here|(?:i'm|i am)?\\s*${escaped}\\s+(?:from|on|in|your)\\s+[^,—–-]+)(?:\\s*[,—–-]\\s*[^,—–-]+(?:lead|director|manager)|\\s+(?:from|on|in|your)\\s+[^,—–-]+)?\\s*[,—–-]\\s*`,
            'i',
          ),
          '',
        )
        .trim();
      if (cleaned.length === 0) return text;
      return cleaned[0]!.toUpperCase() + cleaned.slice(1);
    };

    const lines = turn.spoken
      .filter(({ complete }) => complete || !this.paused || this.pausedUtterances === undefined)
      .map(({ utterance, complete }) => {
        const historyText = stripSelfIntro(utterance.speaker, utterance.text);
        return complete ? `${utterance.speaker}: ${historyText}` : `${utterance.speaker}: ${historyText} [cut off]`;
      });
    if (lines.length === 0) return;
    if (turn.aborted && (!this.paused || this.pausedUtterances === undefined)) {
      lines.push(`[${this.human?.name ?? 'The person'} interrupted here; nothing after this was said aloud.]`);
    }
    this.history.push({ role: 'assistant', content: lines.join('\n') });
    if (this.history.length > this.maxHistory * 2) this.history = this.history.slice(-this.maxHistory);
  }

  /**
   * Tell the dispatch cue's caller what happened. If nothing could be said (the model failed, wrote nothing
   * speakable, or every line was dropped), log it loudly and skip the ask; a template line is never used.
   */
  private finishDispatchCue(turn: Turn): void {
    const cue = turn.dispatchCue;
    if (cue === undefined || turn.cueDone === true) return;
    turn.cueDone = true;
    const spoken = turn.spoken.length > 0;
    if (!spoken) this.ports.log?.(`[dispatch] ${cue.what} could not be said; skipping it rather than reading a template`);
    cue.onDone?.(spoken);
  }

  /**
   * The model failed before any of its answer was heard. Retry the exact same turn once, so the
   * visitor's request still gets answered; if that retry fails too, say a natural cue asking them
   * to repeat it instead of showing the raw error. Nothing here creates a task or changes the agenda.
   */
  private recoverFromEmptyTurn(turn: Turn): boolean {
    if (this.closed || this.paused) return false;
    if (turn.recoveryRetry !== true) {
      this.ports.log?.('the model said nothing; retrying the same request once');
      if (turn.forced !== undefined) this.forcedSpeaker = turn.forced;
      this.startTurn(true, true);
      return true;
    }
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return false;
    if (this.recoveryCueSpoken) {
      // The models are still down: keep the meeting's own bounded silence prompts going, but
      // do not ask the visitor to repeat themselves again since they last spoke.
      this.ports.log?.('the model is still down; not repeating the recovery cue');
      this.scheduleSilencePrompt();
      return true;
    }
    const who = this.human?.name;
    // A typist did not "say" anything and nothing more is coming, so ask them to send it again.
    const line = this.lastHumanInputWasTyped
      ? who === undefined
        ? 'Sorry, I missed that one — could you send it again?'
        : `Sorry, ${who}, I missed that one — could you send it again?`
      : who === undefined
        ? 'Sorry, I lost you for a second there — could you say that again?'
        : `Sorry, ${who}, I lost you for a second there — could you say that again?`;
    this.recoveryCueSpoken = true;
    this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, () => this.scheduleSilencePrompt());
    return true;
  }

  /** Apply one model control line to the topic: settle, park, wingman, reactions, reopen. */
  private applyReplyControl(
    turn: Turn,
    control: ReplyControl,
    freshHumanLine: string | undefined,
    enqueueHostLine?: (utterance: Utterance) => void,
  ): { control: ReplyControl; refuseSpeech: boolean } {
    // A dispatch cue only asks or points; it must never settle or move the meeting.
    if (turn.dispatchCue !== undefined) {
      this.ports.log?.('[dispatch] ignored a control line in a task cue');
      return { control, refuseSpeech: false };
    }
    // The reply path decides settlement from the guest's checked reading, never from the writer's label.
    if (control.state !== 'open') {
      this.ports.log?.('[control] ignored model settle; readiness decides');
      control = { ...control, state: 'open' };
    }
    if (control.reopen !== undefined) {
      const agenda = this.options.scenario.agenda;
      const actualIndex = agenda.findIndex((candidate) => candidate.title === (this.agendaItem ?? agenda[0]?.title));
      const earlier = agenda.findIndex((candidate) => candidate.title === control.reopen);
      if (this.memory.wasReopened(control.reopen)) {
        this.ports.log?.(`[control] dropped reopen: ${control.reopen} was already reopened`);
        if (freshHumanLine !== undefined) this.decisionLines = this.decisionLines.filter((line) => line !== freshHumanLine);
        const host = this.facilitatorOrCoHost();
        if (host !== undefined) {
          const topicName = this.agendaItem === undefined ? 'this item' : spokenAgendaName(this.options.scenario, this.agendaItem);
          const line: Utterance = { speaker: host, text: `Let's keep going with ${topicName}.` };
          if (enqueueHostLine === undefined) this.ports.log?.(`[control] skipped the host's move-back line: ${line.text}`);
          else enqueueHostLine(line);
        }
        return { control, refuseSpeech: true };
      }
      if (this.concluded || earlier < 0 || earlier >= actualIndex ||
          !this.memory.snapshot().some((entry) => entry.kind === 'decision' && entry.item === control.reopen)) {
        this.ports.log?.('[control] dropped reopen: title is not an earlier decided item in this meeting');
      } else {
        this.resumeAfterReopen = { lines: this.decisionLines.filter((line) => line !== freshHumanLine),
          settled: this.humanSettledOnCurrentItem, wrapped: this.decisionWrappedUpOnItem };
        this.reopenedTitle = control.reopen;
        this.memory.markReopened(control.reopen);
        this.decisionLines = [];
        this.topicEpoch += 1;
        if (freshHumanLine !== undefined) this.noteDecisionLine(freshHumanLine);
        this.humanSettledOnCurrentItem = false;
      }
    }
    turn.control = control;
    const topic = turn.topic ?? this.currentItem()?.title;
    if (topic !== undefined) {
      if (control.state === 'deferred') this.parkedTopics.add(topic);
      else if (control.state === 'settled') this.parkedTopics.delete(topic);
    }
    const item = this.currentItem();
    if (control.wingmanNeeded) {
      this.wingmanHintActive = true;
      if (control.wingmanTip !== undefined && item !== undefined) {
        const agendaIndex = this.options.scenario.agenda.indexOf(item);
        this.ports.onWingmanTip?.(control.wingmanTip, item.title, agendaIndex);
      }
    }
    return { control, refuseSpeech: false };
  }

  private systemPrompt(
    alreadyAsked: boolean,
    includeKnows: boolean,
    agendaTitle = this.agendaItem,
    topic?: TopicPromptView,
  ): string {
    return buildSystemPrompt(
      this.options.scenario,
      this.human,
      agendaTitle,
      alreadyAsked,
      includeKnows,
      [...this.introduced],
      this.memory.snapshot(),
      this.reopenedTitle,
      this.memory.reopenedItems(),
      topic ?? this.currentTopicView(),
    );
  }

  /** What the room has said on the topic the meeting is on now, in the small form the prompt uses. */
  private currentTopicView(): TopicPromptView {
    this.startTopic(this.currentItem()?.title);
    return this.topicRecord.promptView();
  }

  private async runTurn(turn: Turn): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });

    // A nudge written early stays invisible: the room must not look busy while the visitor is still thinking.
    if (turn.notBefore === undefined) {
      this.ports.emitState({ kind: 'thinking', canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
    }
    const player = this.playAll(turn, queue);

    const handover = new HandoverGuard(this.names, this.human?.name);
    const aiHost = (this.options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    const SAFETY_REFUSAL_RE = /^(?:sorry,?\s*)?i\s+(?:cannot|can't)\s+(?:continue|engage|proceed|help)\s+(?:(?:with|in)\s+)?(?:this|the)\s+(?:conversation|role-?play|simulation|request)[.!]?$/i;
    let heldRefusal: Utterance | undefined;
    let failure: unknown;
    // The start of what the model sent, to name it in the log when none of it could be said.
    let received = '';
    let choseSilence = false;
    const enqueue = (utterance: Utterance, allowRefusal = false): void => {
      let trimmed = utterance.text
        .replace(/\s*\[(?:cut off|[^\]]*interrupted here[^\]]*)\]\s*/gi, ' ')
        .replace(/^(?:from|on)\s+the\s+(?:menu|floor|kitchen|tech|pos|marketing|operations|ops|store)\s+side,\s*/i, '')
        .trim();
      if (trimmed.length === 0) return;
      if (trimmed.includes(';')) {
        const before = trimmed;
        trimmed = splitSemicolons(trimmed);
        this.ports.log?.(`[speech] ${utterance.speaker}: split a semicolon into sentences: "${before}"`);
      }
      if (trimmed !== utterance.text.trim()) {
        trimmed = trimmed[0]!.toUpperCase() + trimmed.slice(1);
        utterance = { speaker: utterance.speaker, text: trimmed };
      }
      // A dispatch cue must not read the task title aloud: the room talks about the task in its own words.
      if (turn.dispatchCue?.shouldStillSpeak !== undefined && !turn.dispatchCue.shouldStillSpeak()) {
        this.ports.log?.(`[dispatch] skipped ${utterance.speaker}'s line: the task moved on`);
        return;
      }
      if (readsTaskTitle(trimmed, turn.dispatchCue?.forbiddenText)) {
        this.ports.log?.(`[dispatch] dropped ${utterance.speaker}'s line because it read the task title: "${trimmed}"`);
        return;
      }
      // A handover the model wrote as a bare name ("Daniel.") sounds like a stray word aloud.
      const bareName = /^([A-Z][\w'-]*)[.!]?$/.exec(trimmed)?.[1];
      if (bareName !== undefined && bareName !== utterance.speaker &&
          (this.names.includes(bareName) || bareName === this.human?.name)) {
        trimmed = `${bareName}, over to you.`;
        this.ports.log?.(`[handover] ${utterance.speaker}: turned a bare "${utterance.text.trim()}" into "${trimmed}"`);
        utterance = { speaker: utterance.speaker, text: trimmed };
      }
      if (this.introduced.has(utterance.speaker)) {
        const escaped = utterance.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const withoutRepeatIntro = trimmed
          .replace(
            new RegExp(
              `^(?:(?:hey|hi|hello)\\s+[a-z]+,\\s*)?(?:and\\s+)?(?:(?:i'm|i am)\\s+${escaped}(?:\\s+here)?|${escaped}\\s+here|(?:i'm|i am)?\\s*${escaped}\\s+(?:from|on|in|your)\\s+[^,—–-]+)(?:\\s*[,—–-]\\s*[^,—–-]+(?:lead|director|manager)|\\s+(?:from|on|in|your)\\s+[^,—–-]+)?\\s*[,—–-]\\s*`,
              'i',
            ),
            '',
          )
          .trim();
        if (withoutRepeatIntro.length > 0 && withoutRepeatIntro !== trimmed) {
          trimmed = withoutRepeatIntro[0]!.toUpperCase() + withoutRepeatIntro.slice(1);
          utterance = { speaker: utterance.speaker, text: trimmed };
        }
      }
      if (!allowRefusal && SAFETY_REFUSAL_RE.test(trimmed) && turn.enqueued.length === 0) {
        heldRefusal = utterance;
        return;
      }
      if (heldRefusal !== undefined) {
        const prior = heldRefusal;
        heldRefusal = undefined;
        enqueue(prior, true);
      }
      if (
        (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        isReplyControlLine(trimmed)
      ) {
        this.ports.log?.(`dropped ${utterance.speaker}'s meta/stage line: "${utterance.text}"`);
        return;
      }
      if (!handover.allow(utterance)) {
        this.ports.log?.(`dropped ${utterance.speaker}'s line after the handover: "${utterance.text}"`);
        return;
      }
      const repeated = namesColleague(trimmed, this.names) ? undefined : this.repeatsRecently(trimmed, turn.startedAt);
      if (repeated !== undefined) {
        this.ports.log?.(`[repeat] ${utterance.speaker}: dropped a sentence already said by ${repeated.speaker}: "${trimmed}"`);
        return;
      }
      if (isQuestionToVisitor(trimmed, utterance.speaker, this.names, this.human?.name) &&
          (this.askedGuestInRound || turn.enqueued.some((line) =>
            isQuestionToVisitor(line.text, line.speaker, this.names, this.human?.name)))) {
        // The prompt already asks for a question only when it is really needed, so this is a backstop:
        // warn rather than drop the colleague's question and leave their line half-said.
        this.ports.log?.(`[question] ${utterance.speaker}: a second question to the visitor this round: "${trimmed}"`);
      }
      if (aiHost !== undefined && utterance.speaker === aiHost && LOCK_ASK_RE.test(trimmed) &&
          Date.now() - this.lastLockAskAt < DEFAULT_REPEAT_WINDOW_MS) {
        this.ports.log?.(`[repeat] ${aiHost}: skipped a repeated lock-in ask`);
        return;
      }
      if (MODEL_CARD_MENTION_RE.test(trimmed)) {
        this.ports.log?.(`[card] ${utterance.speaker}: dropped a sentence that points at the card; Kaki's pop-up does that: "${trimmed}"`);
        return;
      }
      if (aiHost !== undefined && utterance.speaker === aiHost &&
          this.currentTopicHasVisitorFollowUp() &&
          !namesColleague(trimmed, this.names) &&
          (HOST_SEND_PLACE_RE.test(trimmed) || (HOST_SEND_INSTRUCTION_RE.test(trimmed) &&
            (HOST_IMPERATIVE_START_RE.test(trimmed) || addressesVisitor(trimmed, this.human?.name))))) {
        this.ports.log?.(`[card] dropped host send-instruction: ${trimmed}`);
        return;
      }
      if (this.human !== undefined &&
          claimsStepGivenToOther(trimmed, utterance.speaker, this.guestLinesByTopic.get(this.currentItem()?.title) ?? [], this.names)) {
        this.ports.log?.(`[owner] ${utterance.speaker}: dropped a sentence that claims a step the visitor gave someone else: "${trimmed}"`);
        return;
      }
      if (this.human !== undefined) {
        const addressed = addressedShareTarget(trimmed, this.names);
        if (addressed !== undefined || MODEL_SHARE_TAKEOVER_RE.test(trimmed)) {
          const owner = addressed ?? utterance.speaker;
          if (!this.askedByGuestOnTopic(owner)) {
            this.ports.log?.(`[owner] ${utterance.speaker}: dropped a sentence that gives the visitor's follow-up to a colleague: "${trimmed}"`);
            return;
          }
        }
      }
      // The silence nudge (the only turn held with notBefore) must name the visitor, so a first-timer
      // knows the pause is theirs to fill; the model sometimes drops the name.
      if (turn.notBefore !== undefined && turn.enqueued.length === 0 && this.human !== undefined &&
          !namesVisitor(trimmed, this.human.name)) {
        trimmed = `${this.human.name}, ${/^I\b/.test(trimmed) ? trimmed : trimmed[0]!.toLowerCase() + trimmed.slice(1)}`;
        utterance = { speaker: utterance.speaker, text: trimmed };
      }
      if (turn.firstSentenceAt === undefined) {
        turn.firstSentenceAt = Date.now();
        this.ports.log?.(`first sentence written ${turn.firstSentenceAt - turn.startedAt} ms after the model was asked`);
      }
      const clip = this.synthesizeWithRetry(utterance, signal);
      turn.enqueued.push(utterance);
      queue.push({ utterance, clip });
    };

    try {
      const cast = this.options.scenario.npcs ?? [];
      const host = cast.find((npc) => npc.role === 'host')?.attendee;
      const seatNames = this.options.scenario.attendees.map((attendee) => attendee.name);
      const parser = new TurnParser(this.names, turn.forced?.target ?? host, this.human?.name, seatNames,
        (line) => this.ports.log?.(line));
      const alreadyAsked =
        this.human !== undefined && this.asked.has(this.human.name) && this.humanLines > this.linesAtMove;
      const includeKnows =
        this.human === undefined || this.humanLines > this.linesAtMove;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: this.systemPrompt(alreadyAsked, includeKnows),
        },
        ...this.history.slice(-this.maxHistory),
      ];
      const last = messages[messages.length - 1]!;
      const freshHumanLine = last.role === 'user' && !last.content.startsWith('[') ? last.content : undefined;
      let firstLine = '';
      let firstResolved = false;
      // Only a reply to something the visitor just said on this topic may settle it.
      let refuseReopen = false;
      const applyControl = (control: ReplyControl): void => {
        const applied = this.applyReplyControl(turn, control, freshHumanLine, (line) => enqueue(line));
        if (applied.refuseSpeech) refuseReopen = true;
      };
      let speechBuffer = '';
      const feedSpeech = (speech: string): void => {
        if (refuseReopen) return;
        speechBuffer += speech;
        for (;;) {
          const newline = speechBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = speechBuffer.slice(0, newline);
          speechBuffer = speechBuffer.slice(newline + 1);
          if (!isReplyControlLine(line)) {
            for (const utterance of parser.push(line + '\n')) enqueue(utterance);
          }
        }
        if (speechBuffer.length > 0 && !couldBeReplyControlLine(speechBuffer)) {
          for (const utterance of parser.push(speechBuffer)) enqueue(utterance);
          speechBuffer = '';
        }
      };
      const stream = this.ports.stream(messages, signal);
      for await (const chunk of stream) {
        if (signal.aborted) break;
        if (received.length < 160) received += chunk;
        if (!firstResolved) {
          // Blank lines before the control line are not a first line.
          firstLine = (firstLine + chunk).trimStart();
          const newline = firstLine.indexOf('\n');
          if (newline < 0 && couldBeReplyControlLine(firstLine) && firstLine.length < 2048) continue;
          const head = newline < 0 ? firstLine : firstLine.slice(0, newline);
          applyControl(parseReplyControl(head.trim(), (line) => this.ports.log?.(line)) ?? OPEN_REPLY_CONTROL);
          firstResolved = true;
          const rest = newline < 0 ? '' : firstLine.slice(newline + 1);
          if (!isReplyControlLine(head)) feedSpeech(head + (newline < 0 ? '' : '\n'));
          feedSpeech(rest);
          firstLine = '';
          continue;
        }
        feedSpeech(chunk);
      }
      if (!signal.aborted) {
        if (!firstResolved && firstLine.length > 0) {
          if (!isReplyControlLine(firstLine)) feedSpeech(firstLine);
          else applyControl(parseReplyControl(firstLine.trim(), (line) => this.ports.log?.(line)) ?? OPEN_REPLY_CONTROL);
        }
        if (speechBuffer.trim().length > 0 && !isReplyControlLine(speechBuffer)) {
          for (const utterance of parser.push(speechBuffer)) enqueue(utterance);
        }
        for (const utterance of parser.flush()) enqueue(utterance);
        choseSilence = parser.saidNone;
        if (heldRefusal !== undefined) {
          this.ports.log?.('the model replied only with a refusal; asking the visitor to repeat the request');
          heldRefusal = undefined;
          enqueue({ speaker: this.facilitatorOrCoHost() ?? this.names[0]!, text: 'Sorry, could you say that again?' });
        }
        turn.streamFinished = true;
      }
    } catch (error) {
      if (!signal.aborted) {
        failure = error;
        turn.streamFailed = true;
      }
    }

    // A held turn with a failed or finished stream and nothing left to hear must not wait forever:
    // release it so the normal wordless resume can ask the model instead.
    if (this.isTurnHeld(turn) && (failure !== undefined || turn.streamFinished) && this.heldLineCount(turn) === 0) {
      this.abandonHeldTurn(turn);
      return;
    }

    queue.close();
    await player;
    if (turn.aborted) {
      this.finishDispatchCue(turn);
      return;
    }

    if (turn.spoken.length > 0 && turn.topic !== undefined && turn.control !== undefined) {
      this.memory.invented(this.reopenedTitle ?? turn.topic, turn.control.newFacts ?? []);
    }

    this.finalize(turn);
    this.turn = undefined;
    // A task cue is not an answer: no brief, hand-over, silence prompt or recovery cue follows it.
    if (turn.dispatchCue !== undefined) {
      this.gate.setAiAudible(false);
      this.finishDispatchCue(turn);
      this.ports.emitState(this.idleState());
      return;
    }
    if (this.hasHeldGuestLine()) {
      this.scheduleRespond();
      return;
    }
    if (this.budgetRecoveryPending && !this.humanSettledOnCurrentItem) {
      this.budgetRecoveryPending = false;
      this.offerBudgetLock();
    }
    this.gate.setAiAudible(false);
    const briefing = this.maybeBrief();
    const handedTo =
      !briefing && failure === undefined
        ? findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name)
        : undefined;
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (!briefing && failure === undefined && turn.spoken.length > 0) {
      this.scheduleDeferredFollowUp(turn);
      if (!this.lastSpoken.trim().endsWith('?')) {
        const finalSpeaker = turn.spoken.at(-1)?.utterance.speaker;
        const questionFromFinalSpeaker = [...turn.spoken]
          .reverse()
          .find((entry) => entry.utterance.speaker === finalSpeaker && entry.utterance.text.trim().endsWith('?'));
        if (questionFromFinalSpeaker !== undefined) {
          this.lastSpoken = questionFromFinalSpeaker.utterance.text;
        }
      }
      this.scheduleSilencePrompt();
    }
    if (!briefing && failure !== undefined && turn.spoken.length > 0) {
      const speaker = turn.spoken.at(-1)?.utterance.speaker ?? 'the room';
      const message = failure instanceof Error ? failure.message : String(failure);
      this.ports.log?.(`[stream-cut] ${speaker}: reply stopped after ${turn.spoken.length} sentences: ${message}`);
      this.scheduleSilencePrompt();
    }
    if (!briefing && failure !== undefined && turn.spoken.length === 0) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.ports.log?.(`the model failed: ${message}`);
      if (!this.recoverFromEmptyTurn(turn)) this.ports.emitState({ kind: 'error', message });
    } else if (!briefing && !choseSilence && turn.spoken.length === 0) {
      // The reply finished but nothing in it could be said (empty, only the control line, or every line dropped):
      // treat it like a failed reply, or the meeting goes quiet with nobody due to speak.
      this.ports.log?.(`the model said nothing speakable (it sent ${JSON.stringify(received.slice(0, 160))})`);
      if (!this.recoverFromEmptyTurn(turn)) this.ports.emitState(this.idleState());
    } else if (!briefing) {
      this.ports.emitState(this.idleState());
    }
  }

  /** Send this reply's reactions once, as its first line starts; a turn aborted before then sends none. */
  private sendReactions(turn: Turn): void {
    if (turn.reactionsSent === true || turn.control === undefined || turn.topic === undefined) return;
    turn.reactionsSent = true;
    for (const reaction of turn.control.reactions ?? []) {
      if (!this.names.includes(reaction.who)) {
        this.ports.log?.(`[control] dropped reaction: ${reaction.who} is not an AI attendee`);
        continue;
      }
      if (this.currentItem()?.sensitive === true && !['🤔', '😬', '⏰'].includes(reaction.emoji)) {
        this.ports.log?.(`[control] dropped reaction: ${reaction.emoji} is not allowed on a sensitive item`);
        continue;
      }
      this.ports.log?.(`[control] reaction: ${reaction.who} ${reaction.emoji}`);
      this.ports.onReaction?.(reaction.who, reaction.emoji);
    }
  }

  /**
   * Synthesize one sentence, retrying once so a single voice failure does not lose it. `undefined` means both
   * attempts failed and the line will be shown as text instead; an aborted turn never retries.
   */
  private async synthesizeWithRetry(utterance: Utterance, signal: AbortSignal): Promise<Clip | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.ports.synthesize(utterance, signal);
      } catch (error) {
        if (signal.aborted) return undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 1) {
          this.ports.log?.(`[tts] retry ${utterance.speaker}: ${message}`);
          continue;
        }
        this.ports.log?.(`could not synthesize "${utterance.text}": ${message}`);
        return undefined;
      }
    }
  }

  /**
   * Wait until no other turn is playing, so two AI lines never sound at once. The old line is not waited for
   * forever: after FLOOR_WAIT_MAX_MS it is stopped (keeping what was heard) and the new line goes ahead.
   */
  private async waitForFloor(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + FLOOR_WAIT_MAX_MS;
    let logged = false;
    while (!signal.aborted && !this.closed) {
      const current = this.turn;
      if (current === undefined || current.finalized) return;
      if (Date.now() >= deadline) {
        // Stop the old line rather than play over it: once `this.turn` is replaced, nothing could cut it off (#66).
        this.ports.log?.('[floor] another line is still holding the floor; stopping it');
        this.interrupt('another line took the floor');
        return;
      }
      if (!logged) {
        logged = true;
        this.ports.log?.('[floor] waiting for the line that is playing to finish');
      }
      await Promise.race([current.done, this.wait(250, signal)]);
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** How long a text-only line stays up: about 60 ms per character, within quiet bounds. */
  private textReadingMs(text: string): number {
    return Math.min(6_000, Math.max(1_500, Math.round(text.trim().length * 60)));
  }

  private async playAll(
    turn: Turn,
    queue: SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>,
    transcribe = true,
  ): Promise<void> {
    const iterator = queue[Symbol.asyncIterator]();
    let pending: { utterance: Utterance; clip: Promise<Clip | undefined> } | undefined;
    let heldForTarget = false;
    let previousSpeaker: string | undefined;
    for (;;) {
      if (turn.abort.signal.aborted) return;
      // A sound-only cut-in stopped the sound but kept this turn: wait here instead of discarding it.
      if (this.isTurnHeld(turn)) {
        await this.waitWhileHeld(turn);
        continue;
      }
      if (!heldForTarget && turn.notBefore !== undefined) {
        const waitMs = turn.notBefore - Date.now();
        if (waitMs > 0) {
          await this.wait(waitMs, turn.soundAbort.signal);
          continue;
        }
        heldForTarget = true;
      }
      if (pending === undefined) {
        const next = await iterator.next();
        if (next.done === true) return;
        pending = next.value;
        continue;
      }

      const { utterance, clip } = pending;
      const audio = await clip;
      if (turn.abort.signal.aborted) return;
      if (this.isTurnHeld(turn)) continue;
      const last = turn.spoken.at(-1);
      // The sentence that was being spoken when the cut came starts again, whole, on the same entry.
      const restarting = last !== undefined && last.complete === false && last.utterance === utterance;
      if (!restarting && !turn.scripted && !turn.replay && turn.planned === undefined) {
        const repeated = namesColleague(utterance.text, this.names) ? undefined :
          this.repeatsRecently(utterance.text, turn.startedAt);
        if (repeated !== undefined) {
          this.ports.log?.(`[repeat] ${utterance.speaker}: dropped a queued sentence already said by ${repeated.speaker}: "${utterance.text}"`);
          pending = undefined;
          continue;
        }
        if (isQuestionToVisitor(utterance.text, utterance.speaker, this.names, this.human?.name) && this.askedGuestInRound) {
          // The prompt already asks for a question only when it is really needed, so this is a backstop:
          // warn rather than drop the colleague's question and leave their line half-said.
          this.ports.log?.(`[question] ${utterance.speaker}: a second question to the visitor this round: "${utterance.text}"`);
        }
      }
      const textOnly = audio === undefined;

      if (!restarting && this.humanTalking) {
        // Never start a line over someone who is already talking (#67): wait for them to stop, then let the
        // existing hold and interrupt rules decide what happens to this line.
        this.ports.log?.(`[floor] ${utterance.speaker} waits: the guest is talking`);
        while (this.humanTalking && !turn.soundAbort.signal.aborted && !this.closed) {
          await this.wait(HUMAN_TALKING_RECHECK_MS, turn.soundAbort.signal);
        }
        if (turn.abort.signal.aborted || this.closed) return;
        continue;
      }

      if (!restarting) {
        const gapMs = previousSpeaker === undefined ? 0 : previousSpeaker === utterance.speaker ? this.sentenceGapMs : this.speakerGapMs;
        if (gapMs > 0) {
          await this.wait(gapMs, turn.soundAbort.signal);
          if (turn.abort.signal.aborted) return;
          if (this.isTurnHeld(turn)) continue;
          // The guest may have started talking during the gap; the check above then waits for them (#67).
          if (this.humanTalking) continue;
        }
        previousSpeaker = utterance.speaker;

        const entry: Turn['spoken'][number] = {
          utterance,
          complete: false,
          startedAt: Date.now(),
          durationMs: textOnly ? undefined : this.ports.clipDurationMs?.(audio),
          textOnly,
        };
        if (turn.spoken.length === 0) {
          this.ports.log?.(`speaking ${Date.now() - turn.startedAt} ms after the model was asked`);
        }
        this.ports.log?.(`${utterance.speaker}: ${utterance.text}`);
        this.introduced.add(utterance.speaker);
        turn.spoken.push(entry);
        if (turn.spoken.length === 1) this.sendReactions(turn);
        if (!textOnly) {
          this.gate.setAiAudible(true);
          this.gate.aiSaid(utterance.text);
        }
        this.lastSpoken = utterance.text;
        if (turn.planned === undefined) {
          entry.shadowLineId = this.rememberSpoken(
            utterance,
            turn.topic ?? this.currentItem()?.title,
            undefined,
            turn.scripted === true || turn.nudge === true,
          );
        } else {
          this.noteSpokenSides(utterance, turn.topic ?? this.currentItem()?.title);
          this.startPlannedLine(turn, utterance);
        }
        this.noteCardPoint(utterance);
        this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker, canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
        const transcriptKey = `${utterance.speaker}:${utterance.text}`;
        if (transcribe) {
          const alreadyRecorded = this.transcriptEmitted.has(utterance);
          const pendingRestore = this.pendingTranscriptRestore;
          this.pendingTranscriptRestore = undefined;
          const restoreLineId = pendingRestore?.key === transcriptKey ? pendingRestore.lineId : undefined;
          if (alreadyRecorded || restoreLineId !== undefined) {
            // The line was already recorded when it was first spoken: replaying or resuming only restores
            // what is shown, so the minutes, note taker and talk time still see it once.
            const lineId = alreadyRecorded ? this.transcriptLineId(utterance) : restoreLineId;
            if (lineId !== undefined) {
              entry.transcriptLineId = lineId;
              this.transcriptLineIds.set(utterance, lineId);
              this.transcriptEmitted.add(utterance);
              this.lastTranscriptEmit = transcriptKey;
              this.ports.emitTranscriptUpdate(utterance.speaker, utterance.text, { lineId, cut: false });
            }
          } else if (transcriptKey !== this.lastTranscriptEmit) {
            entry.transcriptLineId = this.transcriptLineId(utterance);
            this.lastTranscriptEmit = transcriptKey;
            this.transcriptEmitted.add(utterance);
            this.ports.emitTranscript(utterance.speaker, utterance.text, this.transcriptOptions(turn, utterance, textOnly));
          }
        }
        const played = await this.playUtterance(turn, utterance, audio, textOnly);
        let heard = played;
        this.ports.log?.(`finished speaking ${utterance.speaker}`);
        if (!played && turn.planned !== undefined && !turn.abort.signal.aborted && !this.isTurnHeld(turn)) {
          heard = await this.showOpeningLineAsText(turn, utterance, transcribe);
        }
        if (turn.abort.signal.aborted) {
          if (turn.planned === undefined) this.shadowLineEnded(entry.shadowLineId, false);
          else this.endPlannedLine(turn, false);
          return;
        }
        if (this.isTurnHeld(turn)) continue;
        if (turn.planned !== undefined && !heard) {
          this.ports.log?.(`[${turn.planned?.kind ?? 'opening'}] ${utterance.speaker}: the line could not be played or shown, so it is not heard`);
          this.endPlannedLine(turn, false);
          return;
        }
        entry.complete = true;
        if (turn.planned === undefined) this.shadowLineEnded(entry.shadowLineId, true);
        else if (turn.planned.lastUtterance === utterance) this.endPlannedLine(turn, true);
        pending = undefined;
        if (turn.topic !== undefined) this.memory.spoken(this.reopenedTitle ?? turn.topic, utterance.text);
        continue;
      }

      // Restarting the cut sentence: it was transcribed, accepted and counted; replay its sound and
      // put the full line back in the transcript so the cut part is replaced, not read again.
      last.startedAt = Date.now();
      last.durationMs = textOnly ? undefined : this.ports.clipDurationMs?.(audio);
      if (transcribe && last.transcriptLineId !== undefined && last.transcriptCut === true) {
        this.lastTranscriptEmit = `${utterance.speaker}:${utterance.text}`;
        last.transcriptCut = false;
        this.ports.emitTranscriptUpdate(utterance.speaker, utterance.text, {
          lineId: last.transcriptLineId,
          cut: false,
        });
      }
      if (!textOnly) {
        this.gate.setAiAudible(true);
        this.gate.aiSaid(utterance.text);
      }
      this.lastSpoken = utterance.text;
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker, canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
      const played = await this.playUtterance(turn, utterance, audio, textOnly);
      let heard = played;
      this.ports.log?.(`finished speaking ${utterance.speaker}`);
      if (!played && turn.planned !== undefined && !turn.abort.signal.aborted && !this.isTurnHeld(turn)) {
        heard = await this.showOpeningLineAsText(turn, utterance, false);
      }
      if (turn.abort.signal.aborted) {
        if (turn.planned === undefined) this.shadowLineEnded(last.shadowLineId, false);
        else this.endPlannedLine(turn, false);
        return;
      }
      if (this.isTurnHeld(turn)) continue;
      if (turn.planned !== undefined && !heard) {
        this.ports.log?.(`[${turn.planned?.kind ?? 'opening'}] ${utterance.speaker}: the line could not be played or shown, so it is not heard`);
        this.endPlannedLine(turn, false);
        return;
      }
      last.complete = true;
      if (turn.planned === undefined) this.shadowLineEnded(last.shadowLineId, true);
      else if (turn.planned.lastUtterance === utterance) this.endPlannedLine(turn, true);
      pending = undefined;
      if (turn.topic !== undefined) this.memory.spoken(this.reopenedTitle ?? turn.topic, utterance.text);
    }
  }

  /** The transcript markers for one sentence: its stable line id, text-only, and the catch id once the planned line reaches its last sentence. */
  private transcriptOptions(
    turn: Turn,
    utterance: Utterance,
    textOnly: boolean,
  ): { textOnly?: boolean; catchId?: string; lineId?: string; gate?: 'lock-offer' } {
    const catchId = turn.planned?.catchId !== undefined && turn.planned.lastUtterance === utterance
      ? turn.planned.catchId
      : undefined;
    const gate = turn.lockOffer === true ? 'lock-offer' as const : undefined;
    return {
      lineId: this.transcriptLineId(utterance),
      ...(textOnly ? { textOnly: true } : {}),
      ...(catchId === undefined ? {} : { catchId }),
      ...(gate === undefined ? {} : { gate }),
    };
  }

  /**
   * Replace the open transcript line with the words the room actually heard before an interruption.
   * The heard boundary comes from the same playback entry and `complete` flag the model's transcript uses.
   */
  private emitCutTranscript(turn: Turn): void {
    const entry = turn.spoken.at(-1);
    if (entry === undefined || entry.complete || entry.transcriptLineId === undefined || entry.transcriptCut === true) return;
    const heard = heardPrefix(entry.utterance.text, Date.now() - entry.startedAt, entry.durationMs);
    entry.transcriptCut = true;
    this.lastTranscriptEmit = '';
    this.ports.emitTranscriptUpdate(entry.utterance.speaker, heard, {
      lineId: entry.transcriptLineId,
      cut: true,
    });
  }

  /** Play one sentence (or hold a text-only line up long enough to read), stopping early when the turn is cut. */
  private async playUtterance(
    turn: Turn,
    utterance: Utterance,
    audio: Clip | undefined,
    textOnly: boolean,
  ): Promise<boolean> {
    if (textOnly) {
      this.ports.log?.(`[tts] shown as text: ${utterance.speaker}`);
      await this.wait(this.textReadingMs(utterance.text), turn.soundAbort.signal);
      return true;
    }
    try {
      await this.ports.play(utterance.speaker, audio as Clip, turn.soundAbort.signal);
      return true;
    } catch (error) {
      if (!turn.abort.signal.aborted && turn.held !== true) {
        this.ports.log?.(`playback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  /** A failed opening playback still reaches the guest on screen, using the same text view as a failed voice. */
  private async showOpeningLineAsText(turn: Turn, utterance: Utterance, transcribe: boolean): Promise<boolean> {
    this.ports.log?.(`[tts] playback failed; showing as text: ${utterance.speaker}`);
    if (transcribe) this.ports.emitTranscript(utterance.speaker, utterance.text, this.transcriptOptions(turn, utterance, true));
    await this.wait(this.textReadingMs(utterance.text), turn.soundAbort.signal);
    return !turn.abort.signal.aborted;
  }
}
