import { itemMode, type ActionKind, type AgendaItem, type BriefingFact, type MeetingMemoryEntry, type NpcStateMessage, type Scenario, type SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../llm';
import { cleanSpokenTopic, liveWrapUpLine, spokenAgendaName } from '../host/opening';
import { CardPointer, visitorCardPointerLine } from './cardPointer';
import { addressedCharacter, buildSystemPrompt, findHandover, HandoverGuard, pushingColleague, replyShapeForTurn, replyShapeInstruction, responsibilityFor, TurnParser, type HumanInfo, type ReplyShape, type Utterance } from './director';
import { silenceCheckInLine, silenceCheckInNote, silenceColleagueNote } from './silence';
import { couldBeReplyControlLine, isReplyControlLine, OPEN_REPLY_CONTROL, parseReplyControl, type ReplyControl } from './replyControl';
import { SpeechGate } from './speechGate';
import { MeetingMemory } from './meetingMemory';
import { TopicRecord, type OpenQuestion, type TopicPromptView } from './topicRecord';
import { meetingTopic, MeetingState } from './meetingState';
import { describeDecision, next as nextPlannerDecision, type PlannerEvent } from './turnPlanner';

/** What the people in the meeting should see the AI attendees doing. */
export type NpcUiState = NpcStateMessage;

/** Everything the conversation needs from the outside world; tests replace all of it. */
export interface NpcPorts<Clip> {
  /** Stream the Director's reply; must stop promptly when `signal` aborts. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** Turn a sentence into audio. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Clip>;
  /** Play a clip as `speaker`. Resolves when it finished, or straight after `signal` aborts and the sound has stopped. */
  play(speaker: string, clip: Clip, signal: AbortSignal): Promise<void>;
  /** Playback length for resuming a scripted sentence after a wordless cut-in. */
  clipDurationMs?(clip: Clip): number;
  /** A line said in the meeting, for Kaki's transcript; `textOnly` marks a line shown as text because its voice failed. */
  emitTranscript(speaker: string, text: string, options?: { textOnly?: boolean }): void;
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
export const DEFAULT_RESPONSE_DELAY_MS = 300;

/** Pause when one character finishes and a different one starts, so it sounds like people taking turns. */
export const DEFAULT_SPEAKER_GAP_MS = 900;
/** Pause between two sentences of the same speaker, so they do not run together. */
export const DEFAULT_SENTENCE_GAP_MS = 400;

/** The person cut an AI attendee off but said nothing recognisable; they carry on after this long. */
export const DEFAULT_RESUME_MS = 1800;

/** When speech recognition reports that a cut-in held no words, the AI carries on after this long. */
export const DEFAULT_NOTHING_MS = 400;

/** An answer cancelled before anything was said, with nothing new from the person, is retried after this long. */
export const DEFAULT_RETRY_MS = 1500;

/** How many times in a row the AI may pass the turn to another character without the person saying anything. */
export const MAX_FOLLOW_UPS = 2;

/** How long a Host cue waits for a quiet moment before it is dropped as out of date. */
export const DEFAULT_ANNOUNCE_GIVE_UP_MS = 40_000;


/** The host asks when the agenda moves on; if that never happens, after this many lines from the person. */
export const ASK_BACKSTOP_LINES = 8;
/** How long after the host announces the next item before the question (the announcement is spoken first). */
export const DEFAULT_ASK_DELAY_MS = 3000;
/** How long after an item opens, with the person silent, before the characters start talking it through. */
export const DEFAULT_OBSERVE_DELAY_MS = 1500;
/** How long the room waits in silence on the person's item before the host gently checks in by name. */
export const DEFAULT_SILENCE_PROMPT_MS = 22_000;
/** Start writing the first silence nudge this long before it should be heard, so model time does not delay it. */
export const DEFAULT_SILENCE_NUDGE_LEAD_MS = 15_000;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** A topic still open after this many lines from the visitor, or this long, gets one offer from the host to lock in what they said. */
export const DEFAULT_TOPIC_TURN_BUDGET = 12;
export const DEFAULT_TOPIC_TIME_BUDGET_MS = 180_000;
/** How long the host waits for an answer to that offer before asking once more, and then before locking it in. */
export const DEFAULT_BUDGET_SILENCE_MS = 20_000;
/** After a settled topic waits this long with nothing happening on the card, the host nudges the visitor towards it. */
export const DEFAULT_REVIEW_NUDGE_MS = 5_000;
/**
 * How long a settled topic waits for the visitor's follow-up card with nothing happening on it before the host moves on.
 * Short on purpose: a long wait was 30-50 s of silence for a first-timer, and the card stays sendable after the room moves on.
 * Any progress on the card restarts the wait, so a visitor working on it is never cut off.
 */
export const DEFAULT_REVIEW_WINDOW_MS = 10_000;
/** After the follow-up is sent or declined, how long the topic stays so the visitor can open the result. */
export const DEFAULT_OPEN_LIVE_GRACE_MS = 9_000;

/** How long the person must keep talking over the room before it stops; a shorter burst is probably noise or an echo. */
export const DEFAULT_BARGE_IN_MS = 1400;

/** Short listener backchannels ("Oh.", "So.", "Cool.") spoken while an AI colleague is mid-turn should not abort the colleague's turn. */
const LISTENER_BACKCHANNEL_WHILE_SPEAKING_RE =
  /^(?:oh|ah|uh-huh|mm-hmm|mhm|mm|hmm|so|cool|nice|wow|i see|gotcha)[,.!?\s]*$/i;

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
export const DEFAULT_REPEAT_WINDOW_MS = 60_000;
/** How often a card pointer or move-on rechecks whether the topic's open question has been answered. */
const CARD_WAIT_POLL_MS = 500;
/** How long an early colleague brief may wait for its first spoken sentence before it is aborted and retried. */
export const DEFAULT_BRIEF_FIRST_CHUNK_MS = 12_000;
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

/** True when `next` restates most of `previous` and adds only a little of its own. */
function closelyRepeats(next: Set<string>, previous: Set<string>): boolean {
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

/** The host is pointing the visitor at their follow-up card. */
const CARD_POINT_RE =
  /\b(?:your card|the card|card on the right|screen on the right|panel on the right|right-hand panel|on your screen)\b/i;

/** A whole line that is only a greeting, filler or acknowledgement, so it is not an idea for the topic. */
const GUEST_GREETING_OR_FILLER =
  /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|yo|testing|test|wait|hold on|one sec|hang on|can you hear me|you guys hear me|is my mic working|idk|i don't know|not sure|hmm+|uh+|um+|ok|okay|sure|yes|no|yeah|yep|nope|right|fine|thanks|thank you|got it)(?:[ ,]+(?:team|all|everyone|folks))?[,.!?]*\s*)+$/i;

/** An idea put as a question ("What if we move the till?", "Shall we cut the menu?"), not a question for facts. */
const GUEST_PROPOSAL_QUESTION = /^(?:what if|why not|why don'?t we|how about|shall we|let'?s)\b/i;

/** True when a visitor's line is an idea for the topic, not a greeting, filler or a question for facts. */
function isGuestProposal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (GUEST_GREETING_OR_FILLER.test(trimmed)) return false;
  if (trimmed.endsWith('?')) return GUEST_PROPOSAL_QUESTION.test(trimmed);
  return true;
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

export interface ConversationOptions {
  topicTurnBudget?: number;
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
  /** False turns off the first-idea catch guard for tests of other paths; the live meeting keeps it on. */
  firstIdeaCatch?: boolean;
  gate?: SpeechGate;
  memory?: MeetingMemory;
}

interface DispatchCue {
  /** How the cue is named in a log line when nothing was said. */
  what: string;
  /** The task title that must never be read aloud; a line carrying it is dropped. */
  forbiddenText?: string;
  /** Sam is pointing at the card, so his own line may mention the card or screen. */
  cardPointer?: boolean;
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
  spoken: Array<{ utterance: Utterance; complete: boolean; startedAt: number; durationMs?: number; shadowLineId?: string }>;
  enqueued: Utterance[];
  streamFinished: boolean;
  streamFailed?: boolean;
  /** A sound-only cut-in paused this turn instead of discarding it; its unsaid lines play if no words follow. */
  held?: boolean;
  /** A silence nudge (a check-in, a colleague line or the statement bridge); its note is dropped if it is never heard. */
  nudge?: boolean;
  /** The history entry the nudge note was written from, removed when the visitor speaks before any of it is heard. */
  nudgeNote?: ChatMessage;
  /** Wakes the playback loop when a held turn carries on or is discarded. */
  heldWake?: () => void;
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
  shape?: ReplyShape;
  briefSpeaker?: string;
  /** Everyone the brief gives a fact to, so only they may state one. */
  briefSpeakers?: string[];
  /** The Director marked this reply as settling the topic; it takes effect once the visitor has heard some of it. */
  settle?: { followUp?: { kind: ActionKind; title: string } };
  control?: ReplyControl;
  /** This reply's reactions have been sent; they go out with the first line, not when the reply ends. */
  reactionsSent?: boolean;
  prefetchedStream?: AsyncIterable<string>;
}

interface PrefetchedReply {
  title: string;
  cue: string;
  speakers: string[];
  controller: AbortController;
  chunks: string[];
  done: boolean;
  failure?: unknown;
  startedAt: number;
  wake?: () => void;
  firstChunkTimer?: ReturnType<typeof setTimeout>;
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
  /**Lines the person has said (heard or typed) since they joined; the host asks them for their decision after a few. */
  private humanLines = 0;
  /** Visitor words on this topic, retained for the task context and the lock safety net. */
  private decisionLines: string[] = [];
  /** The visitor's ideas on this topic, oldest first, so the first one is never accepted outright. */
  private readonly proposalsByTopic = new Map<string | undefined, string[]>();
  private humanSettledOnCurrentItem = false;
  /** That question, captured just before the visitor's latest line, so settling can fold it into the follow-up. */
  private questionBeforeGuestLine: string | undefined;
  private topicOpenedAt = Date.now();
  private budgetOffered = false;
  private budgetRecoveryPending = false;
  private budgetOfferAtLine = 0;
  private lastLockAskAt = -Infinity;
  private replyShapeIndex = 0;
  private lastReplyShape: ReplyShape | undefined;
  private readonly replyShapeHistory: ReplyShape[] = [];
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private topicBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewNudged = false;
  private reviewWarned = false;
  private readonly topicTasks = new Map<string, Map<string, 'pending' | 'done'>>();
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
  /** The fact speakers of the last brief, kept for a retry of the same cue. */
  private lastBriefSpeakers: string[] | undefined;
  /** The item waiting for the room to be free so its colleague briefing can start. */
  private pendingBrief: string | undefined;
  private prefetchedBrief: PrefetchedReply | undefined;
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
  /** Host cues waiting for a quiet moment to play. */
  private pendingAnnouncements = 0;
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
      topics: options.scenario.agenda.map(meetingTopic),
      present: this.names,
      host: (options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee ?? this.names[0],
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
    this.shadowLineSeq = 0;
    this.cardWaitLoggedFor = undefined;
    this.lastLockAskAt = -Infinity;
    this.replyShapeIndex = 0;
    this.lastReplyShape = undefined;
    this.replyShapeHistory.length = 0;
    this.guestLinesByTopic.clear();
    this.proposalsByTopic.clear();
    this.volunteersByTopic.clear();
    this.cardNudgedTopics.clear();
    this.cardPointer.clear();
    this.parkedTopics.clear();
    this.reviewActionKind.clear();
    this.usedGuestInvites.clear();
  }

  memorySnapshot(): MeetingMemoryEntry[] { return this.memory.snapshot(); }

  /** The last sentence the room said, if it was a question: then it is the person's turn, and the screen says so. */
  private lastSpoken = '';
  private lastTranscriptEmit = '';
  private wingmanHintActive = false;

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
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed);
    this.pending.push(typed);
    this.noteHumanLine(typed);
    this.noteDecisionLine(typed);
    this.discardUnheardNudge();
    this.interrupt('the person typed something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
    this.ports.emitState(this.idleState());
  }

  /** The person pressed Stop/Pause: everyone goes quiet and timers are held until they press Resume (or type). */
  stop(): void {
    if (this.closed || this.concluded || this.paused) return;
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
    this.clearDeferredFollowUpTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    this.topicBudgetTimer = undefined;
    this.clearBudgetTimer();
    this.clearReviewTimer();
    this.pending = [];
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
    this.pausedScripted = undefined;
    this.pausedUtterances = undefined;
    this.pausedCutOff = false;
    this.cutOffSpeaker = undefined;
    this.resumeFromPause();
    this.announce(speaker, text);
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
    const item = this.currentItem();
    if (item !== undefined && this.names.length > 2 && !this.briefed.has(item.title)) {
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
      this.topicBudgetTimer = setTimeout(() => this.offerBudgetLock(),
        this.options.topicTimeBudgetMs ?? DEFAULT_TOPIC_TIME_BUDGET_MS).unref();
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
      else if (this.unanswered) this.startTurn(true);
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

  /** The browser recognised some of the person's words. */
  humanText(text: string): void {
    this.humanRecognizing(false);
    const heard = text.trim();
    if (this.closed || this.concluded || heard.length === 0) return;
    if (this.paused) {
      this.ports.log?.(`ignored "${heard}": the meeting is paused`);
      return;
    }

    const decision = this.gate.check(heard);
    if (!decision.ok) {
      const mic = this.ports.describeMic?.();
      this.ports.log?.(`ignored "${heard}" (${decision.reason}${mic === undefined ? '' : `; ${mic}`})`);
      return;
    }

    const accepted = decision.text ?? heard;
    this.lastHumanInputWasTyped = false;
    if (this.turn !== undefined && LISTENER_BACKCHANNEL_WHILE_SPEAKING_RE.test(accepted)) {
      this.ports.log?.(`ignored listener backchannel "${accepted}" while an AI colleague is speaking`);
      return;
    }
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
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted);
    this.clearPrefetchedBrief('the person spoke first');
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
    this.interrupt('the person said something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
    this.ports.emitState(this.idleState());
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
      () => this.startScripted({ speaker, text: line }, onDone),
      giveUpMs,
      () => onDone?.(false),
      shouldStillSpeak,
    );
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
        this.startTurn(false, false, undefined, undefined, undefined, {
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
   * Sam points the visitor at the follow-up card on the current topic, in his own words from `note`, once per topic.
   * While a question on this topic is still open he waits, so he does not point and move on over the top of it;
   * the wait ends when it is answered, or when the topic's own time runs out. The claim is given back when the
   * line is not heard, so the review nudge can still point later.
   */
  pointAtCard(
    note: string,
    options: {
      /** The task title the spoken line must never carry. */
      forbiddenText?: string;
      shouldStillSpeak?: () => boolean;
      onDone?: (spoken: boolean) => void;
    } = {},
  ): void {
    const topic = this.currentItem()?.title;
    const attempt = (): void => {
      if (this.closed || this.concluded || this.currentItem()?.title !== topic) return;
      const host = this.facilitatorOrCoHost();
      if (this.paused || host === undefined) {
        this.ports.log?.('[dispatch] cannot point at the card: the conversation is not running');
        options.onDone?.(false);
        return;
      }
      if (topic === undefined) {
        this.ports.log?.('[dispatch] skipped the card pointer: no topic is open');
        options.onDone?.(false);
        return;
      }
      this.startTopic(topic);
      const open = this.topicRecord.openQuestion;
      if (open !== undefined && this.topicStillHasTime()) {
        this.logCardWait(open.text);
        setTimeout(attempt, CARD_WAIT_POLL_MS).unref();
        return;
      }
      if (!this.cardPointer.claim(topic)) {
        this.ports.log?.(`skipped the card pointer on "${topic}": the visitor was already pointed to their card`);
        options.onDone?.(false);
        return;
      }
      const what = `the card pointer on "${topic}"`;
      this.cueWhenQuiet(
        what,
        () => {
          this.forcedSpeaker = { target: host, from: host };
          this.pending.push(note);
          this.startTurn(false, false, undefined, undefined, undefined, {
            what,
            cardPointer: true,
            forbiddenText: options.forbiddenText,
            shouldStillSpeak: options.shouldStillSpeak,
            onDone: (spoken) => {
              if (!spoken) this.cardPointer.release(topic);
              options.onDone?.(spoken);
            },
          });
        },
        DEFAULT_ANNOUNCE_GIVE_UP_MS,
        () => {
          this.cardPointer.release(topic);
          options.onDone?.(false);
        },
        options.shouldStillSpeak,
      );
    };
    if (this.closed || this.concluded) {
      this.ports.log?.('[dispatch] cannot point at the card: the conversation is not running');
      options.onDone?.(false);
      return;
    }
    if (topic === undefined) {
      this.ports.log?.('[dispatch] skipped the card pointer: no topic is open');
      options.onDone?.(false);
      return;
    }
    attempt();
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

  /**
   * Claim the single card pointer for the current topic. False means another path already pointed at it,
   * so the caller must stay quiet. Release it if the line is never spoken.
   */
  claimCardPointerOnCurrentTopic(): boolean {
    return this.cardPointer.claim(this.currentItem()?.title);
  }

  releaseCardPointerOnCurrentTopic(): void {
    this.cardPointer.release(this.currentItem()?.title);
  }

  /** The open question on the topic the meeting is on now, if any. */
  openQuestionOnCurrentTopic(): OpenQuestion | undefined {
    this.startTopic(this.currentItem()?.title);
    return this.topicRecord.openQuestion;
  }

  /** True while the current topic is inside its own time budget, so a wait for an answer can never hold the meeting. */
  private topicStillHasTime(): boolean {
    return Date.now() - this.topicOpenedAt < (this.options.topicTimeBudgetMs ?? DEFAULT_TOPIC_TIME_BUDGET_MS);
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
  private currentTopicHasVisitorFollowUp(turn: Turn): boolean {
    const title = this.currentItem()?.title;
    return title !== undefined && (this.reviewActionKind.has(title) || turn.settle !== undefined);
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
    this.clearPrefetchedBrief('the meeting is closing');
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
      closelyRepeats(words, contentWords(entry.text)));
  }

  /** Mirror a topic change into the shadow state without changing what the existing path says. */
  private startTopic(topic: string | undefined): void {
    this.topicRecord.start(topic);
    this.meetingState.openTopic(topic, Date.now());
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
  private shadowLineEnded(eventId: string | undefined, complete: boolean): void {
    if (eventId === undefined) return;
    const line = this.meetingState.lineEnded(eventId, complete, Date.now());
    if (line === undefined) return;
    this.planNextTurn({ kind: complete ? 'heard' : 'interrupted', line });
  }

  /** A guest line is heard whole the moment it is typed or recognised; it never has a partial playback. */
  private recordShadowGuestLine(text: string): void {
    const guest = this.human?.name;
    if (guest === undefined) return;
    const eventId = this.nextShadowLineId();
    this.meetingState.lineStarted({
      id: eventId,
      speaker: guest,
      text,
      at: Date.now(),
      proposal: isGuestProposal(text),
    });
    this.shadowLineEnded(eventId, true);
  }

  private rememberSpoken(utterance: Utterance, topic: string | undefined): string | undefined {
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
    if (question !== undefined) this.topicRecord.ask(question);
    this.topicRecord.said({ speaker: utterance.speaker, text: utterance.text });
    const eventId = this.nextShadowLineId();
    this.meetingState.lineStarted({
      id: eventId,
      speaker: utterance.speaker,
      text: utterance.text,
      at: Date.now(),
      ...(question === undefined ? {} : { question: { to: question.to, text: question.text } }),
    });
    const now = Date.now();
    this.recentSpoken.push({ speaker: utterance.speaker, text: utterance.text, at: now, topic });
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
    this.clearPrefetchedBrief('the meeting ended');
    this.clearDeferredFollowUpTimer();
    this.clearBudgetTimer();
    this.clearReviewTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    this.topicBudgetTimer = undefined;
    this.interrupt('the meeting ended');
  }

  private bargeTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private briefTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredFollowUpTimer: ReturnType<typeof setTimeout> | undefined;
  private silencePromptStage = 0;
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
      if (this.unanswered && !this.closed) {
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
      if (!this.humanTalking && !this.closed && !this.paused) this.startTurn();
      else this.ports.log?.(`[respond] skipped: ${this.closed ? 'closed' : this.paused ? 'paused' : 'the person is talking'}`);
    }, this.responseDelayMs);
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
    if (human === undefined || this.asked.has(human.name) || this.mode() === 'observe') return undefined;
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
    return (this.guestLinesByTopic.get(this.currentItem()?.title) ?? []).some((text) => assignedByGuest(text, name));
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
    const topic = this.currentItem()?.title;
    this.guestLinesByTopic.set(topic, [...(this.guestLinesByTopic.get(topic) ?? []), text]);
    this.startTopic(topic);
    // A new line starts the silence escalation again at the check-in.
    this.silencePromptStage = 0;
    this.clearSilenceTimer();
    const open = this.topicRecord.openQuestion;
    this.questionBeforeGuestLine = open !== undefined && open.to === this.human?.name ? open.text : undefined;
    // The visitor speaking is the answer the room was waiting for.
    if (open !== undefined && open.to === this.human?.name) this.answerTopicQuestion();
    this.humanLines += 1;
    this.recordShadowGuestLine(text);
    if (this.humanLines >= ASK_BACKSTOP_LINES || this.askDue) this.ask();
    if (!this.humanSettledOnCurrentItem && !this.budgetOffered &&
        (this.humanLines - this.linesAtMove >= (this.options.topicTurnBudget ?? DEFAULT_TOPIC_TURN_BUDGET) ||
         Date.now() - this.topicOpenedAt >= (this.options.topicTimeBudgetMs ?? DEFAULT_TOPIC_TIME_BUDGET_MS))) {
      queueMicrotask(() => this.offerBudgetLock());
    }
    if (this.budgetOffered && this.humanLines > this.budgetOfferAtLine) {
      this.clearBudgetTimer();
      this.budgetOffered = false;
      this.budgetRecoveryPending = true;
    }
  }

  /** Settle once and create the matching visitor task through the task store. */
  lockDecision(followUp?: { kind: ActionKind; title: string }): void {
    const item = this.currentItem();
    const human = this.human;
    if (this.closed || this.concluded || item === undefined || human === undefined ||
        this.humanSettledOnCurrentItem || this.decisionLines.length === 0) return;
    const role = this.options.scenario.roles.find((candidate) =>
      candidate.id === human.role || candidate.label === human.role)?.id;
    if (role === undefined) return;
    this.humanSettledOnCurrentItem = true;
    this.decisionWrappedUpOnItem = true;
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
    const input: SuggestInput = {
      title,
      context: `Agenda: ${item.title}. Visitor decision: ${decision}` +
        (openQuestion === undefined ? '' : ` Open question to carry into the follow-up: ${openQuestion}`),
      suggestedAssignee: role, actionKind: kind, agendaItemTitle: item.title,
      decisionSource: decision,
    };
    const succeeded = (): void => {
      if (generation !== this.memoryGeneration) return;
      if (this.closed || this.currentItem()?.title !== item.title) return;
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
  }

  /** Task lifecycle is the only normal reason to leave a settled topic. */
  taskStatus(id: string, origin: string | undefined, status: string, isVisitorTask: boolean, declined = false): void {
    const title = this.currentItem()?.title;
    if (!isVisitorTask || title === undefined || !this.onCurrentAgenda(origin)) return;
    const tasks = this.topicTasks.get(title) ?? new Map<string, 'pending' | 'done'>();
    if (status === 'DISMISSED') tasks.delete(id);
    else tasks.set(id, status === 'SYNCED' || declined ? 'done' : 'pending');
    this.topicTasks.set(title, tasks);
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

  private offerBudgetLock(): void {
    if (this.budgetOffered || this.humanSettledOnCurrentItem || this.decisionLines.length === 0) return;
    const remaining = DEFAULT_REPEAT_WINDOW_MS - (Date.now() - this.lastLockAskAt);
    if (remaining > 0) {
      this.clearBudgetTimer();
      this.budgetTimer = setTimeout(() => this.offerBudgetLock(), remaining).unref();
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
          if (this.humanLines === this.budgetOfferAtLine) this.lockDecision();
        }, 2 * (this.options.budgetSilenceMs ?? DEFAULT_BUDGET_SILENCE_MS)).unref();
      });
  }

  /** The clock's overtime cue would pile another decision request onto Sam's recent ask. */
  shouldSkipOvertimeCue(): boolean {
    return Date.now() - this.lastLockAskAt < 15_000;
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

  /** The first pointer at what the visitor will find on their card on this topic: a draft to send, or an invite to confirm. */
  private cardNudgeLine(visitor: string, title: string): string {
    return visitorCardPointerLine(visitor, this.reviewActionKind.get(title), this.topicIndex(title));
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
      const visitor = this.human?.name ?? 'You';
      if (!this.cardPointer.claim(title)) {
        this.ports.log?.(`skipped the card nudge on "${title}": the visitor was already pointed to their card`);
        this.startReviewWindow();
        return;
      }
      this.announce(host, this.cardNudgeLine(visitor, title),
        DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
          if (spoken) {
            this.cardNudgedTopics.add(title);
            this.startReviewWindow();
          } else {
            this.cardPointer.release(title);
            this.reviewNudged = false;
            this.startReviewWindow();
          }
        });
      return;
    }
    this.reviewWarned = true;
    if (this.parkedTopics.has(title)) {
      this.ports.log?.(`skipped the leave-there wrap-up on "${title}": the topic was parked`);
      this.checkTopicAdvance(true);
      return;
    }
    const wrapUp = liveWrapUpLine(this.options.scenario, title);
    const warning = this.cardPointer.hasPointed(title)
      ? wrapUp
      : `${wrapUp} The follow-up's on your card whenever you're ready.`;
    this.announce(host, warning,
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

  /**
   * True only on the turn that answers the visitor's first idea on this topic. Later turns are free to settle even
   * when the visitor's reply is not a new idea ("Yes." to "shall we lock it in?"), so the guard can never hold a topic.
   */
  private firstProposalOnTopic(turn: Turn, freshHumanLine: string | undefined): boolean {
    if (this.options.firstIdeaCatch === false || this.reopenedTitle !== undefined || turn.topic === undefined) return false;
    const ideas = this.proposalsByTopic.get(turn.topic) ?? [];
    return freshHumanLine !== undefined && ideas.length === 1 && freshHumanLine.includes(ideas[0]!);
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
    this.pendingBrief = undefined;
    if (title === undefined) {
      this.clearPrefetchedBrief('the agenda moved');
    } else {
      const previousTitle = this.currentItem()?.title;
      const cleanTitle = cleanSpokenTopic(title).toLowerCase();
      const matched = this.options.scenario.agenda.find(
        (candidate) => candidate.title === title || cleanSpokenTopic(candidate.title).toLowerCase() === cleanTitle,
      );
      const incomingTitle = matched?.title ?? title;
      // Keep a brief that was already fetched for this incoming topic while the previous item wound down.
      if (this.prefetchedBrief?.title !== incomingTitle) this.clearPrefetchedBrief('the agenda moved');
      if (previousTitle !== undefined && previousTitle !== incomingTitle) {
        this.interrupt('agenda moved');
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
    this.proposalsByTopic.clear();
    this.topicOpenedAt = Date.now();
    this.budgetOffered = false;
    this.budgetRecoveryPending = false;
    this.lastLockAskAt = -Infinity;
    this.reviewWarned = false;
    this.clearBudgetTimer();
    this.clearReviewTimer();
    this.clearDeferredFollowUpTimer();
    if (this.topicBudgetTimer !== undefined) clearTimeout(this.topicBudgetTimer);
    this.topicBudgetTimer = setTimeout(() => this.offerBudgetLock(),
      this.options.topicTimeBudgetMs ?? DEFAULT_TOPIC_TIME_BUDGET_MS).unref();
    this.ports.emitState(this.idleState());
    this.decisionWrappedUpOnItem = false;
    const item = this.currentItem();
    // In a full kopitiam/multi-colleague demo (more than 2 NPCs), let two AI colleagues briefly explain the background
    // and trade-offs of the item first before asking the visitor for their decision, so the visitor isn't asked cold!
    if (item !== undefined && this.names.length > 2 && !this.briefed.has(item.title)) {
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
      this.clearPrefetchedBrief('the brief is no longer due');
      return false;
    }
    if (
      this.turn !== undefined ||
      this.humanTalking ||
      this.recognizingSpeech ||
      this.pending.length > 0 ||
      this.respondTimer !== undefined
    ) {
      return false;
    }
    this.pendingBrief = undefined;
    const plan = this.briefPlan(title);
    if (plan === undefined) {
      this.clearPrefetchedBrief('no colleague could brief');
      this.ports.log?.(`could not brief "${title}": no colleague cue; asking the visitor instead`);
      this.askDue = true;
      this.ask();
      return false;
    }
    const prefetched = this.takePrefetchedBrief(title);
    this.briefed.add(title);
    this.asked.add(this.human?.name ?? '');
    this.pending.push(prefetched?.cue ?? plan.cue);
    this.startTurn(false, false, prefetched, undefined, prefetched?.speakers ?? plan.speakers);
    return true;
  }

  /** The old choice of first speaker, used only when a scenario gives the item no briefing facts. */
  private fallbackBriefSpeaker(item: AgendaItem, seat: string | undefined, host: string | undefined): string | undefined {
    const candidates = [...new Set([
      ...(item.discussion?.openingViews ?? []).map((view) => view.attendee),
      ...(item.discussion?.tradeOffs ?? []).map((tradeOff) => tradeOff.attendee),
    ])].filter((name) => name !== seat && name !== host && this.names.includes(name));
    const pushing = pushingColleague(this.options.scenario, item, this.human?.role, this.names, host);
    return [...new Set([
      ...(pushing === undefined ? [] : [pushing]),
      ...candidates,
      ...this.names.filter((name) => name !== seat && name !== host),
    ])][0];
  }

  /**
   * A briefing fact's speaker: the first knower present who is not the guest's seat or the host.
   * Facts with no such speaker are dropped with a loud log, never given to someone who would not know them.
   */
  private factSpeaker(
    fact: BriefingFact,
    seat: string | undefined,
    host: string | undefined,
  ): { attendee: string; why: string } | undefined {
    return fact.knownBy.find((knower) =>
      knower.attendee !== seat &&
      knower.attendee !== host &&
      this.names.includes(knower.attendee));
  }

  /**
   * A brief is a short exchange: each fact is told only by someone who knows it, consecutive facts by the
   * same speaker are one turn, a new speaker reacts to the line before, then up to two opening views and
   * the host's single closing question to the guest.
   */
  private briefPlan(title: string): { cue: string; speakers: string[] } | undefined {
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === title);
    const human = this.human;
    if (item === undefined || human === undefined) return undefined;
    const host = this.facilitatorOrCoHost();
    const seat = this.options.scenario.attendees.find((attendee) =>
      attendee.role === this.options.scenario.roles.find((role) => role.id === human.role || role.label === human.role)?.id)?.name;

    const planned: Array<{ speaker: string; texts: string[] }> = [];
    for (const fact of item.briefing ?? []) {
      const knower = this.factSpeaker(fact, seat, host);
      if (knower === undefined) {
        this.ports.log?.(`[brief] no one present knows "${fact.text}"`);
        continue;
      }
      const last = planned.at(-1);
      if (last?.speaker === knower.attendee) last.texts.push(fact.text);
      else planned.push({ speaker: knower.attendee, texts: [fact.text] });
    }
    if (planned.length === 0 && (item.briefing ?? []).length > 0) return undefined;

    const views = item.discussion?.openingViews ?? [];
    const first = planned[0]?.speaker ?? this.fallbackBriefSpeaker(item, seat, host);
    if (first === undefined) return undefined;
    const speakerNames = new Set(planned.map((group) => group.speaker));
    const problem = planned.length > 0
      ? undefined
      : views.find((view) => view.attendee === first)?.angle ?? item.decision ?? title;

    const factText = planned.length === 0
      ? `${first} tells what happened as they saw it, from "${problem}", in two or three short spoken sentences like telling a colleague, with at most one number. Do not introduce yourself or your job; the host already did.`
      : planned.map((group, groupIndex) => groupIndex === 0
        ? `${group.speaker} tells what happened as they saw it, from "${group.texts.join(' ')}", in two or three short spoken sentences like telling a colleague, with at most one number. Do not introduce yourself or your job; the host already did.`
        : `${group.speaker} answers ${planned[groupIndex - 1]!.speaker} in one or two short spoken sentences, reacting to what ${planned[groupIndex - 1]!.speaker} just said, and adds only this from their own knowledge: "${group.texts.join(' ')}". No other facts.`
      ).join(' ');

    const reactors = views.filter((view) =>
      view.attendee !== seat &&
      view.attendee !== host &&
      !speakerNames.has(view.attendee) &&
      this.names.includes(view.attendee));
    const index = this.options.scenario.agenda.findIndex((candidate) => candidate.title === item.title);
    const reactionCount = Math.min(reactors.length, Math.max(0, index) % 3);
    const chosen = reactors.slice(0, reactionCount);
    const hostName = host ?? first;
    const reactionText = chosen.length === 0
      ? planned.length <= 1 ? `Only ${first} speaks before ${hostName}.` : ''
      : chosen.map((view, reactionIndex) => {
          const before = reactionIndex === 0
            ? planned.at(-1)?.speaker ?? first
            : chosen[reactionIndex - 1]!.attendee;
          return `${view.attendee} answers ${before} in one short sentence, reacting to what ${before} just said, from what they care about: "${view.angle}". No new figure.`;
        }).join(' ');
    const decision = item.decision ?? title;
    const speakers = planned.length > 0 ? planned.map((group) => group.speaker) : [first];

    return {
      cue: `[We just started "${title}". Begin with "${first}:". This is the brief, written as one short exchange between colleagues. ${factText} ${reactionText} Last, ${hostName} asks ${human.name} one question from this decision: "${decision}". Ask it by name, ask only one question, and let ${hostName} close the turn. Everyone else stays quiet after that. Every line reacts to the line before it. Hold back at least one catch for ${human.name}'s first idea. Leave the decision open. No report phrases, no semicolons, no lists, no stock invitation, and no other facts.]`.replace(/\s+/g, ' ').trim(),
      speakers,
    };
  }

  briefsOnTopic(title: string): boolean {
    if (this.closed || !this.onCurrentAgenda(title)) return false;
    const current = this.currentItem()?.title;
    if (current === undefined || this.briefed.has(current) || this.pendingBrief !== current) return false;
    return this.briefPlan(current) !== undefined;
  }

  private prefetchBrief(title: string): void {
    if (this.human === undefined || this.pendingBrief !== title || this.currentItem()?.title !== title) return;
    const alreadyAsked = this.asked.has(this.human.name) && this.humanLines > this.linesAtMove;
    const includeKnows = this.humanLines > this.linesAtMove;
    this.startBriefPrefetch(title, { alreadyAsked, includeKnows });
  }

  /**
   * The next item's brief is fetched while the room winds the current item down, so it is ready by the
   * time the host finishes moving on. This is the same head start topic 1 gets from the long welcome.
   */
  private prefetchUpcomingBrief(): void {
    if (this.closed || this.paused || this.human === undefined || this.names.length <= 2) return;
    const next = this.nextAgendaItem();
    if (next === undefined || this.briefed.has(next.title) || this.currentItem()?.title === next.title) return;
    this.startBriefPrefetch(next.title, { alreadyAsked: false, includeKnows: false });
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

  private startBriefPrefetch(
    title: string,
    state: { alreadyAsked: boolean; includeKnows: boolean },
  ): void {
    if (this.closed || this.paused || this.human === undefined || this.briefed.has(title)) return;
    const existing = this.prefetchedBrief;
    if (existing !== undefined && existing.title === title && !existing.controller.signal.aborted) return;
    this.clearPrefetchedBrief('the topic or cue changed');
    const plan = this.briefPlan(title);
    if (plan === undefined) return;
    const prefetched: PrefetchedReply = {
      title, cue: plan.cue, speakers: plan.speakers, controller: new AbortController(), chunks: [], done: false, startedAt: Date.now(),
    };
    const upcoming = this.currentItem()?.title !== title;
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(
        state.alreadyAsked, state.includeKnows, title, upcoming ? { earlier: [], recent: [] } : undefined) },
      ...this.history.slice(-this.maxHistory),
      { role: 'user', content: plan.cue },
    ];
    this.prefetchedBrief = prefetched;
    this.ports.log?.(`[brief] asking for the briefing early, while the host speaks`);
    void this.pumpPrefetched(prefetched, messages);
  }

  private async pumpPrefetched(prefetched: PrefetchedReply, messages: ChatMessage[]): Promise<void> {
    const firstChunkMs = this.options.briefFirstChunkMs ?? DEFAULT_BRIEF_FIRST_CHUNK_MS;
    const clearFirstChunkTimer = (): void => {
      if (prefetched.firstChunkTimer !== undefined) {
        clearTimeout(prefetched.firstChunkTimer);
        prefetched.firstChunkTimer = undefined;
      }
    };
    if (firstChunkMs > 0) {
      prefetched.firstChunkTimer = setTimeout(() => {
        prefetched.firstChunkTimer = undefined;
        if (prefetched.done || prefetched.controller.signal.aborted) return;
        const timeoutError = new Error(`the first spoken sentence did not arrive within ${firstChunkMs} ms`);
        prefetched.failure = timeoutError;
        this.ports.log?.(`[brief] the early request timed out after ${firstChunkMs} ms`);
        prefetched.controller.abort();
        prefetched.done = true;
        prefetched.wake?.();
        prefetched.wake = undefined;
      }, firstChunkMs);
      prefetched.firstChunkTimer.unref?.();
    }
    const iterator = this.ports.stream(messages, prefetched.controller.signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) break;
        prefetched.chunks.push(next.value);
        const speech = prefetched.chunks.join('').replace(/^\s*KAKI_CONTROL[^\n]*\n?/i, '');
        if (/[.!?]["')\]]*(?:\s|$)/.test(speech)) clearFirstChunkTimer();
        prefetched.wake?.();
        prefetched.wake = undefined;
      }
    } catch (error) {
      if (!prefetched.controller.signal.aborted && prefetched.failure === undefined) {
        prefetched.failure = error;
        this.ports.log?.(`[brief] the early request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearFirstChunkTimer();
      prefetched.done = true;
      prefetched.wake?.();
      prefetched.wake = undefined;
    }
  }

  private prefetchedStream(prefetched: PrefetchedReply): AsyncIterable<string> {
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

  private takePrefetchedBrief(title: string): PrefetchedReply | undefined {
    const prefetched = this.prefetchedBrief;
    if (prefetched === undefined) return undefined;
    if (prefetched.title !== title || (prefetched.controller.signal.aborted && prefetched.failure === undefined)) {
      this.clearPrefetchedBrief('the pending brief changed');
      return undefined;
    }
    this.prefetchedBrief = undefined;
    return prefetched;
  }

  private clearPrefetchedBrief(reason?: string): void {
    const prefetched = this.prefetchedBrief;
    if (prefetched === undefined) return;
    this.prefetchedBrief = undefined;
    if (prefetched.firstChunkTimer !== undefined) {
      clearTimeout(prefetched.firstChunkTimer);
      prefetched.firstChunkTimer = undefined;
    }
    if (!prefetched.done) {
      this.ports.log?.(`[brief] dropped the early request${reason === undefined ? '' : `: ${reason}`}`);
      prefetched.controller.abort();
    }
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
      this.human === undefined ||
      host === undefined ||
      title === undefined ||
      this.pendingBrief === title ||
      this.mode() === 'observe' ||
      this.decisionWrappedUpOnItem ||
      this.silencePromptStage >= 2
    ) {
      return;
    }
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
        this.pendingAnnouncements > 0
      ) {
        this.scheduleSilencePrompt();
        return;
      }
      if (shouldBridgeStatement) {
        this.bridgedStatementOnTurn = true;
        const npcs = this.options.scenario.npcs ?? [];
        const spokenTitle = cleanSpokenTopic(title);
        if (npcs.length > 1) {
          this.forcedSpeaker = { target: host, from: host };
          this.pending.push(
            `[${this.human.name} just heard the team's answer on "${spokenTitle}", and the colleague finished on a statement without passing the floor. Begin your reply with "${host}:". ${host} steps in as the meeting chair in ONE short, natural spoken sentence connecting what was just said back to the decision and asking ${this.human.name} by name (ending with a question mark "?") how they want to play this or if they want to lock a direction in — never prescribe an answer or mention this note.]`,
          );
          this.startTurn(false, false, undefined, undefined, undefined, undefined, true);
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
          this.startTurn(false, false, undefined, scheduledAt + baseMs, undefined, undefined, true);
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
          this.startTurn(false, false, undefined, undefined, undefined, undefined, true);
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
    prefetched?: PrefetchedReply,
    notBefore?: number,
    briefSpeakers?: string[],
    dispatchCue?: DispatchCue,
    nudge = false,
  ): void {
    if (this.closed || this.paused) return;
    const text = retry ? this.lastText : this.pending.join(' ').trim();
    this.pending = [];
    if (text.length === 0) return;
    if (!retry && this.human !== undefined && !text.startsWith('[') && isGuestProposal(text)) {
      const topic = this.currentItem()?.title;
      this.proposalsByTopic.set(topic, [...(this.proposalsByTopic.get(topic) ?? []), text]);
    }
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

    const shape = retry ? this.lastReplyShape :
      this.human !== undefined && !text.startsWith('[') && this.names.length > 2
        ? replyShapeForTurn(this.replyShapeIndex++,
          (this.proposalsByTopic.get(this.currentItem()?.title)?.length ?? 0) === 1 && isGuestProposal(text),
          this.replyShapeHistory)
        : undefined;
    if (!retry) {
      this.lastReplyShape = shape;
      if (shape !== undefined) this.replyShapeHistory.push(shape);
    }
    const reuse = prefetched !== undefined && !retry && !prefetched.controller.signal.aborted;
    const abort = reuse ? prefetched!.controller : new AbortController();
    const briefSpeakersForTurn = briefSpeakers ??
      (text.startsWith('[We just started') ? this.lastBriefSpeakers : undefined);
    if (briefSpeakers !== undefined) this.lastBriefSpeakers = briefSpeakers;
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
      startedAt: reuse ? prefetched!.startedAt : Date.now(),
      ...(notBefore === undefined ? {} : { notBefore }),
      ...(nudge ? { nudge: true } : {}),
      ...(nudge && note !== undefined ? { nudgeNote: note } : {}),
      forced,
      dispatchCue,
      recoveryRetry,
      shape,
      briefSpeaker: text.startsWith('[We just started') ? /Begin with "([^:]+):"/.exec(text)?.[1] : undefined,
      briefSpeakers: briefSpeakersForTurn,
      prefetchedStream: reuse ? this.prefetchedStream(prefetched!) : undefined,
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

  private startScripted(utterance: Utterance, onDone?: (spoken: boolean) => void): void {
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
      scriptedUtterance: utterance,
      onScriptedDone: onDone,
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
    // Sound alone (an echo, a cough, a noise) cannot be told from a voice. A model turn that has already
    // been heard is paused rather than thrown away, so its unsaid lines can carry on if no words follow.
    if (soundOnly && turn.scripted !== true && turn.spoken.length > 0) {
      this.holdTurn(turn);
      return;
    }
    if (turn.scripted === true) {
      if (soundOnly && turn.scriptedUtterance !== undefined) {
        const remaining = this.scriptedRemainder(turn);
        this.cutOff = true;
        this.pausedScripted = {
          utterance: { speaker: turn.scriptedUtterance.speaker, text: remaining },
          onDone: turn.onScriptedDone,
        };
        turn.onScriptedDone = undefined;
      }
    } else {
      if (turn.spoken.length === 0) this.unanswered = true;
      else if (soundOnly) {
        this.cutOff = true;
        this.cutOffSpeaker = turn.spoken.at(-1)?.utterance.speaker;
      }
    }
    turn.aborted = true;
    turn.held = false;
    const wake = turn.heldWake;
    turn.heldWake = undefined;
    wake?.();
    this.finalize(turn);
    this.turn = undefined;
    turn.abort.abort();
    turn.soundAbort.abort();
    this.gate.setAiAudible(false);
    // The visitor heard the room accept their decision before the reply was cut short: it still counts.
    if (reason !== 'agenda moved' && turn.settle !== undefined && turn.spoken.length > 0) this.lockDecision(turn.settle.followUp);
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
    if (turn.settle !== undefined && turn.spoken.length > 0) this.lockDecision(turn.settle.followUp);
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
    for (const entry of turn.spoken) this.shadowLineEnded(entry.shadowLineId, entry.complete);

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
        this.ports.log?.(`${turn.briefSpeaker !== undefined ? '[brief]' : '[question]'} ${utterance.speaker}: dropped a second question to the visitor this round: "${trimmed}"`);
        return;
      }
      // A brief is one short exchange: the fact speakers, at most two reacting colleagues, then the host's
      // single question to the visitor. The host closes it; nobody speaks after that.
      if (turn.briefSpeaker !== undefined) {
        const briefHost = aiHost ?? this.facilitatorOrCoHost();
        const briefSpeakers = new Set(turn.briefSpeakers ?? [turn.briefSpeaker]);
        const isFactSpeaker = briefSpeakers.has(utterance.speaker);
        const isHost = briefHost !== undefined && utterance.speaker === briefHost;
        const hostHasAsked = briefHost !== undefined && turn.enqueued.some((line) =>
          line.speaker === briefHost && isQuestionToVisitor(line.text, line.speaker, this.names, this.human?.name));
        if (turn.enqueued.length === 0 && !isFactSpeaker) {
          this.ports.log?.(`[brief] first speaker was ${utterance.speaker}, expected speaker ${turn.briefSpeaker}`);
        }
        if (hostHasAsked && !isHost) {
          this.ports.log?.(`[brief] dropped a line from ${utterance.speaker} after ${briefHost} closed the turn`);
          return;
        }
        if (!isFactSpeaker && !isHost) {
          const reactors = new Set(turn.enqueued
            .map((line) => line.speaker)
            .filter((speaker) => !briefSpeakers.has(speaker) && speaker !== briefHost));
          if (!reactors.has(utterance.speaker) && reactors.size >= 2) {
            this.ports.log?.(`[brief] dropped extra line from ${utterance.speaker}`);
            return;
          }
        }
      }
      if (aiHost !== undefined && utterance.speaker === aiHost && LOCK_ASK_RE.test(trimmed) &&
          Date.now() - this.lastLockAskAt < DEFAULT_REPEAT_WINDOW_MS) {
        this.ports.log?.(`[repeat] ${aiHost}: skipped a repeated lock-in ask`);
        return;
      }
      if (turn.shape !== undefined) {
        const maxSpeakers = turn.shape === 'solo' || turn.shape === 'reaction' ? 1 : 2;
        const speakers = new Set(turn.enqueued.map((line) => line.speaker));
        const maxSentences = turn.shape === 'reaction' ? 1 :
          turn.shape === 'solo' ? 2 : 1;
        if ((!speakers.has(utterance.speaker) && speakers.size >= maxSpeakers) ||
            turn.enqueued.filter((line) => line.speaker === utterance.speaker).length >= maxSentences) {
          this.ports.log?.(`[shape] dropped extra line from ${utterance.speaker}`);
          return;
        }
      }
      if (turn.settle !== undefined && /\?["')\]]*$/.test(trimmed)) {
        this.ports.log?.(`[settle] ${utterance.speaker}: dropped a new question after the visitor's call: "${trimmed}"`);
        return;
      }
      if (turn.dispatchCue?.cardPointer !== true && MODEL_CARD_MENTION_RE.test(trimmed)) {
        this.ports.log?.(`[card] ${utterance.speaker}: dropped a sentence that points at the card; the handoff line does that: "${trimmed}"`);
        return;
      }
      if (turn.dispatchCue?.cardPointer !== true && aiHost !== undefined && utterance.speaker === aiHost &&
          this.currentTopicHasVisitorFollowUp(turn) &&
          !namesColleague(trimmed, this.names) &&
          (HOST_SEND_PLACE_RE.test(trimmed) || (HOST_SEND_INSTRUCTION_RE.test(trimmed) &&
            (HOST_IMPERATIVE_START_RE.test(trimmed) || addressesVisitor(trimmed, this.human?.name))))) {
        this.ports.log?.(`[card] dropped host send-instruction: ${trimmed}`);
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
      const addressed = turn.forced?.target ?? addressedCharacter(this.lastText, cast);
      const host = cast.find((npc) => npc.role === 'host')?.attendee;
      const seatNames = this.options.scenario.attendees.map((attendee) => attendee.name);
      const parser = new TurnParser(this.names, turn.briefSpeaker ?? addressed ?? host, this.human?.name, seatNames,
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
      // The visitor's first idea on a topic is never accepted outright: the room names what works, then
      // the colleague whose cost is still open raises it from their facts and asks how to adapt.
      if (this.firstProposalOnTopic(turn, freshHumanLine)) {
        const currentLast = messages[messages.length - 1]!;
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[This is ${who}'s first idea on "${turn.topic}". Acknowledge what works in it, then have the colleague whose constraint is still open raise that catch from their own facts and ask ${who} how to adapt. Do not settle the item on this first idea.]`,
        };
      }
      // The Director itself decides whether this visitor line settles the topic.
      if (addressed !== undefined && last?.role === 'user' && turn.forced === undefined) {
        const currentLast = messages[messages.length - 1]!;
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[${who} is speaking directly to ${addressed}. Begin your reply with "${addressed}:". ${addressed} answers first, and nobody else speaks unless ${addressed} hands over by name. If ${who} only said ${addressed}'s name, ${addressed} just acknowledges and invites them to go on.]`,
        };
      }
      if (turn.shape !== undefined && addressed === undefined) {
        const currentLast = messages[messages.length - 1]!;
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[Reply shape for this turn: ${replyShapeInstruction(turn.shape)} Do not hand over to another colleague unless this shape calls for one. Do not mention this note.]`,
        };
      }
      let firstLine = '';
      let firstResolved = false;
      // Only a reply to something the visitor just said on this topic may settle it.
      let refuseReopen = false;
      const applyControl = (control: ReplyControl): void => {
        // A dispatch cue only asks or points; it must never settle or move the meeting.
        if (turn.dispatchCue !== undefined) {
          this.ports.log?.('[dispatch] ignored a control line in a task cue');
          return;
        }
        if (control.state === 'settled' && this.firstProposalOnTopic(turn, freshHumanLine)) {
          this.ports.log?.(`[settle] ignored settled on ${this.human?.name ?? 'the person'}'s first idea on "${turn.topic}"`);
          control = { ...control, state: 'open' };
        }
        if (control.reopen !== undefined) {
          const agenda = this.options.scenario.agenda;
          const actualIndex = agenda.findIndex((candidate) => candidate.title === (this.agendaItem ?? agenda[0]?.title));
          const earlier = agenda.findIndex((candidate) => candidate.title === control.reopen);
          if (this.memory.wasReopened(control.reopen)) {
            this.ports.log?.(`[control] dropped reopen: ${control.reopen} was already reopened`);
            if (freshHumanLine !== undefined) this.decisionLines = this.decisionLines.filter((line) => line !== freshHumanLine);
            refuseReopen = true;
            const host = this.facilitatorOrCoHost();
            if (host !== undefined) {
              const topicName = this.agendaItem === undefined ? 'this item' : spokenAgendaName(this.options.scenario, this.agendaItem);
              enqueue({ speaker: host, text: `Let's keep going with ${topicName}.` });
            }
            return;
          }
          if (this.concluded || earlier < 0 || earlier >= actualIndex ||
              !this.memory.snapshot().some((entry) => entry.kind === 'decision' && entry.item === control.reopen)) {
            this.ports.log?.(`[control] dropped reopen: title is not an earlier decided item in this meeting`);
          } else {
            this.resumeAfterReopen = { lines: this.decisionLines.filter((line) => line !== freshHumanLine),
              settled: this.humanSettledOnCurrentItem, wrapped: this.decisionWrappedUpOnItem };
            this.reopenedTitle = control.reopen;
            this.memory.markReopened(control.reopen);
            this.decisionLines = [];
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
        if (control.state !== 'open' && freshHumanLine !== undefined && this.decisionLines.length > 0) {
          turn.settle = { followUp: control.followUp };
        }
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
      const stream = turn.prefetchedStream ?? this.ports.stream(messages, signal);
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
        if (turn.briefSpeaker !== undefined && turn.enqueued.length >= 1 &&
            !turn.enqueued.some((line) => isQuestionToVisitor(line.text, line.speaker, this.names, this.human?.name))) {
          const who = this.human?.name ?? 'Everyone';
          const item = this.options.scenario.agenda.find((candidate) => candidate.title === turn.topic);
          const text = item?.decision === undefined
            ? this.nextGuestInvite(who, turn.topic)
            : `${who}, ${item.decision}`;
          enqueue({ speaker: this.facilitatorOrCoHost() ?? turn.briefSpeaker, text });
        }
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
    if (turn.settle !== undefined) this.lockDecision(turn.settle.followUp);
    this.turn = undefined;
    // A task cue is not an answer: no brief, hand-over, silence prompt or recovery cue follows it.
    if (turn.dispatchCue !== undefined) {
      this.gate.setAiAudible(false);
      this.finishDispatchCue(turn);
      this.ports.emitState(this.idleState());
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
    } else if (!briefing && !choseSilence && turn.spoken.length === 0 && turn.settle === undefined) {
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

  /** Wait `ms`, resolving early (and without a stray timer) when the turn aborts. */
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
      if (!restarting && !turn.scripted && !turn.replay) {
        const repeated = namesColleague(utterance.text, this.names) ? undefined :
          this.repeatsRecently(utterance.text, turn.startedAt);
        if (repeated !== undefined) {
          this.ports.log?.(`[repeat] ${utterance.speaker}: dropped a queued sentence already said by ${repeated.speaker}: "${utterance.text}"`);
          pending = undefined;
          continue;
        }
        if (isQuestionToVisitor(utterance.text, utterance.speaker, this.names, this.human?.name) && this.askedGuestInRound) {
          this.ports.log?.(`${turn.briefSpeaker !== undefined ? '[brief]' : '[question]'} ${utterance.speaker}: dropped a queued second question to the visitor this round: "${utterance.text}"`);
          pending = undefined;
          continue;
        }
      }
      const textOnly = audio === undefined;

      if (!restarting) {
        const gapMs = previousSpeaker === undefined ? 0 : previousSpeaker === utterance.speaker ? this.sentenceGapMs : this.speakerGapMs;
        if (gapMs > 0) {
          await this.wait(gapMs, turn.soundAbort.signal);
          if (turn.abort.signal.aborted) return;
          if (this.isTurnHeld(turn)) continue;
        }
        previousSpeaker = utterance.speaker;

        const entry: Turn['spoken'][number] = {
          utterance,
          complete: false,
          startedAt: Date.now(),
          durationMs: textOnly ? undefined : this.ports.clipDurationMs?.(audio),
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
        entry.shadowLineId = this.rememberSpoken(utterance, turn.topic ?? this.currentItem()?.title);
        this.noteCardPoint(utterance);
        this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker, canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
        const transcriptKey = `${utterance.speaker}:${utterance.text}`;
        if (transcribe && transcriptKey !== this.lastTranscriptEmit) {
          this.lastTranscriptEmit = transcriptKey;
          this.ports.emitTranscript(utterance.speaker, utterance.text, textOnly ? { textOnly: true } : undefined);
        }
        await this.playUtterance(turn, utterance, audio, textOnly);
        if (turn.abort.signal.aborted) {
          this.shadowLineEnded(entry.shadowLineId, false);
          return;
        }
        if (this.isTurnHeld(turn)) continue;
        entry.complete = true;
        this.shadowLineEnded(entry.shadowLineId, true);
        pending = undefined;
        if (turn.topic !== undefined) this.memory.spoken(this.reopenedTitle ?? turn.topic, utterance.text);
        continue;
      }

      // Restarting the cut sentence: it was already transcribed, accepted and counted; only replay its sound.
      last.startedAt = Date.now();
      last.durationMs = textOnly ? undefined : this.ports.clipDurationMs?.(audio);
      if (!textOnly) {
        this.gate.setAiAudible(true);
        this.gate.aiSaid(utterance.text);
      }
      this.lastSpoken = utterance.text;
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker, canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
      await this.playUtterance(turn, utterance, audio, textOnly);
      if (turn.abort.signal.aborted) {
        this.shadowLineEnded(last.shadowLineId, false);
        return;
      }
      if (this.isTurnHeld(turn)) continue;
      last.complete = true;
      this.shadowLineEnded(last.shadowLineId, true);
      pending = undefined;
      if (turn.topic !== undefined) this.memory.spoken(this.reopenedTitle ?? turn.topic, utterance.text);
    }
  }

  /** Play one sentence (or hold a text-only line up long enough to read), stopping early when the turn is cut. */
  private async playUtterance(
    turn: Turn,
    utterance: Utterance,
    audio: Clip | undefined,
    textOnly: boolean,
  ): Promise<void> {
    if (textOnly) {
      this.ports.log?.(`[tts] shown as text: ${utterance.speaker}`);
      await this.wait(this.textReadingMs(utterance.text), turn.soundAbort.signal);
      return;
    }
    try {
      await this.ports.play(utterance.speaker, audio as Clip, turn.soundAbort.signal);
    } catch (error) {
      if (!turn.abort.signal.aborted && turn.held !== true) {
        this.ports.log?.(`playback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
