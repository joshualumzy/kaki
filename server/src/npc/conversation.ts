import { itemMode, type ActionKind, type NpcStateMessage, type Scenario, type SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../llm';
import { cleanSpokenTopic } from '../host/opening';
import { addressedCharacter, buildSystemPrompt, findHandover, HandoverGuard, responsibilityFor, TurnParser, type HumanInfo, type Utterance } from './director';
import { couldBeReplyControlLine, isReplyControlLine, OPEN_REPLY_CONTROL, parseReplyControl, type ReplyControl } from './replyControl';
import { SpeechGate } from './speechGate';

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
  /** A line spoken in the meeting, for Kaki's transcript. */
  emitTranscript(speaker: string, text: string): void;
  /** What the AI attendees are doing, for the screen. */
  emitState(state: NpcUiState): void;
  log?(message: string): void;
  /** What the person's microphone has been hearing, to explain a refused phrase. */
  describeMic?(): string | undefined;
  /** Move the meeting to the next agenda item: the current one is settled and its follow-up is finished or timed out. */
  advanceAgenda?(): void;
  /** Wrap up the meeting once the final agenda item is complete. */
  endMeeting?(): void;
  /** A fact the Director picked to help the visitor right now, for their Wingman. */
  onWingmanTip?(tip: string, title: string): void;
  /** The visitor's decision on the current item is locked; `followUp` is the task that announces it. */
  settleTopic?(followUp: SuggestInput): void | Promise<void>;
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
export const DEFAULT_SILENCE_PROMPT_MS = 28_000;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** A topic still open after this many lines from the visitor, or this long, gets one offer from the host to lock in what they said. */
export const DEFAULT_TOPIC_TURN_BUDGET = 12;
export const DEFAULT_TOPIC_TIME_BUDGET_MS = 180_000;
/** How long the host waits for an answer to that offer before asking once more, and then before locking it in. */
export const DEFAULT_BUDGET_SILENCE_MS = 20_000;
/** How long a settled topic waits for the visitor's follow-up card with nothing happening on it before the host moves on. */
export const DEFAULT_REVIEW_WINDOW_MS = 90_000;
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

export interface ConversationOptions {
  topicTurnBudget?: number;
  topicTimeBudgetMs?: number;
  budgetSilenceMs?: number;
  reviewWindowMs?: number;
  openLiveGraceMs?: number;
  observeDelayMs?: number;
  silencePromptMs?: number;
  bargeInMs?: number;
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
  gate?: SpeechGate;
}

interface Turn {
  topic?: string;
  abort: AbortController;
  spoken: Array<{ utterance: Utterance; complete: boolean }>;
  enqueued: Utterance[];
  streamFinished: boolean;
  aborted: boolean;
  finalized: boolean;
  done: Promise<void>;
  startedAt: number;
  firstSentenceAt?: number;
  /** A line the Host was told to say (an opening, a time-out, a closing), not an answer to the person. */
  scripted?: boolean;
  scriptedUtterance?: Utterance;
  onScriptedDone?: (spoken: boolean) => void;
  /** A follow-up after a hand-over: this character answers first. */
  forced?: { target: string; from: string };
  /** This turn is the single retry after the model failed before saying anything. */
  recoveryRetry?: boolean;
  /** The Director marked this reply as settling the topic; it takes effect once the visitor has heard some of it. */
  settle?: { followUp?: { kind: ActionKind; title: string } };
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
  private humanSettledOnCurrentItem = false;
  private topicOpenedAt = Date.now();
  private budgetOffered = false;
  private budgetRecoveryPending = false;
  private budgetOfferAtLine = 0;
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private topicBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewWarned = false;
  private readonly topicTasks = new Map<string, Map<string, 'pending' | 'done'>>();
  /** People the host has already asked, by name. */
  private readonly asked = new Set<string>();
  /** The agenda has moved on and the host has not asked this person yet. */
  private askDue = false;
    /** Speakers who have already spoken at least once in this meeting, so newcomers introduce themselves on their very first turn. */
  private readonly introduced = new Set<string>();
  /** Items where the AI colleagues have already briefed the room before asking the human for a decision. */
  private readonly briefed = new Set<string>();
  /** Items the meeting has already been asked to leave. */
  private readonly advanced = new Set<string>();
  private linesAtMove = 0;
  /** The agenda item the meeting is on now (the first until the host announces another). */
  private agendaItem: string | undefined;
  private humanTalking = false;
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

  constructor(
    private readonly ports: NpcPorts<Clip>,
    private readonly options: ConversationOptions,
  ) {
    this.gate = options.gate ?? new SpeechGate();
    this.names = (options.scenario.npcs ?? []).map((npc) => npc.attendee);
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
  }

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
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed);
    this.pending.push(typed);
    this.noteHumanLine();
    this.decisionLines.push(typed);
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
    if (scripted !== undefined) {
      this.startScripted(scripted.utterance, scripted.onDone);
      return;
    }
    if (utterances !== undefined && utterances.length > 0) {
      this.startReplayTurn(utterances);
      return;
    }
    const item = this.currentItem();
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
    if (item !== undefined && this.names.length > 2 && !this.briefed.has(item.title)) {
      this.briefLater(item.title, 0);
      return;
    }
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
      }, 4_500);
      this.recognizingTimer.unref?.();
    }
  }

  /** Speech recognition heard nothing in the last stretch of the person's microphone: it was not words. */
  humanNothing(): void {
    this.humanRecognizing(false);
    if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0) return;
    if (!(this.cutOff || this.unanswered)) {
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
      if (this.turn === undefined) return;
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
    this.chain = 0;
    this.bridgedStatementOnTurn = false;
    this.clearSilenceTimer();
    this.pending.push(accepted);
    this.noteHumanLine();
    this.decisionLines.push(accepted);
    // The voice detector normally got here first; this covers a quiet person it missed.
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
    if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
      this.ports.log?.(`skipped ${speaker}'s cue "${line}": already handled`);
      onDone?.(false);
      return;
    }
    this.pendingAnnouncements += 1;
    let deadline = Date.now() + giveUpMs;
    const attempt = (): void => {
      if (this.closed) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        return;
      }
      if (shouldStillSpeak !== undefined && !shouldStillSpeak()) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        this.ports.log?.(`skipped ${speaker}'s cue "${line}": already handled`);
        onDone?.(false);
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
        this.startScripted({ speaker, text: line }, onDone);
      } else if (Date.now() >= deadline) {
        this.pendingAnnouncements = Math.max(0, this.pendingAnnouncements - 1);
        this.ports.log?.(`dropped ${speaker}'s cue "${line}": the room stayed busy`);
        onDone?.(false);
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
      /\b(?:sent you a task|this one is yours|can you take on|Kaki panel on the right|your screen on the right)\b/i.test(
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
    const turn: Turn = {
      abort: new AbortController(),
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
      const clip = this.ports.synthesize(item, signal).catch(() => undefined);
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
    if (this.respondTimer !== undefined) clearTimeout(this.respondTimer);
    this.respondTimer = undefined;
  }

  private scheduleRespond(): void {
    if (this.humanTalking || this.paused) return;
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
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (!this.humanTalking && !this.closed && !this.paused) this.startTurn();
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

  /** The person said another line: ask if they have talked a long time without being asked. */
  private noteHumanLine(): void {
    this.humanLines += 1;
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
    this.wingmanHintActive = false;
    this.clearSilenceTimer();
    this.clearBudgetTimer();
    const chosen = followUp ?? (item.followUp === undefined ? undefined : {
      kind: item.followUp.kind, title: item.followUp.hint,
    });
    const kind = chosen?.kind ?? 'mattermost_post';
    const title = chosen?.title ?? `Share the decision on ${item.title}`;
    const decision = this.decisionLines.join(' ');
    const input: SuggestInput = {
      title, context: `Agenda: ${item.title}. Visitor decision: ${decision}`,
      suggestedAssignee: role, actionKind: kind, agendaItemTitle: item.title,
      decisionSource: decision,
    };
    const succeeded = (): void => {
      if (this.closed || this.currentItem()?.title !== item.title) return;
      this.startReviewWindow();
      this.checkTopicAdvance();
    };
    const failed = (error: unknown): void => {
      this.ports.log?.(`ERROR: could not create follow-up for "${item.title}": ${String(error)}`);
      if (this.closed || this.currentItem()?.title !== item.title) return;
      this.humanSettledOnCurrentItem = false;
      this.decisionWrappedUpOnItem = false;
      this.clearReviewTimer();
      this.ports.emitState(this.idleState());
    };
    try {
      if (this.ports.settleTopic === undefined) throw new Error('No follow-up task port');
      const result = this.ports.settleTopic(input);
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
    this.budgetOffered = true;
    this.budgetOfferAtLine = this.humanLines;
    const host = this.facilitatorOrCoHost();
    if (host === undefined) return;
    const title = this.currentItem()?.title;
    this.announce(host, `${this.human?.name ?? 'You'}, shall we lock in what you've said on ${title ?? 'this topic'}?`,
      DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
        // Never heard: the offer is still owed, and the visitor's next line brings it back.
        if (!spoken) {
          this.budgetOffered = false;
          return;
        }
        this.clearBudgetTimer();
        this.budgetTimer = setTimeout(() => {
          if (this.currentItem()?.title !== title || this.humanSettledOnCurrentItem) return;
          this.announce(host, 'Shall I lock in what you’ve said now?',
            DEFAULT_ANNOUNCE_GIVE_UP_MS, (heard) => {
              if (!heard) {
                this.budgetOffered = false;
                return;
              }
              this.clearBudgetTimer();
              this.budgetTimer = setTimeout(() => {
                if (this.currentItem()?.title === title && this.humanLines === this.budgetOfferAtLine) this.lockDecision();
              }, this.options.budgetSilenceMs ?? DEFAULT_BUDGET_SILENCE_MS).unref();
            });
        }, this.options.budgetSilenceMs ?? DEFAULT_BUDGET_SILENCE_MS).unref();
      });
  }

  private startReviewWindow(): void {
    const title = this.currentItem()?.title;
    if (title === undefined || this.reviewTimer !== undefined) return;
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = undefined;
      if (this.currentItem()?.title !== title || this.reviewWarned) return;
      this.reviewWarned = true;
      const host = this.facilitatorOrCoHost();
      if (host === undefined) return;
      this.announce(host, `We need to move on from ${title} shortly. You can finish the follow-up from your card.`,
        DEFAULT_ANNOUNCE_GIVE_UP_MS, (spoken) => {
          if (spoken) this.checkTopicAdvance(true);
          else {
            this.reviewWarned = false;
            this.startReviewWindow();
          }
        });
    }, this.options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS).unref();
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
    if (this.paused || this.turn !== undefined || this.pendingAnnouncements > 0 || this.humanTalking) {
      this.reviewTimer = setTimeout(() => this.checkTopicAdvance(expired, afterGrace), 500).unref();
      return;
    }
    this.advanced.add(title);
    this.clearReviewTimer();
    if (expired) this.ports.log?.(`review window expired on "${title}"`);
    this.advanceOrEnd();
  }

  private clearReviewTimer(): void {
    if (this.reviewTimer !== undefined) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  /** The agenda item the meeting is on, and how this person takes part in it. */
  private currentItem() {
    const title = this.agendaItem ?? this.options.scenario.agenda[0]?.title;
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
    this.clearSilenceTimer();
    this.clearBriefTimer();
    if (title !== undefined) {
      const previousTitle = this.currentItem()?.title;
      const cleanTitle = cleanSpokenTopic(title).toLowerCase();
      const matched = this.options.scenario.agenda.find(
        (candidate) => candidate.title === title || cleanSpokenTopic(candidate.title).toLowerCase() === cleanTitle,
      );
      if (previousTitle !== undefined && previousTitle !== (matched?.title ?? title)) {
        this.interrupt('agenda moved');
      }
      this.agendaItem = matched?.title ?? title;
      this.silencePromptStage = 0;
      this.bridgedStatementOnTurn = false;
    }
    if (this.closed || this.human === undefined) return;
    this.linesAtMove = this.humanLines;
    this.humanSettledOnCurrentItem = false;
    this.wingmanHintActive = false;
    this.decisionLines = [];
    this.topicOpenedAt = Date.now();
    this.budgetOffered = false;
    this.budgetRecoveryPending = false;
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
      this.briefLater(item.title, 0);
      return;
    }
    if (this.asked.has(this.human.name)) return;
    this.askDue = true;
    setTimeout(() => {
      if (!this.closed && !this.paused && this.askDue) this.ask();
    }, this.options.askDelayMs ?? DEFAULT_ASK_DELAY_MS).unref();
  }

  private briefLater(title: string, attempt: number): void {
    if (this.closed || this.paused) return;
    this.clearBriefTimer();
    this.briefTimer = setTimeout(() => {
      this.briefTimer = undefined;
      if (this.closed || this.paused || this.briefed.has(title) || this.currentItem()?.title !== title) return;
      if (this.humanLines > this.linesAtMove) return;
      if (
        this.turn !== undefined ||
        this.humanTalking ||
        this.recognizingSpeech ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined
      ) {
        if (attempt < 12) this.briefLater(title, attempt + 1);
        return;
      }
      const cue = this.briefCue(title);
      if (cue === undefined) return;
      this.briefed.add(title);
      this.asked.add(this.human?.name ?? '');
      this.pending.push(cue);
      this.startTurn();
    }, attempt === 0 ? (this.options.observeDelayMs ?? DEFAULT_OBSERVE_DELAY_MS) : 1500).unref();
  }

  /** Brief the item from its own discussion, without assuming the owner is an AI seat. */
  private briefCue(title: string): string | undefined {
    const item = this.options.scenario.agenda.find((candidate) => candidate.title === title);
    const human = this.human;
    if (item === undefined || human === undefined) return undefined;
    const host = this.facilitatorOrCoHost();
    const seat = this.options.scenario.attendees.find((attendee) =>
      attendee.role === this.options.scenario.roles.find((role) => role.id === human.role || role.label === human.role)?.id)?.name;
    const candidates = [...new Set([
      ...(item.discussion?.openingViews ?? []).map((view) => view.attendee),
      ...(item.discussion?.tradeOffs ?? []).map((tradeOff) => tradeOff.attendee),
    ])].filter((name) => name !== seat && name !== host && this.names.includes(name));
    const speakers = [...candidates, ...this.names.filter((name) => name !== seat && name !== host && !candidates.includes(name))];
    const [first, second] = speakers;
    if (first === undefined || second === undefined) return undefined;
    const firstView = item.discussion?.openingViews.find((view) => view.attendee === first)?.view ??
      item.discussion?.tradeOffs.find((tradeOff) => tradeOff.attendee === first)?.tradeOff;
    const secondView = item.discussion?.openingViews.find((view) => view.attendee === second)?.view ??
      item.discussion?.tradeOffs.find((tradeOff) => tradeOff.attendee === second)?.tradeOff;
    const owns = seat !== undefined && this.options.scenario.attendees.find((attendee) => attendee.name === seat)?.role === item.ownerRole;
    const problem = item.briefing ??
      item.discussion?.openingViews.find((view) => view.attendee === seat)?.view ??
      item.decision ?? title;
    return `[We just started "${title}". First explain the problem in neutral terms using: "${problem}". ${first} explains their side from "${firstView ?? title}". ${second} responds from "${secondView ?? title}" and asks ${human.name} for a call. ${owns ? `${human.name} owns this topic and leads the decision.` : ''} Only these two colleagues speak; do not settle the topic for the visitor.]`;
  }

  /**
   * Gentle silence handling when the room is waiting on the person (`decide` or `involve` mode):
   * - Stage 1: After `silencePromptMs`, the AI host gently checks in with the person by name and invites them to share a thought or ask a question.
   * - Stage 2: If the person stays silent again, a colleague briefly summarizes the two plain-English directions on the table as a question — never solving the item for them or auto-advancing.
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
    const delayMs = shouldBridgeStatement ? Math.min(baseMs, 10_000) : baseMs;
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
          this.startTurn();
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
          const checkInContext = this.humanSettledOnCurrentItem
            ? `asking warmly if they are good with that follow-up plan or ready to move on to the next item`
            : this.decisionLines.length >= 1
              ? `checking in warmly on the open question the team just raised and asking how they'd like to play it`
              : `letting them know there is no rush and asking if they want a quick recap of the two options on the table`;
          this.pending.push(
            `[${this.human.name} is taking a moment to think on "${spokenTitle}". Begin your reply with "${host}:". ${host} checks in with ${this.human.name} in one short, warm, plain-English sentence ${checkInContext} — never prescribe an answer, never refer to "the right panel" or UI elements, and do not mention this note.]`,
          );
          this.startTurn();
        } else {
          this.announce(
            host,
            `${this.human.name}, no rush — what are your thoughts on ${spokenTitle}, or do you want us to go over the options again?`,
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
        const decisionText = item?.decision ? ` (${item.decision})` : '';
        if (owner !== undefined && npcs.length > 1) {
          this.forcedSpeaker = { target: owner, from: host };
          this.pending.push(
            `[${this.human.name} is still thinking on "${title}"${decisionText}. Begin your reply with "${owner}:". ${owner} speaks in ONE short, plain-English sentence offering two simple everyday directions ${this.human.name} could pick between as a helpful question — do NOT solve the trade-offs yourself, do NOT use technical jargon, and wait for ${this.human.name}'s answer. Do not mention this note.]`,
          );
          this.startTurn();
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

  private startTurn(retry = false, recoveryRetry = false): void {
    if (this.closed || this.paused) return;
    const text = retry ? this.lastText : this.pending.join(' ').trim();
    this.pending = [];
    if (text.length === 0) return;
    this.interrupt('a new turn started');
    const forced = this.forcedSpeaker;
    this.forcedSpeaker = undefined;
    this.unanswered = false;
    this.cutOff = false;
    this.lastText = text;

    // On a retry the question is already in the history.
    if (retry) {
      this.ports.log?.(
        recoveryRetry
          ? 'retrying the same request after the model said nothing'
          : 'answering again: the last answer was cancelled before anything was said',
      );
    } else {
      this.history.push({ role: 'user', content: text });
    }

    const turn: Turn = {
      topic: this.currentItem()?.title,
      abort: new AbortController(),
      spoken: [],
      enqueued: [],
      streamFinished: false,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      forced,
      recoveryRetry,
    };
    this.turn = turn;
    turn.done = this.runTurn(turn).catch((error: unknown) => {
      this.ports.log?.(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private startReplayTurn(utterances: Utterance[]): void {
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [...utterances],
      streamFinished: true,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
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
      const clip = this.ports.synthesize(utterance, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${utterance.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      queue.push({ utterance, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    const handedTo = findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name);
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (turn.spoken.length > 0) {
      this.scheduleSilencePrompt();
    }
    this.ports.emitState(this.idleState());
  }

  private startScripted(utterance: Utterance, onDone?: (spoken: boolean) => void): void {
    const turn: Turn = {
      abort: new AbortController(),
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
      const clip = this.ports.synthesize(item, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${item.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      queue.push({ utterance: item, clip });
    }
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
    if (this.lastSpoken.trim().endsWith('?') && turn.onScriptedDone === undefined) this.scheduleSilencePrompt();
  }

  /** Carry on from where the person cut in without saying anything. */
  private resume(): void {
    this.cutOff = false;
    const speaker = this.cutOffSpeaker;
    this.cutOffSpeaker = undefined;
    const scripted = this.pausedScripted;
    this.pausedScripted = undefined;
    if (scripted !== undefined) {
      this.ports.log?.('the person cut in but said nothing recognisable: carrying on scripted cue');
      this.startScripted(scripted.utterance, scripted.onDone);
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
    this.ports.log?.(`interrupted: ${reason}`);
    if (turn.scripted === true) {
      if (
        (reason === 'the person started talking' || reason === 'the person kept talking') &&
        turn.scriptedUtterance !== undefined
      ) {
        const allSentences = splitSentences(turn.scriptedUtterance.text);
        const completedCount = turn.spoken.filter((entry) => entry.complete).length;
        const remaining = allSentences.slice(completedCount).join(' ').trim();
        if (remaining.length > 0) {
          this.cutOff = true;
          this.pausedScripted = {
            utterance: { speaker: turn.scriptedUtterance.speaker, text: remaining },
            onDone: turn.onScriptedDone,
          };
          turn.onScriptedDone = undefined;
        }
      }
    } else {
      if (turn.spoken.length === 0) this.unanswered = true;
      else if (reason === 'the person started talking' || reason === 'the person kept talking') {
        this.cutOff = true;
        this.cutOffSpeaker = turn.spoken.at(-1)?.utterance.speaker;
      }
    }
    turn.aborted = true;
    this.finalize(turn);
    this.turn = undefined;
    turn.abort.abort();
    this.gate.setAiAudible(false);
    // The visitor heard the room accept their decision before the reply was cut short: it still counts.
    if (reason !== 'agenda moved' && turn.settle !== undefined && turn.spoken.length > 0) this.lockDecision(turn.settle.followUp);
    this.ports.emitState(this.idleState());
  }

  /**
   * When a colleague promises aloud to check Kaki or pull numbers and report back "in a minute" / "in two minutes",
   * schedule a real callback timer so that colleague genuinely chimes back in with the exact figures from their records!
   */
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
      const who = this.human?.name ?? 'everyone';
      this.forcedSpeaker = { target: speaker, from: speaker };
      this.pending.push(
        `[A minute has passed since ${speaker} promised to check Kaki / pull the figures on "${promisedTopic}". Begin your reply with "${speaker}:". ${speaker} briefly chimes back in to ${who} ("Hey ${who}, quick update — I just pulled those numbers from Kaki...") and shares the exact concrete figures from ${speaker}'s own facts in ONE short sentence, then lets the room continue without derailing the current topic. Do not mention this note.]`,
      );
      this.startTurn();
    };
    this.deferredFollowUpTimer = setTimeout(fire, delayMs);
    this.deferredFollowUpTimer.unref?.();
  }

  private finalize(turn: Turn): void {
    if (turn.finalized) return;
    turn.finalized = true;

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
    const who = this.human?.name;
    const line =
      who === undefined
        ? 'Sorry, I lost you for a second there — could you say that again?'
        : `Sorry, ${who}, I lost you for a second there — could you say that again?`;
    // A no-op completion keeps the silence-prompt timer from starting another model turn.
    this.announce(host, line, DEFAULT_ANNOUNCE_GIVE_UP_MS, () => undefined);
    return true;
  }

  private async runTurn(turn: Turn): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });

    this.ports.emitState({ kind: 'thinking', canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
    const player = this.playAll(turn, queue);

    const handover = new HandoverGuard(this.names, this.human?.name);
    const SAFETY_REFUSAL_RE = /^(?:sorry,?\s*)?i\s+(?:cannot|can't)\s+(?:continue|engage|proceed|help)\s+(?:(?:with|in)\s+)?(?:this|the)\s+(?:conversation|role-?play|simulation|request)[.!]?$/i;
    let heldRefusal: Utterance | undefined;
    const enqueue = (utterance: Utterance, allowRefusal = false): void => {
      let trimmed = utterance.text
        .replace(/\s*\[(?:cut off|[^\]]*interrupted here[^\]]*)\]\s*/gi, ' ')
        .replace(/^(?:from|on)\s+the\s+(?:menu|floor|kitchen|tech|pos|marketing|operations|ops|store)\s+side,\s*/i, '')
        .trim();
      if (trimmed.length === 0) return;
      if (trimmed !== utterance.text.trim()) {
        trimmed = trimmed[0]!.toUpperCase() + trimmed.slice(1);
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
      if (turn.firstSentenceAt === undefined) {
        turn.firstSentenceAt = Date.now();
        this.ports.log?.(`first sentence written ${turn.firstSentenceAt - turn.startedAt} ms after the model was asked`);
      }
      const clip = this.ports.synthesize(utterance, signal).catch((error: unknown) => {
        if (!signal.aborted) {
          this.ports.log?.(`could not synthesize "${utterance.text}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      });
      turn.enqueued.push(utterance);
      queue.push({ utterance, clip });
    };

    let failure: unknown;
    try {
      const cast = this.options.scenario.npcs ?? [];
      const addressed = turn.forced?.target ?? addressedCharacter(this.lastText, cast);
      const host = cast.find((npc) => npc.role === 'host')?.attendee;
      const seatNames = this.options.scenario.attendees.map((attendee) => attendee.name);
      const parser = new TurnParser(this.names, addressed ?? host, this.human?.name, seatNames);
      const alreadyAsked =
        this.human !== undefined && this.asked.has(this.human.name) && this.humanLines > this.linesAtMove;
      const includeKnows =
        this.human === undefined || this.humanLines > this.linesAtMove;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt(
            this.options.scenario,
            this.human,
            this.agendaItem,
            alreadyAsked,
            includeKnows,
            [...this.introduced],
          ),
        },
        ...this.history.slice(-this.maxHistory),
      ];
      const last = messages[messages.length - 1]!;
      const freshHumanLine = last.role === 'user' && !last.content.startsWith('[') ? last.content : undefined;
      // The Director itself decides whether this visitor line settles the topic.
      if (addressed !== undefined && last?.role === 'user' && turn.forced === undefined) {
        const currentLast = messages[messages.length - 1]!;
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[${who} is speaking directly to ${addressed}. Begin your reply with "${addressed}:". ${addressed} answers first, and nobody else speaks unless ${addressed} hands over by name. If ${who} only said ${addressed}'s name, ${addressed} just acknowledges and invites them to go on.]`,
        };
      }
      let firstLine = '';
      let firstResolved = false;
      // Only a reply to something the visitor just said on this topic may settle it.
      const applyControl = (control: ReplyControl): void => {
        const item = this.currentItem();
        if (control.wingmanNeeded) {
          this.wingmanHintActive = true;
          if (control.wingmanTip !== undefined && item !== undefined) this.ports.onWingmanTip?.(control.wingmanTip, item.title);
        }
        if (control.state !== 'open' && freshHumanLine !== undefined && this.decisionLines.length > 0) {
          turn.settle = { followUp: control.followUp };
        }
      };
      let speechBuffer = '';
      const feedSpeech = (speech: string): void => {
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
      for await (const chunk of this.ports.stream(messages, signal)) {
        if (signal.aborted) break;
        if (!firstResolved) {
          // Blank lines before the control line are not a first line.
          firstLine = (firstLine + chunk).trimStart();
          const newline = firstLine.indexOf('\n');
          if (newline < 0 && couldBeReplyControlLine(firstLine) && firstLine.length < 2048) continue;
          const head = newline < 0 ? firstLine : firstLine.slice(0, newline);
          applyControl(parseReplyControl(head.trim()) ?? OPEN_REPLY_CONTROL);
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
          else applyControl(parseReplyControl(firstLine.trim()) ?? OPEN_REPLY_CONTROL);
        }
        if (speechBuffer.trim().length > 0 && !isReplyControlLine(speechBuffer)) {
          for (const utterance of parser.push(speechBuffer)) enqueue(utterance);
        }
        for (const utterance of parser.flush()) enqueue(utterance);
        if (heldRefusal !== undefined) {
          this.ports.log?.('the model replied only with a refusal; asking the visitor to repeat the request');
          heldRefusal = undefined;
          enqueue({ speaker: this.facilitatorOrCoHost() ?? this.names[0]!, text: 'Sorry, could you say that again?' });
        }
        turn.streamFinished = true;
      }
    } catch (error) {
      if (!signal.aborted) failure = error;
    }

    queue.close();
    await player;
    if (turn.aborted) return;

    this.finalize(turn);
    if (turn.settle !== undefined) this.lockDecision(turn.settle.followUp);
    this.turn = undefined;
    if (this.budgetRecoveryPending && !this.humanSettledOnCurrentItem) {
      this.budgetRecoveryPending = false;
      this.offerBudgetLock();
    }
    this.gate.setAiAudible(false);
    const handedTo =
      failure === undefined
        ? findHandover(turn.spoken.map((entry) => entry.utterance), this.names, this.human?.name)
        : undefined;
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (failure === undefined && turn.spoken.length > 0) {
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
    if (failure !== undefined && turn.spoken.length === 0) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.ports.log?.(`the model failed: ${message}`);
      if (!this.recoverFromEmptyTurn(turn)) this.ports.emitState({ kind: 'error', message });
    } else {
      this.ports.emitState(this.idleState());
    }
  }

  private async playAll(
    turn: Turn,
    queue: SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>,
    transcribe = true,
  ): Promise<void> {
    const { signal } = turn.abort;
    let previousSpeaker: string | undefined;
    for await (const { utterance, clip } of queue) {
      const audio = await clip;
      if (signal.aborted) return;
      if (audio === undefined) continue;

      const gapMs = previousSpeaker === undefined ? 0 : previousSpeaker === utterance.speaker ? this.sentenceGapMs : this.speakerGapMs;
      if (gapMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, gapMs);
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (signal.aborted) return;
      }
      previousSpeaker = utterance.speaker;

      const entry = { utterance, complete: false };
      if (turn.spoken.length === 0) {
        this.ports.log?.(`speaking ${Date.now() - turn.startedAt} ms after the model was asked`);
      }
      this.ports.log?.(`${utterance.speaker}: ${utterance.text}`);
      this.introduced.add(utterance.speaker);
      turn.spoken.push(entry);
      this.gate.setAiAudible(true);
      this.gate.aiSaid(utterance.text);
      this.lastSpoken = utterance.text;
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker, canLock: this.decisionLines.length > 0 && !this.humanSettledOnCurrentItem });
      const transcriptKey = `${utterance.speaker}:${utterance.text}`;
      if (transcribe && transcriptKey !== this.lastTranscriptEmit) {
        this.lastTranscriptEmit = transcriptKey;
        this.ports.emitTranscript(utterance.speaker, utterance.text);
      }

      try {
        await this.ports.play(utterance.speaker, audio, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.ports.log?.(`playback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (signal.aborted) return;
      entry.complete = true;
    }
  }
}
