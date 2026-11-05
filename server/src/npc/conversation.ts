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
export const DEFAULT_ANNOUNCE_GIVE_UP_MS = 20_000;


/** The host asks when the agenda moves on; if that never happens, after this many lines from the person. */
export const ASK_BACKSTOP_LINES = 8;
/** How long after the host announces the next item before the question (the announcement is spoken first). */
export const DEFAULT_ASK_DELAY_MS = 3000;
/** How long after an item opens, with the person silent, before the characters start talking it through. */
export const DEFAULT_OBSERVE_DELAY_MS = 1500;
/** The question waits for a quiet moment; it is dropped if the room stays busy this long. */
const ASK_GIVE_UP_MS = 45_000;

/** How long the person must keep talking over the room before it stops; a shorter burst is probably noise or an echo. */
export const DEFAULT_BARGE_IN_MS = 900;

export interface ConversationOptions {
  observeDelayMs?: number;
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
  aborted: boolean;
  finalized: boolean;
  done: Promise<void>;
  startedAt: number;
  firstSentenceAt?: number;
  /** A line the Host was told to say (an opening, a time-out, a closing), not an answer to the person. */
  scripted?: boolean;
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
  /** Lines the person has said (heard or typed) since they joined; the host asks them for their decision after a few. */
  private humanLines = 0;
  /** People the host has already asked, by name. */
  private readonly asked = new Set<string>();
  /** The agenda has moved on and the host has not asked this person yet. */
  private askDue = false;
  /** Items the characters have already talked through on their own, and how many lines the person had said when this item began. */
  private readonly observed = new Set<string>();
  private linesAtMove = 0;
  /** The agenda item the meeting is on now (the first until the host announces another). */
  private agendaItem: string | undefined;
  private humanTalking = false;
  private respondTimer: ReturnType<typeof setTimeout> | undefined;
  private turn: Turn | undefined;
  private closed = false;
  /** Consecutive follow-up turns the AI started by itself after a hand-over; the person speaking again resets it. */
  private chain = 0;
  private forcedSpeaker: { target: string; from: string } | undefined;

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
    if (this.closed || typed.length === 0) return;
    this.ports.log?.(`typed "${typed}"`);
    this.chain = 0;
    this.lastSpoken = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', typed);
    this.pending.push(typed);
    this.addAskCue();
    this.interrupt('the person typed something');
    this.scheduleRespond();
  }

  /** The person pressed Stop: everyone goes quiet and nothing is picked up again until they say or type something. */
  stop(): void {
    if (this.closed) return;
    this.clearRespondTimer();
    this.pending = [];
    this.interrupt('the person pressed stop');
    this.unanswered = false;
    this.cutOff = false;
  }

  /** Speech recognition heard nothing in the last stretch of the person's microphone: it was not words. */
  humanNothing(): void {
    if (this.closed || this.humanTalking || this.pending.length > 0 || !(this.cutOff || this.unanswered)) return;
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.humanTalking || this.pending.length > 0) return;
      if (this.cutOff) this.resume();
      else if (this.unanswered) this.startTurn(true);
    }, DEFAULT_NOTHING_MS);
  }

  /** The person's microphone started or stopped carrying speech. */
  humanSpeech(talking: boolean): void {
    if (this.closed) return;
    if (talking === this.humanTalking) {
      // Should not happen: a start while already marked talking, with an answer running, means a stop was missed.
      if (talking && this.turn !== undefined) this.ports.log?.('ignored the person starting to talk: already marked as talking, a stop was missed');
      return;
    }
    this.humanTalking = talking;
    this.gate.setHumanTalking(talking);
    if (talking) {
      this.clearRespondTimer();
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
    if (this.closed || heard.length === 0) return;

    const decision = this.gate.check(heard);
    if (!decision.ok) {
      const mic = this.ports.describeMic?.();
      this.ports.log?.(`ignored "${heard}" (${decision.reason}${mic === undefined ? '' : `; ${mic}`})`);
      return;
    }

    const accepted = decision.text ?? heard;
    if (decision.text !== undefined) {
      this.ports.log?.(`heard "${accepted}" (cut the AI's own words "${decision.removed ?? ''}" out of "${heard}")`);
    } else {
      this.ports.log?.(`heard "${accepted}"`);
    }
    this.lastSpoken = '';
    this.ports.emitTranscript(this.human?.transcriptName ?? 'Guest', accepted);
    this.chain = 0;
    this.pending.push(accepted);
    this.addAskCue();
    // The voice detector normally got here first; this covers a quiet person it missed.
    this.interrupt('the person said something');
    this.scheduleRespond();
  }

  /**
   * The Host's spoken cue (opening, time-out, closing): `speaker` says `text` aloud, with no model call.
   * It waits for a quiet moment, so it never talks over the person or an answer, and is dropped if the
   * room stays busy for `giveUpMs`. It becomes a transcript line when it starts to play, like anything else a character says,
   * so the feed shows it in the order it is heard.
   * The person talking over it stops it, as with any other speech.
   */
  announce(speaker: string, text: string, giveUpMs = DEFAULT_ANNOUNCE_GIVE_UP_MS, onDone?: () => void): void {
    const line = text.trim();
    if (this.closed || line.length === 0 || !this.names.includes(speaker)) return;
    const deadline = Date.now() + giveUpMs;
    const attempt = (): void => {
      if (this.closed) return;
      const busy =
        this.humanTalking || this.turn !== undefined || this.pending.length > 0 || this.respondTimer !== undefined;
      if (!busy) {
        this.startScripted({ speaker, text: line });
        if (onDone !== undefined) void this.turn?.done.then(onDone);
      } else if (Date.now() >= deadline) {
        this.ports.log?.(`dropped ${speaker}'s cue "${line}": the room stayed busy`);
        onDone?.();
      } else {
        setTimeout(attempt, 500);
      }
    };
    attempt();
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
    this.clearRespondTimer();
    this.clearBargeTimer();
    this.interrupt('the meeting ended');
  }

  private bargeTimer: ReturnType<typeof setTimeout> | undefined;

  private clearBargeTimer(): void {
    if (this.bargeTimer !== undefined) clearTimeout(this.bargeTimer);
    this.bargeTimer = undefined;
  }

  private clearRespondTimer(): void {
    if (this.respondTimer !== undefined) clearTimeout(this.respondTimer);
    this.respondTimer = undefined;
  }

  private scheduleRespond(): void {
    if (this.humanTalking) return;
    if (this.pending.length === 0) {
      // The person cut in but no words came (a cough, a click, a word the recogniser missed): carry on.
      if (this.cutOff && !this.closed) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && this.cutOff && this.pending.length === 0) this.resume();
        }, this.resumeMs);
        return;
      }
      // Something cut the answer off (a cough, a click) and the person said nothing more: answer anyway.
      if (this.unanswered && !this.closed) {
        this.clearRespondTimer();
        this.respondTimer = setTimeout(() => {
          this.respondTimer = undefined;
          if (!this.humanTalking && !this.closed && this.unanswered && this.pending.length === 0) this.startTurn(true);
        }, this.retryMs);
      }
      return;
    }
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (!this.humanTalking && !this.closed) this.startTurn();
    }, this.responseDelayMs);
  }

  /**
   * The AI host asks a person directly, once, for the call their role owns: it comes when the meeting moves to the next
   * agenda item (`agendaMoved`), or, as a backstop, after many lines from them. It is a fixed line spoken by the host, not an
   * instruction to the model: a model given the instruction narrated it or put the role's words in another character's mouth.
   */
  private askLine(): string | undefined {
    const human = this.human;
    if (human === undefined || this.asked.has(human.name) || this.mode() === 'observe') return undefined;
    const host = (this.options.scenario.npcs ?? []).find((npc) => npc.role === 'host');
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
    const host = (this.options.scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
    if (line !== undefined && host !== undefined) this.announce(host, line, ASK_GIVE_UP_MS);
  }

  /** The person said another line: ask if they have talked a long time without being asked. */
  private addAskCue(): void {
    this.humanLines += 1;
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

  /**
   * The meeting is on a new agenda item (also called for the first one, once the welcome is spoken). If the person takes part in
   * it, the host asks them for their call after the announcement. If they only watch, the characters start talking it through
   * between themselves, unless the person speaks first: a newcomer sees how the team works before being asked anything.
   */
  agendaMoved(title?: string): void {
    if (title !== undefined) this.agendaItem = title;
    if (this.closed || this.human === undefined) return;
    this.linesAtMove = this.humanLines;
    const item = this.currentItem();
    if (this.mode() === 'observe') {
      this.askDue = false;
      if (item !== undefined && !this.observed.has(item.title)) this.observeLater(item.title, 0);
      return;
    }
    if (this.asked.has(this.human.name)) return;
    this.askDue = true;
    setTimeout(() => {
      if (!this.closed && this.askDue) this.ask();
    }, this.options.askDelayMs ?? DEFAULT_ASK_DELAY_MS).unref();
  }

  private observeLater(title: string, attempt: number): void {
    setTimeout(() => {
      if (this.closed || this.observed.has(title) || this.currentItem()?.title !== title) return;
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
    return `[${this.human.name} is just listening for now. Without waiting for them, ${owner} says in plain words where things stand on "${title}" and what it means for people, then ${other} adds the other side. Two or three short turns, then stop. Do not ask ${this.human.name} anything, and do not mention this note.]`;
  }

  /** A character handed over to another by name and nobody has answered yet: the named one answers, after a short pause. */
  private scheduleFollowUp(from: string, target: string): void {
    if (this.closed || this.chain >= MAX_FOLLOW_UPS) return;
    this.clearRespondTimer();
    this.respondTimer = setTimeout(() => {
      this.respondTimer = undefined;
      if (this.closed || this.humanTalking || this.pending.length > 0 || this.turn !== undefined) return;
      this.chain += 1;
      this.ports.log?.(`${from} handed over to ${target}: ${target} answers`);
      this.forcedSpeaker = { target, from };
      this.pending = [`[${from} handed over to ${target}. Begin your reply with "${target}:". ${target} answers now for their own side, briefly, and nobody else speaks.]`];
      this.startTurn();
    }, this.speakerGapMs);
  }

  private startTurn(retry = false): void {
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
    if (retry) this.ports.log?.('answering again: the last answer was cancelled before anything was said');
    else this.history.push({ role: 'user', content: text });
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
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

  private startScripted(utterance: Utterance): void {
    const turn: Turn = {
      abort: new AbortController(),
      spoken: [],
      aborted: false,
      finalized: false,
      done: Promise.resolve(),
      startedAt: Date.now(),
      scripted: true,
    };
    this.turn = turn;
    turn.done = this.runScripted(turn, utterance).catch((error: unknown) => {
      this.ports.log?.(`cue failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async runScripted(turn: Turn, utterance: Utterance): Promise<void> {
    const { signal } = turn.abort;
    const queue = new SentenceQueue<{ utterance: Utterance; clip: Promise<Clip | undefined> }>();
    signal.addEventListener('abort', () => queue.close(), { once: true });
    this.ports.emitState({ kind: 'thinking' });
    const player = this.playAll(turn, queue);
    const clip = this.ports.synthesize(utterance, signal).catch((error: unknown) => {
      if (!signal.aborted) {
        this.ports.log?.(`could not synthesize "${utterance.text}": ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    });
    queue.push({ utterance, clip });
    queue.close();
    await player;
    if (turn.aborted) return;
    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    this.ports.emitState(this.idleState());
  }

  /** Carry on from where the person cut in without saying anything. */
  private resume(): void {
    this.cutOff = false;
    const who = this.human?.name ?? 'The person';
    this.ports.log?.('the person cut in but said nothing recognisable: carrying on');
    this.lastText = `[${who} made a sound but said nothing. Carry on from where you were cut off, briefly, without mentioning it.]`;
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
      else if (reason === 'the person started talking') this.cutOff = true;
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

    const lines = turn.spoken.map(({ utterance, complete }) =>
      complete ? `${utterance.speaker}: ${utterance.text}` : `${utterance.speaker}: ${utterance.text} [cut off]`,
    );
    if (lines.length === 0) return;
    if (turn.aborted) {
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
    const enqueue = (utterance: Utterance): void => {
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
      queue.push({ utterance, clip });
    };

    let failure: unknown;
    try {
      const cast = this.options.scenario.npcs ?? [];
      const addressed = turn.forced?.target ?? addressedCharacter(this.lastText, cast);
      const host = cast.find((npc) => npc.role === 'host')?.attendee;
      const parser = new TurnParser(this.names, addressed ?? host, this.human?.name);
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(this.options.scenario, this.human, this.agendaItem) },
        ...this.history.slice(-this.maxHistory),
      ];
      const last = messages[messages.length - 1];
      if (addressed !== undefined && last?.role === 'user' && turn.forced === undefined) {
        const who = this.human?.name ?? 'The person';
        messages[messages.length - 1] = {
          ...last,
          content: `${last.content}\n[${who} is speaking directly to ${addressed}. Begin your reply with "${addressed}:". ${addressed} answers first, and nobody else speaks unless ${addressed} hands over by name. If ${who} only said ${addressed}'s name, ${addressed} just acknowledges and invites them to go on.]`,
        };
      }
      for await (const chunk of this.ports.stream(messages, signal)) {
        if (signal.aborted) break;
        for (const utterance of parser.push(chunk)) enqueue(utterance);
      }
      if (!signal.aborted) for (const utterance of parser.flush()) enqueue(utterance);
    } catch (error) {
      if (!signal.aborted) failure = error;
    }

    queue.close();
    await player;
    if (turn.aborted) return;

    this.finalize(turn);
    this.turn = undefined;
    this.gate.setAiAudible(false);
    const handedTo = failure === undefined ? findHandover(turn.spoken.map((entry) => entry.utterance), this.names) : undefined;
    if (handedTo !== undefined) this.scheduleFollowUp(handedTo.from, handedTo.target);
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
      turn.spoken.push(entry);
      this.gate.setAiAudible(true);
      this.gate.aiSaid(utterance.text);
      this.lastSpoken = utterance.text;
      this.ports.emitState({ kind: 'speaking', speaker: utterance.speaker });
      if (transcribe) this.ports.emitTranscript(utterance.speaker, utterance.text);

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
