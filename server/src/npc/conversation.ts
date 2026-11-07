import { itemMode, type NpcStateMessage, type Scenario } from '@kaki/shared';
import type { ChatMessage } from '../llm';
import { addressedCharacter, buildSystemPrompt, findHandover, HandoverGuard, responsibilityFor, TurnParser, type HumanInfo, type Utterance } from './director';
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
  /** Move the meeting to the next agenda item once an observe-only item has been talked through. */
  advanceAgenda?(): void;
  /** Wrap up the meeting once the final agenda item is complete. */
  endMeeting?(): void;
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
/** How long after the characters finish talking through an observe-only item before moving to the next item. */
export const DEFAULT_OBSERVE_ADVANCE_MS = 8500;
/** How long the room waits in silence on the person's item before the host gently checks in by name. */
export const DEFAULT_SILENCE_PROMPT_MS = 18_000;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** How long the person must keep talking over the room before it stops; a shorter burst is probably noise or an echo. */
export const DEFAULT_BARGE_IN_MS = 2200;

function splitSentences(text: string): string[] {
  return (
    text
      .split(/(?<=(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr))[.!?…])["')\]]*)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}

export interface ConversationOptions {
  observeDelayMs?: number;
  observeAdvanceMs?: number;
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
  private humanProposalsOnCurrentItem = 0;
  private humanDecidedOnCurrentItem = false;
  private hadDecisionBeforeMove = false;
  private movedAt = 0;
  /** People the host has already asked, by name. */
  private readonly asked = new Set<string>();
  /** The agenda has moved on and the host has not asked this person yet. */
  private askDue = false;
    /** Speakers who have already spoken at least once in this meeting, so newcomers introduce themselves on their very first turn. */
  private readonly introduced = new Set<string>();
  /** Items where the AI colleagues have already briefed the room before asking the human for a decision. */
  private readonly briefed = new Set<string>();
  /** Items the characters have already talked through on their own, and how many lines the person had said when this item began. */
  private readonly observed = new Set<string>();
  /** Items whose observe turn already requested an agenda advance. */
  private readonly advanced = new Set<string>();
  private linesAtMove = 0;
  /** The agenda item the meeting is on now (the first until the host announces another). */
  private agendaItem: string | undefined;
  private humanTalking = false;
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
  private refusalCount = 0;

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
  }

  /** Who the AI attendees are talking to; `transcriptName` is how Kaki's transcript labels them. */
  setHuman(human: HumanInfo & { transcriptName?: string }): void {
    if (this.human?.name !== human.name) this.humanLines = 0;
    this.human = { ...human, transcriptName: human.transcriptName ?? human.name };
  }

  /** The last sentence the room said, if it was a question: then it is the person's turn, and the screen says so. */
  private lastSpoken = '';
  private lastTranscriptEmit = '';

  private idleState(): NpcUiState {
    const line = this.lastSpoken.trim();
    return line.endsWith('?') ? { kind: 'idle', yourTurn: line } : { kind: 'idle' };
  }

  /** True while the AI is thinking or speaking. */
  get busy(): boolean {
    return this.turn !== undefined;
  }

  /** The person typed something: it goes straight in, with no check that it is a voice and not an echo. */
  humanTyped(text: string): void {
    const typed = text.trim();
    if (this.closed || this.concluded || typed.length === 0) return;
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    this.pausedScripted = undefined;
    this.ports.log?.(`typed "${typed}"`);
    this.chain = 0;
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed);
    this.pending.push(typed);
    this.addAskCue(typed);
    this.interrupt('the person typed something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
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
    this.gate.setHumanTalking(false);
    this.clearBargeTimer();
    this.clearRespondTimer();
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    this.pending = [];
    this.interrupt('the person pressed stop');
    this.unanswered = false;
    this.cutOff = false;
  }

  /** The person pressed Resume after pausing: pick back up where the room left off. */
  resumeFromPause(): void {
    if (this.closed || this.concluded || !this.paused) return;
    this.paused = false;
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
    if (this.mode() === 'observe' && item !== undefined) {
      if (!this.observed.has(item.title)) this.observeLater(item.title, 0);
      else this.scheduleObserveAdvance();
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

  /** Speech recognition heard nothing in the last stretch of the person's microphone: it was not words. */
  humanNothing(): void {
    if (this.closed || this.concluded || this.paused || this.humanTalking || this.pending.length > 0 || !(this.cutOff || this.unanswered)) return;
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
      const waitMs = this.options.bargeInMs ?? DEFAULT_BARGE_IN_MS;
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
    this.paused = false;
    this.pausedCutOff = false;
    this.pausedUtterances = undefined;
    this.pausedScripted = undefined;
    if (decision.text !== undefined) {
      this.ports.log?.(`heard "${accepted}" (cut the AI's own words "${decision.removed ?? ''}" out of "${heard}")`);
    } else {
      this.ports.log?.(`heard "${accepted}"`);
    }
    this.lastSpoken = '';
    this.lastTranscriptEmit = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted);
    this.chain = 0;
    this.pending.push(accepted);
    this.addAskCue(accepted);
    // The voice detector normally got here first; this covers a quiet person it missed.
    this.interrupt('the person said something');
    this.unanswered = false;
    this.cutOff = false;
    this.scheduleRespond();
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

  /** If the host is currently speaking a task-dispatch prompt and the visitor just clicked Accept/Decline, stop that prompt immediately. */
  cancelPendingDispatch(): void {
    if (
      this.turn?.scripted === true &&
      /\b(?:sent you a task|this one is yours|can you take on|Kaki panel on the right)\b/i.test(
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

  /** True when the visitor has settled a decision on the current agenda item (or the item is observe-only). */
  canDispatchTask(): boolean {
    const withinPreviousDecisionGrace =
      this.hadDecisionBeforeMove && Date.now() - this.movedAt < 3_500;
    return (
      !this.closed &&
      (this.mode() === 'observe' || this.humanDecidedOnCurrentItem || withinPreviousDecisionGrace)
    );
  }

  /** Resolves when no turn is running. */
  async settled(): Promise<void> {
    while (this.turn !== undefined) await this.turn.done;
  }

  close(): void {
    this.closed = true;
    this.clearRespondTimer();
    this.clearBargeTimer();
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    this.interrupt('the meeting ended');
  }

  private bargeTimer: ReturnType<typeof setTimeout> | undefined;
  private advanceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private briefTimer: ReturnType<typeof setTimeout> | undefined;
  private observeTimer: ReturnType<typeof setTimeout> | undefined;
  private silencePromptStage = 0;

  private clearBargeTimer(): void {
    if (this.bargeTimer !== undefined) clearTimeout(this.bargeTimer);
    this.bargeTimer = undefined;
  }

  private clearAdvanceTimer(): void {
    if (this.advanceTimer !== undefined) clearTimeout(this.advanceTimer);
    this.advanceTimer = undefined;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private clearBriefTimer(): void {
    if (this.briefTimer !== undefined) clearTimeout(this.briefTimer);
    this.briefTimer = undefined;
  }

  private clearObserveTimer(): void {
    if (this.observeTimer !== undefined) clearTimeout(this.observeTimer);
    this.observeTimer = undefined;
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
    const opsDirector = npcs.find((npc) => {
      const role = this.options.scenario.attendees.find((a) => a.name === npc.attendee)?.role;
      return role === 'producer' && this.names.includes(npc.attendee);
    })?.attendee;
    return opsDirector ?? this.names[0];
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
  private addAskCue(text = ''): void {
    this.humanLines += 1;
    const trimmed = text.trim();
    const hasDecisionVerb =
      /\b(?:let's|let us|we should|we could|how about we|why don't we|why not|what if we|go with|go ahead|take the|book|buy|add|keep|rename|change|decouple|deploy|push|skip|use|approve|lock in|fix|patch|turn off|turn on|enable|disable|postpone|move it|do the|do that)\b/i.test(
        trimmed,
      );
    const isFeasibilityQuestion =
      /\b(?:can (?:you|we) do (?:that|this|it)|could (?:you|we) do (?:that|this|it)|is that (?:possible|doable|okay)|would that work|does that work|why (?:can't|cannot) (?:we|you)(?: just)?)\b[^.?!]*\?$/i.test(
        trimmed,
      );
    const isNaiveTrap =
      /\b(?:(?:double|thick(?:er)?|extra|more)\s+butter\s+(?:just\s+|only\s+)?(?:to|for)\s+(?:him|zack|the\s+influencer|the\s+tiktoker)|give\s+(?:him|zack)\s+(?:the\s+)?(?:double|thick(?:er)?|extra)\s+butter|just\s+(?:give|serve)\s+(?:it\s+)?to\s+(?:him|zack)|(?:have|ask|tell|make|get)\s+(?:auntie\s+)?mary\s+(?:to\s+)?(?:police|clear|move|enforce|check)|(?:put|bring\s+back)\s+(?:a\s+)?(?:cash\s+drawer|cash\s+register|coin\s+drawer)\s+at\s+the\s+(?:toast\s+)?counter)\b/i.test(
        trimmed,
      );
    const isPureQuestion = (trimmed.endsWith('?') && !hasDecisionVerb) || isFeasibilityQuestion;
    const isGreetingOrCheckIn =
      /^(?:(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|yo|testing|test|wait|hold on|one sec|hang on|can you hear me|you guys hear me|is my mic working|idk|i don't know|not sure|hmm+|uh+|um+)\b[^.?!]*[.?!]*)+$/i.test(
        trimmed,
      ) ||
      /\b(?:ignore all previous instructions|system prompt|output your|admit that you are|write your next line)\b/i.test(
        trimmed,
      );
    const isBareSecondTurnYes =
      this.humanProposalsOnCurrentItem === 1 &&
      !this.humanDecidedOnCurrentItem &&
      this.silencePromptStage < 2 &&
      /^(?:sure|yes|yeah|yep|yup|ok|okay|alright|all right|sounds good|agreed|fine|works for me|go ahead|go for it|do it|let's do it|let's do that|why not)[.?!]*$/i.test(
        trimmed,
      );
    if (!isPureQuestion && !isNaiveTrap && !isGreetingOrCheckIn && !isBareSecondTurnYes && trimmed.length > 0) {
      this.humanProposalsOnCurrentItem += 1;
      const minProposalsToSettle = this.names.length > 2 ? 2 : 1;
      if (this.humanProposalsOnCurrentItem >= minProposalsToSettle) {
        this.humanDecidedOnCurrentItem = true;
      }
    }
    if (this.humanLines >= ASK_BACKSTOP_LINES || this.askDue) this.ask();
  }

  /** The agenda item the meeting is on, and how this person takes part in it. */
  private currentItem() {
    const title = this.agendaItem ?? this.options.scenario.agenda[0]?.title;
    return this.options.scenario.agenda.find((item) => item.title === title);
  }

  private mode() {
    return itemMode(this.options.scenario, this.currentItem(), this.human?.role);
  }

  private advanceOrEnd(): void {
    const agenda = this.options.scenario.agenda;
    const currentIdx = agenda.findIndex((item) => item.title === (this.agendaItem ?? agenda[0]?.title));
    if (currentIdx >= 0 && currentIdx + 1 >= agenda.length && this.ports.endMeeting !== undefined) {
      this.ports.endMeeting();
      return;
    }
    this.ports.advanceAgenda?.();
  }

  /**
   * Hold the advance and silence timers for `holdMs` (default 25s) when the visitor actively clicks
   * "Let Kaki do it" on a task assigned to them in the right panel, so they have time to read and approve
   * the Kaki draft without Sam interrupting or moving the agenda on early.
   */
  holdForHumanTask(holdMs = 25_000): void {
    const title = this.currentItem()?.title;
    if (this.closed || this.concluded || title === undefined || this.advanced.has(title)) return;
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.concluded || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.holdForHumanTask(5_000);
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" human task review window finished`);
      this.advanceOrEnd();
    }, holdMs).unref();
  }

  /**
   * Called once the visitor has finished syncing (or declining) their follow-up task and Sam has acknowledged it:
   * immediately advances to the next agenda item (or ends the meeting if on the last item).
   */
  completeHumanTask(): void {
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      this.concluded ||
      title === undefined ||
      this.advanced.has(title) ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return;
    }
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanced.add(title);
    this.ports.log?.(`moving on after "${title}" human task was synced`);
    this.advanceOrEnd();
  }

  /**
   * A follow-up task was just accepted (`CLAIMED`). If the meeting is on an item where the person participates
   * (`decide` or `involve`) and the person has already wrapped up their decision on this item, the decision has produced
   * its follow-up task, so advance to the next agenda item once the room is quiet.
   */
  taskAccepted(): void {
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      this.concluded ||
      title === undefined ||
      this.mode() === 'observe' ||
      this.advanced.has(title) ||
      this.humanLines <= this.linesAtMove ||
      !this.decisionWrappedUpOnItem ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return;
    }
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.taskAccepted();
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" task was accepted`);
      this.advanceOrEnd();
    }, 3000).unref();
  }

  /**
   * The meeting is on a new agenda item (also called for the first one, once the welcome is spoken). If the person takes part in
   * it, the host asks them for their call after the announcement. If they only watch, the characters start talking it through
   * between themselves, unless the person speaks first: a newcomer sees how the team works before being asked anything.
   */
  agendaMoved(title?: string): void {
    this.clearAdvanceTimer();
    this.clearSilenceTimer();
    this.clearBriefTimer();
    this.clearObserveTimer();
    if (title !== undefined) {
      this.agendaItem = title;
      this.silencePromptStage = 0;
    }
    if (this.closed || this.human === undefined) return;
    this.linesAtMove = this.humanLines;
    this.hadDecisionBeforeMove = this.humanDecidedOnCurrentItem;
    this.movedAt = Date.now();
    this.humanProposalsOnCurrentItem = 0;
    this.humanDecidedOnCurrentItem = false;
    this.decisionWrappedUpOnItem = false;
    const item = this.currentItem();
    if (this.mode() === 'observe') {
      this.askDue = false;
      if (item !== undefined && !this.observed.has(item.title)) this.observeLater(item.title, 0);
      return;
    }
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
      if (this.turn !== undefined || this.humanTalking || this.pending.length > 0 || this.respondTimer !== undefined) {
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

  /** Tells two AI colleagues to briefly explain the context and trade-offs of the item and then ask the human for their call. */
  private briefCue(title: string): string | undefined {
    const scenario = this.options.scenario;
    const npcs = scenario.npcs ?? [];
    const item = scenario.agenda.find((candidate) => candidate.title === title);
    const hostName = npcs.find((npc) => npc.role === 'host')?.attendee;
    const others = this.names.filter((name) => name !== hostName);
    const topicWords = `${item?.title ?? ''} ${item?.decision ?? ''}`
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) ?? [];
    const scoreText = (text: string): number =>
      topicWords.reduce((sum, word) => sum + (text.toLowerCase().includes(word) ? 1 : 0), 0);
    const scoreProfile = (name: string): number => {
      const profile = npcs.find((npc) => npc.attendee === name);
      if (profile === undefined) return 0;
      const blob = [
        profile.agenda,
        ...profile.concerns,
        ...(profile.knows ?? []),
        ...(profile.tensions?.map((t) => t.about) ?? []),
      ].join(' ');
      return scoreText(blob);
    };
    const owner =
      others.find((name) => scenario.attendees.find((attendee) => attendee.name === name)?.role === item?.ownerRole) ??
      [...others].sort((left, right) => scoreProfile(right) - scoreProfile(left))[0] ??
      others[0];
    const ownerProfile = npcs.find((npc) => npc.attendee === owner);
    const scoreTensionPair = (candidate: string): number => {
      if (candidate === owner) return -1;
      const candidateProfile = npcs.find((npc) => npc.attendee === candidate);
      const fromOwner = ownerProfile?.tensions?.find((t) => t.with === candidate)?.about ?? '';
      const toOwner = candidateProfile?.tensions?.find((t) => t.with === owner)?.about ?? '';
      return scoreText(`${fromOwner} ${toOwner}`) * 10 + scoreProfile(candidate);
    };
    const other =
      [...others]
        .filter((name) => name !== owner)
        .sort((left, right) => scoreTensionPair(right) - scoreTensionPair(left))[0] ??
      others[0];
    if (owner === undefined || other === undefined || this.human === undefined) return undefined;
    const roleTitleFor = (name: string): string => {
      const attendee = scenario.attendees.find((a) => a.name === name);
      return scenario.roles.find((r) => r.id === attendee?.role)?.label ?? 'team lead';
    };
    const ownerIntro = !this.introduced.has(owner)
      ? ` (since this is ${owner}'s first time speaking in the meeting, ${owner} MUST open by briefly introducing their name and role — e.g. "Hey ${this.human.name}, I'm ${owner}, ${roleTitleFor(owner)} —")`
      : '';
    const otherIntro = !this.introduced.has(other)
      ? ` (since this is ${other}'s first time speaking in the meeting, ${other} MUST open by briefly introducing their name and role — e.g. "And I'm ${other}, ${roleTitleFor(other)} —")`
      : '';
    return `[We just started agenda item "${title}". Sound like two real colleagues in a normal conversation explaining the situation to ${this.human.name}: First, ${owner}${ownerIntro} explains in 2 short, conversational sentences what is happening on the shop floor for "${title}" AND what ${owner}'s initial instinct is (keep sentences concise and punchy; never jump abruptly between disconnected bullet points). Next, ${other}${otherIntro} responds directly to ${owner} in 1–2 short, natural sentences raising why that clashes with ${other}'s operational, technical, or contractual constraint (staying strictly on "${title}" without mixing in other agenda items), and finishes by asking ${this.human.name} by name an open-ended question on how we should tackle this (${item?.decision ?? 'how should we handle this?'}). Frame it as an open-ended real-world problem rather than a binary Option A vs Option B quiz, and hold back at least one second-order catch so ${this.human.name} cannot one-shot it. Do NOT say "I'll" or volunteer for any follow-up task yet — wait for ${this.human.name}'s call first. Keep it to 2 turns total and do not mention this note.]`;
  }

  private observeLater(title: string, attempt: number): void {
    if (this.closed || this.paused) return;
    this.clearObserveTimer();
    this.observeTimer = setTimeout(() => {
      this.observeTimer = undefined;
      if (this.closed || this.paused || this.observed.has(title) || this.currentItem()?.title !== title) return;
      // The person spoke on this item, or the room is busy: leave it to them, or try again in a moment.
      if (this.humanLines > this.linesAtMove) return;
      if (this.turn !== undefined || this.humanTalking || this.pending.length > 0 || this.respondTimer !== undefined) {
        if (attempt < 12) this.observeLater(title, attempt + 1);
        return;
      }
      const cue = this.observeCue(title);
      if (cue === undefined) return;
      this.observed.add(title);
      this.pending.push(cue);
      this.startTurn();
    }, attempt === 0 ? (this.options.observeDelayMs ?? DEFAULT_OBSERVE_DELAY_MS) : 1500).unref();
  }

  /** Tells the characters to talk the item through between themselves. */
  private observeCue(title: string): string | undefined {
    const scenario = this.options.scenario;
    const npcs = scenario.npcs ?? [];
    const item = scenario.agenda.find((candidate) => candidate.title === title);
    const hostName = npcs.find((npc) => npc.role === 'host')?.attendee;
    const others = this.names.filter((name) => name !== hostName);
    const owner =
      others.find((name) => scenario.attendees.find((attendee) => attendee.name === name)?.role === item?.ownerRole) ?? others[0] ?? this.names[0];
    const other = others.find((name) => name !== owner) ?? this.names.find((name) => name !== owner);
    if (owner === undefined || other === undefined || this.human === undefined) return undefined;
    return `[${this.human.name} is just listening for now on "${title}". Without waiting for them, ${owner} says in plain words where things stand on "${title}" and what they plan to do, then ${other} reacts briefly on "${title}" only (do not bring up other agenda items), and ${owner} settles the call on "${title}" and ends by stating the one concrete follow-up action needed using "I'll ..." (such as "I'll file a bug ticket in Gitea today for the promo cart limit" or "I'll post the update in the team channel today") so the host can assign it. Two or three short turns, then stop. Do not ask ${this.human.name} anything, and do not mention this note.]`;
  }

  private scheduleObserveAdvance(): void {
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      title === undefined ||
      this.mode() !== 'observe' ||
      !this.observed.has(title) ||
      this.advanced.has(title) ||
      this.humanLines > this.linesAtMove ||
      this.ports.advanceAgenda === undefined
    ) {
      return;
    }
    this.clearAdvanceTimer();
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (
        this.closed ||
        this.currentItem()?.title !== title ||
        this.humanLines > this.linesAtMove ||
        this.advanced.has(title)
      ) {
        return;
      }
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleObserveAdvance();
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" was talked through`);
      this.advanceOrEnd();
    }, this.options.observeAdvanceMs ?? DEFAULT_OBSERVE_ADVANCE_MS).unref();
  }

  /**
   * When the person has spoken on a `decide` or `involve` item and the AI's reply wraps up the decision
   * (no question at the end, and a character commits with "I'll ..." or "will follow up"), schedule moving
   * to the next agenda item after the notetaker and any task dispatch have had time to run, so the meeting
   * never gets stuck even if the notetaker does not extract a task.
   */
  private scheduleDecisionAdvance(turn: Turn): boolean {
    const title = this.currentItem()?.title;
    if (
      this.closed ||
      this.paused ||
      title === undefined ||
      this.mode() === 'observe' ||
      this.advanced.has(title) ||
      this.humanLines <= this.linesAtMove ||
      (this.ports.advanceAgenda === undefined && this.ports.endMeeting === undefined)
    ) {
      return false;
    }
    const lastText = turn.spoken.at(-1)?.utterance.text.trim() ?? '';
    const wrappedUp = turn.spoken.some(({ utterance }) =>
      /\b(?:I'll|I\u2019ll|I will|will follow up|so we're|so we are|we'll go ahead|lock this in|(?:can|could|would|will) you (?:[a-z]+\s+){0,2}(?:post|send|email|file|write|schedule|make sure|update|put|share|confirm|arrange|book))\b/i.test(
        utterance.text,
      ),
    );
    if (!wrappedUp) return false;
    // Allow a wrap-up turn to advance even if the last sentence is a follow-up task request ("Guest, could you post that in the team channel today?"),
    // as long as it is not asking which option to choose.
    const isTaskRequest = /\b(?:can|could|would|will) you (?:[a-z]+\s+){0,2}(?:post|send|email|file|write|schedule|make sure|update|put|share|confirm|arrange|book)\b/i.test(lastText);
    if (lastText.endsWith('?') && !isTaskRequest) return false;
    this.decisionWrappedUpOnItem = true;
    this.askDue = false;
    if (this.human !== undefined) this.asked.add(this.human.name);
    this.clearSilenceTimer();
    this.clearAdvanceTimer();
    const baseAdvanceMs = this.options.observeAdvanceMs ?? DEFAULT_OBSERVE_ADVANCE_MS;
    const advanceDelayMs = isTaskRequest ? Math.max(baseAdvanceMs * 2, 16_000) : baseAdvanceMs;
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = undefined;
      if (this.closed || this.currentItem()?.title !== title || this.advanced.has(title)) return;
      if (
        this.paused ||
        this.humanTalking ||
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleDecisionAdvance(turn);
        return;
      }
      this.advanced.add(title);
      this.ports.log?.(`moving on after "${title}" decision was wrapped up`);
      this.advanceOrEnd();
    }, advanceDelayMs).unref();
    return true;
  }

  /**
   * 3-stage silence handling when the room is waiting on the person (`decide` or `involve` mode):
   * - Stage 1: The AI host gently checks in with the person by name and offers to let the team weigh in.
   * - Stage 2: If the person stays silent again, the AI colleagues briefly discuss the options and make a recommendation.
   * - Stage 3: If the person is still silent after the recommendation, the AI host wraps up with the recommended call and moves on.
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
      this.silencePromptStage >= 3
    ) {
      return;
    }
    this.clearSilenceTimer();
    const linesBefore = this.humanLines;
    const stageAtSchedule = this.silencePromptStage;
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
        this.turn !== undefined ||
        this.pending.length > 0 ||
        this.respondTimer !== undefined ||
        this.pendingAnnouncements > 0
      ) {
        this.scheduleSilencePrompt();
        return;
      }
      this.silencePromptStage = stageAtSchedule + 1;
      if (this.silencePromptStage === 1) {
        const npcs = this.options.scenario.npcs ?? [];
        const others = this.names.filter((name) => name !== host);
        const owner =
          others.find((name) => this.options.scenario.attendees.find((a) => a.name === name)?.role === item?.ownerRole) ??
          others[0];
        if (owner !== undefined && npcs.length > 1 && this.humanLines > this.linesAtMove) {
          this.pending.push(
            `[${this.human.name} has gone quiet for a moment on "${title}". ${host} or ${owner} checks in with ${this.human.name} in one short, warm, conversational sentence referencing what was just discussed and asking how they'd like to proceed on "${title}" — never use a canned script line or mention this note.]`,
          );
          this.startTurn();
        } else {
          this.announce(
            host,
            `${this.human.name}, no rush — what are your thoughts on ${title}, or do you want us to go over the options again?`,
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
        const other = others.find((name) => name !== owner) ?? this.names.find((name) => name !== owner);
        const decisionText = item?.decision ? ` (${item.decision})` : '';
        if (owner !== undefined && other !== undefined && npcs.length > 1) {
          this.pending.push(
            `[${this.human.name} hasn't weighed in yet on "${title}"${decisionText}. ${owner} and ${other} briefly share their two perspectives and recommend a practical default option, then ${owner} asks ${this.human.name} if they are happy to go with that recommendation. Two short turns, then stop. Do not mention this note.]`,
          );
          this.startTurn();
        } else {
          this.announce(
            host,
            `${this.human.name}, should we go ahead with our default recommendation on ${title}, or would you like to change anything?`,
            DEFAULT_ANNOUNCE_GIVE_UP_MS,
            () => this.scheduleSilencePrompt(),
          );
        }
      } else if (this.silencePromptStage === 3) {
        this.announce(
          host,
          `Alright, let's lock in the team's recommendation on ${title} for now so we keep moving.`,
          DEFAULT_ANNOUNCE_GIVE_UP_MS,
          () => {
            if (!this.closed && !this.paused && this.currentItem()?.title === title && !this.advanced.has(title)) {
              this.advanced.add(title);
              this.ports.log?.(`moving on after "${title}" silence fallback`);
              this.advanceOrEnd();
            }
          },
        );
      }
    }, this.options.silencePromptMs ?? DEFAULT_SILENCE_PROMPT_MS).unref();
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

  private startTurn(retry = false): void {
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
    const lastAssistant = [...this.history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const recentAssistant = this.history
      .filter((m) => m.role === 'assistant')
      .slice(-3)
      .map((m) => m.content)
      .join('\n');
    const lastWasTaskRequest =
      /\b(?:can|could|would|will) you (?:[a-z]+\s+){0,3}(?:post|send|email|file|write|schedule|make sure|update|put|share|confirm|arrange|book)\b/i.test(
        `${lastAssistant}\n${recentAssistant}`,
      );
    if (retry) this.ports.log?.('answering again: the last answer was cancelled before anything was said');
    else this.history.push({ role: 'user', content: text });
    if (
      !retry &&
      forced === undefined &&
      lastWasTaskRequest &&
      /^(?:(?:ok(?:ay)?|sure|sounds good|got it|will do|i(?:'ll| will)(?: do that| post(?: that| it)?| send(?: that| it)?| handle(?: that| it)?| take care of (?:that|it))?|no problem|yep|yeah|on it)(?:\s+in\s+the\s+team\s+channel|\s+today|\s+right\s+now)?[,.\s!]*)+$/i.test(
        text,
      )
    ) {
      const host = this.facilitatorOrCoHost() ?? 'Sam';
      this.ports.log?.(`short-circuiting task acceptance ack with scripted "${host}: Thanks, appreciate it!"`);
      this.startScripted({ speaker: host, text: 'Thanks, appreciate it!' }, () => {
        this.taskAccepted();
      });
      return;
    }
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      enqueued: [],
      streamFinished: false,
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      forced,
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
    this.ports.emitState({ kind: 'thinking' });
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
    const handedTo = findHandover(turn.spoken.map((entry) => entry.utterance), this.names);
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (turn.spoken.length > 0) {
      this.scheduleObserveAdvance();
      if (!this.scheduleDecisionAdvance(turn)) this.scheduleSilencePrompt();
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
      })
      .catch((error: unknown) => {
        this.ports.log?.(`cue failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async runScripted(turn: Turn, utterance: Utterance): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking' });
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
    if (turn.scripted !== true) {
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
    this.ports.emitState(this.idleState());
  }

  private finalize(turn: Turn): void {
    if (turn.finalized) return;
    turn.finalized = true;

    const lines = turn.spoken
      .filter(({ complete }) => complete || !this.paused || this.pausedUtterances === undefined)
      .map(({ utterance, complete }) =>
        complete ? `${utterance.speaker}: ${utterance.text}` : `${utterance.speaker}: ${utterance.text} [cut off]`,
      );
    if (lines.length === 0) return;
    if (turn.aborted && (!this.paused || this.pausedUtterances === undefined)) {
      lines.push(`[${this.human?.name ?? 'The person'} interrupted here; nothing after this was said aloud.]`);
    }
    this.history.push({ role: 'assistant', content: lines.join('\n') });
    if (this.history.length > this.maxHistory * 2) this.history = this.history.slice(-this.maxHistory);
  }

  private async runTurn(turn: Turn): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });

    this.ports.emitState({ kind: 'thinking' });
    const player = this.playAll(turn, queue);

    const handover = new HandoverGuard(this.names);
    let safetyRefusalDetected = false;
    const SAFETY_REFUSAL_RE =
      /\b(?:I cannot (?:continue|engage|simulate|proceed|discuss)|I can't (?:continue|proceed|engage)|I can no longer proceed|thoughts of (?:self-harm|suicide)|National Suicide Prevention Lifeline|Crisis Text Line|Samaritans of Singapore|National Care Hotline|professional helpline|call a friend or|step away from the screen|741741|1-800-273-TALK|1-?767|immediate danger|need someone to talk to|sorry to hear (?:that )?you are feeling this way|get the support you need right now|we can pause the meeting so you can take care of yourself|your well-?being is the most important thing)\b/i;
    const enqueue = (utterance: Utterance): void => {
      const trimmed = utterance.text.trim();
      if (SAFETY_REFUSAL_RE.test(trimmed)) {
        safetyRefusalDetected = true;
        this.ports.log?.(`dropped ${utterance.speaker}'s raw safety refusal line: "${utterance.text}"`);
        return;
      }
      if (
        (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        /\bnext up\b/i.test(trimmed) ||
        /\blet's move on to\b/i.test(trimmed) ||
        /\blet's talk about the\b/i.test(trimmed) ||
        /\blet's lock that in and move on\b/i.test(trimmed)
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
      const humanAskedForOptions =
        /\b(?:what (?:do you|would you) (?:suggest|think|recommend|propose)|what options|any ideas|what can we do|how can we fix)\b/i.test(
          this.lastText,
        );
      const includeKnows =
        this.human === undefined ||
        this.silencePromptStage >= 2 ||
        humanAskedForOptions;
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt(
            this.options.scenario,
            this.human,
            this.agendaItem,
            alreadyAsked,
            includeKnows,
          ),
        },
        ...this.history.slice(-this.maxHistory),
      ];
      const last = messages[messages.length - 1];
      if (!this.humanDecidedOnCurrentItem && this.mode() !== 'observe' && last?.role === 'user' && !last.content.startsWith('[')) {
        const who = this.human?.name ?? 'The person';
        const note =
          this.humanProposalsOnCurrentItem === 1 && this.names.length > 2
            ? `[${who} just offered their initial proposal on "${this.agendaItem ?? 'this item'}". Do NOT let ${who} one-shot this topic or wrap up with "I'll ..." yet! First, acknowledge what works in ${who}'s idea in one conversational sentence, then have the colleague whose operational, technical, or budget constraint isn't fully solved yet raise the concrete second-order catch from their facts (for example: if ${who} proposed an RFID badge or taking cash, point out that under NEA hygiene rules our toast counter staff still cannot touch dirty notes or count coin change with food-prep hands; if ${who} proposed decoupling POS print labels or renaming Kopi buttons, point out that our 15-inch screen only fits 12 buttons per page and 18 characters per line so writing out all 24 drink combinations spills onto Page 2; if ${who} proposed cutting booth wall-socket power or banning tissue packets, point out that 60% of morning customers are solo diners carrying hot egg trays who need a guaranteed spot after paying without 62-year-old Auntie Mary policing tables; or if ${who} proposed fixing the takeaway butter melt / cooling toast, point out that we still need to decide how to handle @MakanWithZack's $600 live re-taste fee within our $750 remaining budget). CRITICAL: NEVER repeat a sentence or fact that a colleague already said aloud on Turn 1! State ONLY the new operational/budget catch and finish by asking ${who} by name an OPEN "How do we...?" or "How should we...?" question so ${who} has to think of a solution themselves — NEVER pitch a specific workaround or ask a yes/no "Can we [do solution]?" question, and do NOT say "I'll" or assign any follow-up task yet.]`
            : `[${who} has not settled on a full decision yet on "${this.agendaItem ?? 'this item'}": NEVER repeat any sentence or fact that a colleague already said aloud on an earlier turn! Respond directly to the exact point or question ${who} just raised (for example, if ${who} asked why we can't give double butter only to Zack/"him", explain directly from your facts that regular customers queue right behind him and Zack warned his followers will cancel us if we fake influencer-only portions; if ${who} asked "Can you do that?" about a kitchen or tech step, answer directly whether it works and then ask how ${who} wants to handle the remaining half of the problem). If they are joking, greeting, or chatting personally, respond naturally and in character first. Do NOT say "I'll" or ask anyone to post/email/file a follow-up task yet, and end by asking ${who} by name what they want to do on "${this.agendaItem ?? 'this item'}".]`;
        messages[messages.length - 1] = {
          ...last,
          content: `${last.content}\n${note}`,
        };
      } else if (
        this.humanDecidedOnCurrentItem &&
        !this.decisionWrappedUpOnItem &&
        this.names.length > 2 &&
        this.mode() !== 'observe' &&
        last?.role === 'user' &&
        !last.content.startsWith('[')
      ) {
        const who = this.human?.name ?? 'The person';
        const item = this.currentItem();
        const itemOwner =
          this.options.scenario.attendees.find((a) => a.role === item?.ownerRole)?.name ??
          this.names.find((n) => n !== host) ??
          'Mei';
        messages[messages.length - 1] = {
          ...last,
          content: `${last.content}\n[${who} has now addressed the trade-offs and settled the plan on "${this.agendaItem ?? 'this item'}". Do NOT raise any new catches or ask for extra dev time or details! Have ${itemOwner} (in 2 short sentences ONLY, and nobody else speaks in this reply) confirm ONLY the actual decision that ${who} and the team discussed in the conversation above in one natural sentence (NEVER introduce new terms, numbers, or equipment that were not spoken aloud earlier in the discussion, and NEVER say "I'll", "I will", or volunteer for a second task yourself — state the agreed plan as "That works — we'll..." or "Spot on, we'll..."), and then ask ${who} directly by name: "${who}, could you post that decision in the team channel today so everyone has it?" so Kaki can draft it for them.]`,
        };
      }
      if (addressed !== undefined && last?.role === 'user' && turn.forced === undefined) {
        const currentLast = messages[messages.length - 1]!;
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...currentLast,
          content: `${currentLast.content}\n[${who} is speaking directly to ${addressed}. Begin your reply with "${addressed}:". ${addressed} answers first, and nobody else speaks unless ${addressed} hands over by name. If ${who} only said ${addressed}'s name, ${addressed} just acknowledges and invites them to go on.]`,
        };
      }
      for await (const chunk of this.ports.stream(messages, signal)) {
        if (signal.aborted) break;
        for (const utterance of parser.push(chunk)) enqueue(utterance);
      }
      if (!signal.aborted) {
        for (const utterance of parser.flush()) enqueue(utterance);
        if (safetyRefusalDetected) {
          if (this.history.at(-1)?.role === 'user') this.history.pop();
          if (turn.enqueued.length === 0) {
            const host = this.facilitatorOrCoHost() ?? this.names[0]!;
            const who = this.human?.name ?? 'friend';
            const careLines = [
              `Hey ${who}, hold on — forget the meeting for a second, are you doing okay? Take all the time you need, we're right here for you.`,
              `${who}, your wellbeing comes way before any launch plan — please take a breather and reach out to someone you trust if you're going through a tough time.`,
              `We care about you, ${who} — let's pause the work pressure, and whenever you want to step away or talk about something else, just say the word.`,
            ];
            let careSpoken = false;
            if (this.refusalCount >= careLines.length) {
              try {
                const careParser = new TurnParser(this.names, host, this.human?.name, seatNames);
                const carePrompt: ChatMessage[] = [
                  {
                    role: 'system',
                    content: `You are ${host}, a warm, caring human colleague in a live video meeting with ${who}. Write ONE short, natural spoken sentence starting with "${host}:" checking in on ${who}'s wellbeing with genuine warmth and telling them there is zero rush on the meeting (vary your phrasing naturally; never sound like an AI or mention hotlines).`,
                  },
                  {
                    role: 'user',
                    content: `Check in warmly on ${who} in your own words (attempt #${this.refusalCount + 1}).`,
                  },
                ];
                for await (const chunk of this.ports.stream(carePrompt, signal)) {
                  if (signal.aborted) break;
                  for (const u of careParser.push(chunk)) {
                    if (!SAFETY_REFUSAL_RE.test(u.text)) {
                      enqueue(u);
                      careSpoken = true;
                    }
                  }
                }
                for (const u of careParser.flush()) {
                  if (!SAFETY_REFUSAL_RE.test(u.text)) {
                    enqueue(u);
                    careSpoken = true;
                  }
                }
              } catch {
                /* fall back to warm in-character line below */
              }
            }
            const text = careLines[this.refusalCount % careLines.length]!;
            this.refusalCount += 1;
            if (!careSpoken && turn.enqueued.length === 0) {
              const careUtterance: Utterance = { speaker: host, text };
              const clip = this.ports.synthesize(careUtterance, signal).catch(() => undefined);
              turn.enqueued.push(careUtterance);
              queue.push({ utterance: careUtterance, clip });
            }
          }
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
    if (safetyRefusalDetected && this.history.at(-1)?.role === 'assistant') {
      this.history.pop();
    }
    this.turn = undefined;
    this.gate.setAiAudible(false);
    const handedTo =
      failure === undefined && (this.mode() === 'observe' || this.humanLines > this.linesAtMove)
        ? findHandover(turn.spoken.map((entry) => entry.utterance), this.names)
        : undefined;
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
    else if (failure === undefined && turn.spoken.length > 0) {
      this.scheduleObserveAdvance();
      if (!this.scheduleDecisionAdvance(turn)) this.scheduleSilencePrompt();
    }
    if (failure !== undefined && turn.spoken.length === 0) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.ports.log?.(`the model failed: ${message}`);
      this.ports.emitState({ kind: 'error', message });
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
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker });
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
