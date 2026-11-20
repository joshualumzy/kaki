import { randomUUID } from 'node:crypto';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import {
  aiCast,
  demoRoomName,
  humanAttendeeForRole,
  CONTROL_TOPIC,
  NPC_STATE_TOPIC,
  parseControlMessage,
  sameRunnerEpoch,
  STT_TOPIC,
  type NpcProfile,
  type NpcStateMessage,
  type RunnerMeetingSnapshot,
  type RunnerSnapshotVersion,
  type Scenario,
  type SuggestInput,
  type MeetingMemoryEntry,
} from '@kaki/shared';
import { OPENING_PREFIX, liveNextItemLine, liveOpeningLine, openingLine, spokenAgendaName } from '../host/opening';
import type { ChatMessage } from '../llm';
import { createRoomToken } from '../livekit';
import { visitorDispatchLine } from './cardPointer';
import { NpcConversation } from './conversation';
import { MeetingMemory } from './meetingMemory';
import { createRunnerMeeting } from './runnerMeeting';
import type { Utterance } from './director';
import { playPcm } from './playback';
import { PlaybackReference } from './reference';
import { UtteranceRecorder, type Recognizer } from './utterance';
import { EnergyVad, type VadOptions } from './vad';

/** Sample rate of everything published to and read from LiveKit. */
export const SAMPLE_RATE = 16000;

/**
 * After the AI stops, its sound keeps arriving at the person's microphone for as long as the
 * round trip takes (speakers, room, two network hops). The voice detector stays strict that long,
 * or the tail of the echo would be taken for the person talking.
 */
const GUARD_TAIL_MS = 1400;

/**
 * The longest a person's local Stop may outrank the server snapshot. The Stop is an instant speech
 * gate; the server owns the real pause and will publish a newer snapshot within a round trip. This
 * bound is only a safety net for a server that never answers, and is logged loudly when it fires.
 */
const STOP_GATE_TIMEOUT_MS = 5_000;

/**
 * The longest a typed line waits for the server to confirm the meeting resumed. The browser asks
 * the server to resume before sending the text; the runner holds it until a snapshot says running.
 */
const HELD_TYPED_LINE_TIMEOUT_MS = 10_000;

/**
 * While a local pause waits for a resume the person asked for, how often to re-read the server
 * snapshot. The normal answer is an event or a record; this only covers one that was lost.
 */
const RESUME_BACKSTOP_INTERVAL_MS = 2_000;

/** How long the resume backstop keeps re-reading before it gives up loudly. */
const RESUME_BACKSTOP_WINDOW_MS = 10_000;

/** True when two snapshots came from the same server incarnation at the same sequence. */
function sameVersion(a: RunnerSnapshotVersion, b: RunnerSnapshotVersion): boolean {
  return sameRunnerEpoch(a.epoch, b.epoch) && a.seq === b.seq;
}

export interface RunnerOptions {
  scenario: Scenario;
  livekitUrl: string;
  /** Defaults to the scenario's demo room. */
  roomName?: string;
  /** How long the person must keep talking over the AI before it stops (default 900 ms). */
  bargeInMs?: number;
  /** The Director's reply as it is written. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** The backup model, used for the one retry after a first sentence misses its deadline. */
  fallbackStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** A low-temperature stream for the guest-line reader; falls back to `stream` when absent. */
  readerStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** The backup reader stream; falls back to `fallbackStream` when absent. */
  readerFallbackStream?(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** A sentence as 16 kHz mono samples. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Int16Array>;
  /**
   * A line said in the meeting, under the name Kaki's transcript uses; `textOnly` marks a line shown as text because
   * its voice failed, `catchId` marks the last sentence of the line that raises a catch, and `lineId` lets a later
   * display update replace the same line.
   */
  postTranscript(
    speaker: string,
    text: string,
    options?: { textOnly?: boolean; catchId?: string; lineId?: string; gate?: 'lock-offer' },
  ): void;
  /** A display-only cut or restore of a line already posted, never recorded as another spoken line. */
  postTranscriptUpdate(speaker: string, text: string, options: { lineId: string; cut: boolean }): void;
  /**
   * Forward speech that only the server-side recogniser heard to Kaki's one transcript writer.
   * The app server resolves the speaker from the seat, so no client-chosen name is trusted.
   */
  postHumanLine?(line: {
    meetingId: string;
    participantIdentity: string;
    seat: string;
    text: string;
    source: 'speech' | 'typed';
    clientLineId: string;
  }): void;
  responseDelayMs?: number;
  /** Called when the last person has left the room (not when the room was empty to begin with). */
  onRoomEmpty?: () => void;
  /** Called when an observe-only agenda item has been talked through and the meeting should move on. */
  onAdvanceAgenda?: () => void;
  /** Called when the final agenda item has wrapped up and the meeting should conclude. */
  onEndMeeting?: () => void;
  /** How long a person's local Stop may outrank the server snapshot (default 5000 ms, safety only). */
  stopGateTimeoutMs?: number;
  /** How long a typed line waits for the server to resume before it is dropped (default 10000 ms). */
  heldTypedLineTimeoutMs?: number;
  /** How often the resume backstop re-reads the server state (default 2000 ms). */
  resumeBackstopIntervalMs?: number;
  /** How long the resume backstop keeps re-reading before it gives up loudly (default 10000 ms). */
  resumeBackstopWindowMs?: number;
  /**
   * Ask the meeting sync to re-read the server snapshot through its fence. The runner calls this
   * while a local pause is waiting for a resume, so a lost snapshot cannot silence the AI.
   */
  recheckMeetingState?(reason: string): void;
  /** Log something that needs attention (the resume backstop gave up); defaults to `log`. */
  logError?(message: string): void;
  /** Pause between one character and the next. */
  speakerGapMs?: number;
  /** Pause between two sentences of the same speaker. */
  sentenceGapMs?: number;
  /** Recognise the person's speech on the server, from their echo-cancelled microphone track; without it, the browser's recognition is used. */
  recognizer?: Recognizer;
  /** Receives each stretch of audio sent to the recogniser, to save it for listening. */
  debugAudio?(samples: Int16Array): void;
  vad?: Partial<VadOptions>;
  log?(message: string): void;
  /** Log the voice detector's levels twice a second while the AI talks, for tuning. */
  traceVad?: boolean;
  /** The connection to LiveKit was lost; the runner is no longer usable. */
  onDisconnected?(): void;
  /** The server's snapshot already known at boot (used when the pack had no AI cast yet). */
  initialMeeting?: RunnerMeetingSnapshot;
  /** Emit a live 1-sentence Wingman coaching brief for the current agenda item when the visitor's turn updates the discussion state. */
  onWingmanTip?(tip: string, title: string, agendaIndex: number): void;
  /** The visitor's decision on the current item is locked; `followUp` is the task that announces it. */
  onTopicSettled?(followUp: SuggestInput, reopened?: boolean): void | Promise<void>;
  onMemoryChange?(entries: MeetingMemoryEntry[]): void;
  onReaction?(who: string, emoji: string): void;
}

/** Where a restored server says this meeting already is when the runner is asked to open it. */
export interface RunnerStartState {
  agendaIndex?: number;
  /** True when the server restored a saved meeting: resume its item, never replay the welcome. */
  resumed?: boolean;
}

/** The server's request to initialize the cast for one Start attempt, before the meeting opens. */
export interface RunnerPrepareRequest extends RunnerStartState {
  /** The meeting this attempt belongs to; a different id means the old meeting is gone. */
  meetingId: string;
  /** Unique per attempt, echoed in the ready acknowledgement. */
  attempt: string;
  /** The server's meeting snapshot at prepare time, so the cast and sealed agenda come from one source. */
  snapshot?: RunnerMeetingSnapshot;
}

export interface NpcRunner {
  /**
   * The host character says `text` aloud when the person is in the room and it is quiet (dropped if nobody is there).
   * `onDone` runs when it has been said (`true`) or given up on (`false`); it is not called when the cue is ignored outright.
   */
  announce(text: string, onDone?: (spoken: boolean) => void, shouldStillSpeak?: () => boolean): void;
  /** The meeting moved to the next agenda item: the AI host will ask the person for the decision they own. */
  agendaMoved(title?: string): void;
  taskStatus(id: string, origin: string | undefined, status: string, isVisitorTask: boolean, declined?: boolean): void;
  /** Cancel a queued or running task-dispatch announcement when the visitor already clicked Accept or Decline. */
  cancelPendingDispatch(originAgendaTitle?: string | null): void;
  /** True when `title` names the item the meeting is on now. */
  onCurrentAgenda(title: string | undefined): boolean;
  /** The current human visitor's display name, if someone is in the room. */
  visitorName(): string | undefined;
  visitorRole(): string | undefined;
  /** True when `attendee` is voiced by the AI right now (not when a person took that seat). */
  plays(attendee: string): boolean;
  /** True when `attendee` volunteered for the follow-up in their own line at any point on this topic. */
  volunteeredOnTopic(attendee: string): boolean;
  /** True when the visitor already gave `attendee` a follow-up at any point on this topic. */
  askedByGuestOnTopic(attendee: string): boolean;
  /** True while a person sits in the host's seat: the AI host stays silent and the host's cues are only suggestions. */
  hostIsHuman(): boolean;
  /** The AI host's spoken name in the current meeting, when it has one. */
  hostName(): string | undefined;
  /** The TTS voice for an attendee in the current cast, when known. */
  voiceFor(attendee: string): string | undefined;
  /** `attendee` says `text` aloud once it is quiet; `onDone` runs when they finish or the line is dropped. */
  say(attendee: string, text: string, onDone?: () => void): void;
  /**
   * Sam asks an AI colleague to take on a task from `note`, through the model, once it is quiet.
   * `onDone(true)` means the room heard the ask; `false` means it was skipped and no template is read.
   */
  askColleague(
    target: string,
    note: string,
    options?: {
      /** The task title the spoken line must never carry. */
      forbiddenText?: string;
      shouldStillSpeak?: () => boolean;
      onDone?: (spoken: boolean) => void;
    },
  ): void;
  /** Sam points the visitor at their follow-up card from `note`, once per topic. */
  pointAtCard(
    note: string,
    options?: {
      /** The task title the spoken line must never carry. */
      forbiddenText?: string;
      shouldStillSpeak?: () => boolean;
      onDone?: (spoken: boolean) => void;
    },
  ): void;
  /**
   * The server's Start: open the meeting once, whoever asked. A second call is a no-op.
   * Resolves only after the cast and first topic are ready (or rejects if opening failed), so the
   * server can confirm the AI attendees really opened the meeting before telling the guest so.
   * `agendaIndex`/`resumed` let a restored runner pick up the saved item without a second welcome.
   * `meetingId` fences a stale start: a start for another meeting is refused instead of opening this one.
   */
  markStarted(state?: RunnerStartState & { meetingId?: string }): Promise<void>;
  /** The server meeting this runner currently belongs to, or undefined before it has heard one. */
  meetingId(): string | undefined;
  /** True when this runner prepared exactly this meeting and the server has not opened it yet. */
  wasPreparedFor(meetingId: string): boolean;
  /**
   * Server Start, step one: initialize the cast for `meetingId` without speaking or starting the meeting.
   * Resolves once the runner is genuinely ready for the server to commit Start.
   */
  prepareMeeting(request: RunnerPrepareRequest): Promise<void>;
  /**
   * Align with the server's state after a reconnect: a different meeting id clears the local start,
   * topic and welcome; a running meeting resumes at its item without opening again.
   * `currentConnection` proves a new server epoch arrived on the live service connection.
   * Returns true when a newer version was adopted.
   */
  reconcileMeeting(state: RunnerMeetingSnapshot, options?: { currentConnection?: boolean; authoritative?: boolean }): boolean;
  /** Pause the current conversation (for example when the meeting ends). */
  pause(): void;
  /** Interrupt any running AI turn, speak the closing line from the host, and then keep the conversation stopped. */
  announceClosing(text: string): void;
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
  /** Start a fresh meeting after the server's MEETING_RESET: close the conversation and forget the welcome. */
  resetMeeting(meetingId?: string): void;
}

export { visitorDispatchLine } from './cardPointer';

interface Character {
  room: Room;
  source: AudioSource;
}

/**
 * Runs the AI attendees of the live demo meeting: joins the LiveKit room once per character,
 * listens to the person, and answers in the characters' voices. The decisions live in
 * `NpcConversation`; this connects it to LiveKit and to whatever speech and model it is given.
 */
export async function startNpcRunner(options: RunnerOptions): Promise<NpcRunner> {
  const { scenario: bootScenario, livekitUrl } = options;
  const log = options.log ?? (() => undefined);
  const logError = options.logError ?? log;
  // Everything that can change during the meeting is read from this one snapshot. The boot pack
  // only supplies what a snapshot does not carry (organisation, attendees, knowledge).
  const meeting = createRunnerMeeting(bootScenario, options.initialMeeting, log);
  const memory = new MeetingMemory(meeting.scenario(), (entries) => options.onMemoryChange?.(entries), log);
  const bootCast = meeting.cast();
  if (bootCast.length === 0) {
    throw new Error(
      `Scenario "${bootScenario.id}" has no AI cast yet, so there is nobody to run. ` +
        'Wait for the server to publish a meeting with an AI seat, then start the runner.',
    );
  }
  // Characters nobody can play stay in the room and listen; the rest join for the person who arrives,
  // as everyone except the seat that person took. The listener is a fixed technical seat for this
  // process; a cast change never moves it.
  const alwaysAi = aiCast(meeting.scenario());
  const hostProfile = meeting.scenario().npcs?.find((npc) => npc.role === 'host');
  const listenerProfile = alwaysAi[0] ?? hostProfile ?? bootCast[0]!;
  const permanent = alwaysAi.length > 0 ? alwaysAi : [listenerProfile];
  const roomName = options.roomName ?? demoRoomName(bootScenario);

  // --- Characters join the room one by one, each publishing its own microphone track. ---
  const characters = new Map<string, Character>();
  const leaveAll = (): Promise<unknown> =>
    Promise.all([...characters.values()].map(({ room }) => room.disconnect().catch(() => undefined)));

  async function joinCharacter(npc: NpcProfile): Promise<void> {
    if (characters.has(npc.attendee)) return;
    const token = await createRoomToken({ roomName, participantName: npc.attendee, participantRole: 'AI attendee' });
    const room = new Room();
    try {
      await room.connect(livekitUrl, token);
    } catch (error) {
      throw new Error(
        `Could not connect ${npc.attendee} to LiveKit at ${livekitUrl} (${String(error) || 'no reason given'}). ` +
          'Is it running? Start it with "npm run stack:up", or set LIVEKIT_URL.',
        { cause: error },
      );
    }
    const source = new AudioSource(SAMPLE_RATE, 1, 400);
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    characters.set(npc.attendee, { room, source });
    log(`${npc.attendee} joined ${roomName}`);
  }

  try {
    for (const npc of permanent) await joinCharacter(npc);
  } catch (error) {
    await leaveAll();
    throw error;
  }
  const listener = characters.get(listenerProfile.attendee) as Character;

  // --- What the AI attendees send out: state to the browser, transcript lines to Kaki. ---
  let lastConversationState: NpcStateMessage = { kind: 'idle' };
  let sustainedHumanSpeaking = false;
  let humanTranscribing = false;
  let humanSpeakingTimer: ReturnType<typeof setTimeout> | undefined;
  const HUMAN_SPEAKING_BADGE_MS = 350;

  function publishState(state: NpcStateMessage): void {
    const decorated: NpcStateMessage =
      state.kind === 'idle' || state.kind === 'thinking' || state.kind === 'speaking'
        ? {
            ...state,
            ...(sustainedHumanSpeaking ? { humanSpeaking: true } : {}),
            ...(humanTranscribing ? { transcribing: true } : {}),
          }
        : state;
    const data = new TextEncoder().encode(JSON.stringify(decorated));
    listener.room.localParticipant?.publishData(data, { reliable: true, topic: NPC_STATE_TOPIC }).catch(() => undefined);
  }

  function syncHumanMicState(anyTalking: boolean): void {
    if (anyTalking) {
      if (!sustainedHumanSpeaking && humanSpeakingTimer === undefined) {
        humanSpeakingTimer = setTimeout(() => {
          humanSpeakingTimer = undefined;
          if (talking.size > 0 && !sustainedHumanSpeaking) {
            sustainedHumanSpeaking = true;
            publishState(lastConversationState);
          }
        }, HUMAN_SPEAKING_BADGE_MS);
      }
    } else {
      if (humanSpeakingTimer !== undefined) {
        clearTimeout(humanSpeakingTimer);
        humanSpeakingTimer = undefined;
      }
      if (sustainedHumanSpeaking) {
        sustainedHumanSpeaking = false;
        publishState(lastConversationState);
      }
    }
  }

  // What the AI plays, so the voice detectors can tell how much of it their microphone hears.
  const reference = new PlaybackReference();
  const vads = new Map<string, EnergyVad>();
  const talking = new Set<string>();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;

  /** While the AI is audible, and while its echo can still be arriving, the detector is stricter. */
  function setGuard(on: boolean): void {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    const apply = (): void => {
      for (const vad of vads.values()) vad.guarded = on;
    };
    if (on) apply();
    else guardTimer = setTimeout(apply, GUARD_TAIL_MS);
  }

  function makeConversation(cast: NpcProfile[]): NpcConversation<Int16Array> {
    return new NpcConversation<Int16Array>(
      {
        stream: options.stream,
        ...(options.fallbackStream === undefined ? {} : { fallbackStream: options.fallbackStream }),
        ...(options.readerStream === undefined ? {} : { readerStream: options.readerStream }),
        ...(options.readerFallbackStream === undefined ? {} : { readerFallbackStream: options.readerFallbackStream }),
        synthesize: options.synthesize,
        play: (speaker, clip, signal) => {
          const character = characters.get(speaker);
          if (character === undefined) return Promise.reject(new Error(`${speaker} is not in the room`));
          return playPcm(character.source, clip, SAMPLE_RATE, signal, reference);
        },
        clipDurationMs: (clip) => (clip.length / SAMPLE_RATE) * 1000,
        emitTranscript: (speaker, text, transcriptOptions) => {
          // The person's own line is written by the app server from their seat socket, so posting
          // it here too would duplicate it (and lose it entirely when no runner is connected).
          if (transcriptOptions?.human === true) return;
          const attendee = meeting.scenario().attendees.find((candidate) => candidate.name === speaker);
          options.postTranscript(attendee?.zoomDisplayName ?? speaker, text, transcriptOptions);
        },
        emitTranscriptUpdate: (speaker, text, updateOptions) => {
          const attendee = meeting.scenario().attendees.find((candidate) => candidate.name === speaker);
          options.postTranscriptUpdate(attendee?.zoomDisplayName ?? speaker, text, updateOptions);
        },
        emitState: (state) => {
          lastConversationState = state;
          setGuard(state.kind === 'speaking');
          publishState(state);
        },
        log,
        describeMic: () => {
          const vad = vads.values().next().value as EnergyVad | undefined;
          if (vad === undefined) return undefined;
          return `mic peak ${vad.peak(3000).toFixed(3)} in the last 3 s, bar to count as talking ${vad.threshold.toFixed(3)}, AI level ${vad.referenceLevel.toFixed(3)}, its echo in the mic ${vad.leakLevel.toFixed(3)}`;
        },
        advanceAgenda: options.onAdvanceAgenda,
        endMeeting: options.onEndMeeting,
        onWingmanTip: options.onWingmanTip,
        settleTopic: options.onTopicSettled,
        onReaction: options.onReaction,
      },
      { scenario: { ...meeting.scenario(), npcs: cast }, memory, responseDelayMs: options.responseDelayMs, speakerGapMs: options.speakerGapMs, sentenceGapMs: options.sentenceGapMs, bargeInMs: options.bargeInMs },
    );
  }

  // --- The person: their voice activity, and the words the browser recognised. ---
  let conversation: NpcConversation<Int16Array> | undefined;
  /** Everything the conversation was built from; a snapshot edit before Start rebuilds it. */
  let conversationKey = '';
  interface Person {
    name: string;
    role: string;
    seat: string | undefined;
  }
  const humans = new Map<string, Person>();
  let closing = false;
  /** While keys are being pressed, a short sound in the microphone is more likely the keyboard than speech. */
  const TYPING_QUIET_MS = 500;
  let typingUntil = 0;
  const suppressed = new Set<string>();

  /** Make the room match the people in it: everyone but their seats, and a conversation for exactly that cast. */
  let castQueue: Promise<void> = Promise.resolve();
  /** The welcome is spoken once per visit: when the person arrives, not when they first speak. */
  let welcomed = false;
  /** How many task dispatches have been voiced to the visitor on this topic, so the first pointer is plain and later ones are brief. */
  let visitorTaskDispatches = 0;
  let visitorDispatchTopic: string | undefined;
  const resetDispatchCountOn = (title: string | undefined): void => {
    if (title === undefined || title === visitorDispatchTopic) return;
    visitorDispatchTopic = title;
    visitorTaskDispatches = 0;
  };
  /**
   * The person has read their briefing and pressed Start. Until then the AI attendees are in the room but silent, and
   * nothing the person says or types reaches them. A person in the host's seat opens the meeting themselves, so they skip this.
   * This is the runner having opened the conversation locally, not a mirror of the server snapshot's `started`.
   */
  let openedLocally = false;
  /** The conversation's local playback pause; it follows the server snapshot, except while a Stop holds. */
  let pausedLocally = false;
  /**
   * The snapshot the runner held when a person pressed Stop. Local playback stays paused until a
   * snapshot newer than this arrives, so an in-flight `paused:false` made before the Stop cannot
   * undo it. The server still owns the real pause; this is only the instant speech gate.
   */
  let stopGate: { seq: number; epoch?: RunnerSnapshotVersion['epoch'] } | undefined;
  /** The safety timeout that releases a Stop the server never confirmed. */
  let stopGateTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A typed line that arrived before the server's resume snapshot: it is answered once the meeting
   * is running again, and dropped if that never comes or the meeting moves on first.
   */
  let heldTypedLine: { text: string; meetingId: string | undefined; timer: ReturnType<typeof setTimeout> } | undefined;
  /** The timer that re-reads the server state while a local pause waits for a resume. */
  let resumeBackstop: ReturnType<typeof setInterval> | undefined;
  /**
   * A server snapshot showed the empty-room pause ending after a person returned (or is about to
   * return); their one welcome-back line waits here until the cast and playback are ready for it.
   */
  let greetReturnPending = false;
  /** The meeting ended: only a new meeting's snapshot or prepare can open the conversation again. */
  let endedTerminal = false;
  /** The Start attempt that prepared the cast, if the server has not opened the meeting yet. */
  let prepared: { meetingId: string; attempt: string } | undefined;
  /** Bumped whenever the local meeting is cleared, so a prepare that was overtaken cannot report ready. */
  let runnerGeneration = 0;
  /** The item this Start was asked to open at; a Start event can arrive before the matching snapshot. */
  let openingAgendaIndex = 0;
  let startResumed = false;
  /** The first topic is opened once per meeting, independently of whether the welcome was already spoken. */
  let startInitialized = false;
  let startWait: { promise: Promise<void>; resolve(): void; reject(error: unknown): void } | undefined;

  function settleStart(error?: unknown): void {
    const pending = startWait;
    startWait = undefined;
    if (pending === undefined) return;
    if (error === undefined) pending.resolve();
    else pending.reject(error);
  }

  function markMeetingStarted(reason: string, state?: RunnerStartState): Promise<void> {
    if (closing) return Promise.resolve();
    if (!openedLocally) {
      openedLocally = true;
      openingAgendaIndex = Number.isInteger(state?.agendaIndex) ? Math.max(0, state?.agendaIndex ?? 0) : 0;
      startResumed = state?.resumed === true;
      log(reason);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      startWait = { promise, resolve, reject };
      syncCast();
    }
    return startWait?.promise ?? Promise.resolve();
  }
  const meetingOpen = (): boolean => (openedLocally || hostIsHuman()) && !pausedLocally && !endedTerminal;

  /** Make the room match the people in it and have a conversation ready, without opening the meeting. */
  async function ensureCast(): Promise<void> {
    if (closing) throw new Error('the AI runner is stopping');
    // A zero-AI meeting keeps only the silent room listener; every voiced character leaves.
    if (meeting.cast().length === 0) {
      for (const [name, character] of [...characters]) {
        if (name === listenerProfile.attendee) continue;
        characters.delete(name);
        await character.room.disconnect().catch(() => undefined);
        log(`${name} left ${roomName}`);
      }
      if (conversation !== undefined) {
        conversation.close();
        conversation = undefined;
        conversationKey = '';
      }
      return;
    }
    if (humans.size === 0) return;
    const seats = new Set([...humans.values()].flatMap((person) => (person.seat === undefined ? [] : [person.seat])));
    const wanted = meeting.cast().filter((npc) => npc.playable !== true || !seats.has(npc.attendee));
    for (const npc of wanted) await joinCharacter(npc);
    for (const [name, character] of [...characters]) {
      if (name === listenerProfile.attendee || wanted.some((npc) => npc.attendee === name)) continue;
      characters.delete(name);
      await character.room.disconnect().catch(() => undefined);
      log(`${name} left ${roomName}`);
    }

    if (wanted.length === 0) {
      // A sealed setup can take every seat as a person: nobody is voiced, and the old conversation is gone.
      if (conversation !== undefined) {
        conversation.close();
        conversation = undefined;
        conversationKey = '';
      }
      return;
    }
    // The conversation carries the agenda and roles it was built with, so a lobby edit that keeps the
    // same AI names still needs a fresh conversation before Start.
    const key = JSON.stringify({ agenda: meeting.agenda(), roles: meeting.roles(), cast: wanted });
    const rebuilt = conversation === undefined || key !== conversationKey;
    if (rebuilt) {
      conversation?.close();
      conversation = makeConversation(wanted);
      conversationKey = key;
    }
    if (rebuilt || !openedLocally) {
      const person = [...humans.values()].at(-1)!;
      const role = meeting
        .roles()
        .find((candidate) => candidate.id.toLowerCase() === person.role.trim().toLowerCase());
      conversation!.setHuman({
        name: person.name,
        role: person.role,
        transcriptName: role === undefined ? person.name : `${person.name} (${role.label})`,
      });
    }
  }

  function syncCast(): void {
    castQueue = castQueue
      .then(async () => {
        if (closing) {
          settleStart(new Error('the AI runner is stopping'));
          return;
        }
        // Nobody is in the room: keep the conversation paused in case someone returns. Only the server's
        // MEETING_RESET tears it down, so both processes agree on when a meeting really ends.
        if (humans.size === 0) {
          // Nobody is waiting for a first line yet; the next arrival opens the topic for them.
          settleStart();
          return;
        }
        await ensureCast();
        // Open the first topic once per meeting, through this one serialized path. It must not depend
        // on the welcome: a coalesced host cue may already have spoken the welcome and set `welcomed`
        // before this queue runs, which used to leave the briefing, question and timer uninitialized.
        if (openedLocally && !startInitialized) {
          startInitialized = true;
          const index = Math.max(0, Math.min(openingAgendaIndex, Math.max(0, meeting.agenda().length - 1)));
          const title = meeting.agenda()[index]?.title;
          if (startResumed) {
            // A restored meeting was already welcomed; resume its saved item instead of opening item zero again.
            welcomed = true;
            conversation?.agendaMoved(title);
          } else if (!hostIsHuman()) {
            // Sam welcomes the person once they press Start, before anyone else speaks.
            conversation?.agendaMoved(title);
            if (!welcomed) announce(openingLine(meeting.scenario()));
          } else {
            welcomed = true;
            conversation?.agendaMoved(title);
          }
        }
        greetReturn();
        settleStart();
      })
      .catch((error: unknown) => {
        log(`could not change who is in the meeting: ${String(error)}`);
        // A failed opening is not a started meeting: put the runner back so the server's retry
        // can genuinely try again instead of resolving a no-op.
        const failedOpening = startWait !== undefined;
        if (failedOpening) {
          openedLocally = false;
          startInitialized = false;
          openingAgendaIndex = 0;
          startResumed = false;
        }
        settleStart(error);
      });
  }

  /** Forget every local trace of the meeting; the snapshot itself is replaced separately. */
  function clearLocalMeeting(): void {
    runnerGeneration += 1;
    settleStart(new Error('the meeting was reset before it opened'));
    prepared = undefined;
    conversation?.close();
    conversation = undefined;
    conversationKey = '';
    welcomed = false;
    visitorTaskDispatches = 0;
    visitorDispatchTopic = undefined;
    openedLocally = false;
    startInitialized = false;
    openingAgendaIndex = 0;
    startResumed = false;
    pausedLocally = false;
    clearStopGate();
    stopResumeBackstop();
    dropHeldTypedLine('dropped the typed line held for the old meeting');
    greetReturnPending = false;
    endedTerminal = false;
    memory.reset();
    lastConversationState = { kind: 'idle' };
    publishState(lastConversationState);
  }

  /** Forget the meeting and its snapshot; a new one may follow under `nextMeetingId`. */
  function clearMeeting(nextMeetingId?: string): void {
    meeting.clear(nextMeetingId);
    clearLocalMeeting();
    if (humans.size > 0) syncCast();
  }

  /** Adopt a server snapshot without opening anything: used by prepare and by catch-up reads. */
  function adoptSnapshot(state: RunnerMeetingSnapshot): void {
    const held = meeting.meetingId();
    const heldEpoch = meeting.version()?.epoch;
    const changed = held !== undefined && held !== state.meetingId;
    const previous = meeting.current();
    const identical =
      previous !== undefined && previous.meetingId === state.meetingId && sameVersion(previous.version, state.version);
    // A prepare is fetched on the live service connection, so it may prove a new server epoch.
    const accepted = meeting.apply(state, { currentConnection: true });
    if (!accepted && !identical) return;
    if (state.phase !== 'ended') endedTerminal = false;
    if (changed) {
      log(`the server is on meeting ${state.meetingId}; clearing the old meeting ${held}`);
      clearLocalMeeting();
    } else if (accepted && heldEpoch !== undefined && !sameRunnerEpoch(state.version.epoch, heldEpoch)) {
      clearStopGate();
    }
    if (accepted && !changed) notePauseTransition(previous, state);
  }

  /** Forget the local Stop and its safety timeout: the server snapshot now owns the pause. */
  function clearStopGate(): void {
    if (stopGateTimer !== undefined) clearTimeout(stopGateTimer);
    stopGateTimer = undefined;
    stopGate = undefined;
  }

  /**
   * The one thing that earns a "Welcome back": a newer snapshot ends an empty-room pause while the
   * meeting is running, with an AI host. The greeting does not need the person to be in LiveKit yet:
   * their resume snapshot can arrive first, so it waits for the first person to join. A briefly
   * empty room the server never paused, or a reload in the lobby, is not a return.
   */
  function notePauseTransition(
    previous: RunnerMeetingSnapshot | undefined,
    next: RunnerMeetingSnapshot,
  ): void {
    if (previous === undefined || previous.paused !== true || previous.pauseKind !== 'empty-room') return;
    if (next.paused !== false || next.started !== true || next.phase !== 'running') return;
    if (endedTerminal || meeting.hostIsHuman()) return;
    greetReturnPending = true;
  }

  /** Stop re-reading the server state: the local pause is no longer waiting for a resume. */
  function stopResumeBackstop(): void {
    if (resumeBackstop === undefined) return;
    clearInterval(resumeBackstop);
    resumeBackstop = undefined;
  }

  /**
   * The runner is paused locally but has a reason to expect a resume (a LiveKit Resume, or a typed
   * line waiting to be answered). The server's snapshot ends that pause; if the snapshot is lost,
   * re-read it through the meeting sync's fenced read so the AI is not silent for the rest of the
   * meeting. The re-reads are bounded, and give up loudly when the server still says paused.
   */
  function expectResume(reason: string): void {
    if (!pausedLocally || resumeBackstop !== undefined) return;
    const recheck = options.recheckMeetingState;
    if (recheck === undefined) return;
    const intervalMs = options.resumeBackstopIntervalMs ?? RESUME_BACKSTOP_INTERVAL_MS;
    const windowMs = options.resumeBackstopWindowMs ?? RESUME_BACKSTOP_WINDOW_MS;
    const startedAt = Date.now();
    log(`waiting for a resume (${reason}); re-reading the server state every ${intervalMs} ms`);
    const timer = setInterval(() => {
      if (!pausedLocally || endedTerminal) {
        stopResumeBackstop();
        return;
      }
      const waited = Date.now() - startedAt;
      if (waited >= windowMs) {
        stopResumeBackstop();
        logError(
          `the meeting is still paused ${waited} ms after a resume was asked for (${reason}); ` +
            'the server never confirmed the resume, so the AI stays silent until its next snapshot',
        );
        return;
      }
      recheck(`the runner is paused locally and waiting for a resume (${reason})`);
    }, intervalMs);
    timer.unref?.();
    resumeBackstop = timer;
  }

  /** Forget a held typed line, saying why when it was dropped rather than answered. */
  function dropHeldTypedLine(reason?: string): void {
    if (heldTypedLine === undefined) return;
    clearTimeout(heldTypedLine.timer);
    heldTypedLine = undefined;
    if (reason !== undefined) log(reason);
  }

  /** Keep the line until the server's next snapshot says the meeting is running again. */
  function holdTypedLine(text: string): void {
    dropHeldTypedLine('replaced a typed line that was still waiting for the meeting to resume');
    const timeoutMs = options.heldTypedLineTimeoutMs ?? HELD_TYPED_LINE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (heldTypedLine === undefined) return;
      heldTypedLine = undefined;
      log(`dropped a typed line: the meeting did not resume within ${timeoutMs} ms`);
    }, timeoutMs);
    timer.unref?.();
    heldTypedLine = { text, meetingId: meeting.meetingId(), timer };
    log('holding a typed line until the server says the meeting is running again');
    expectResume('a typed line is waiting for the meeting to resume');
  }

  /** Answer a held line once the meeting is open again, never before. */
  function flushHeldTypedLine(): void {
    if (heldTypedLine === undefined || !meetingOpen()) return;
    const held = heldTypedLine;
    if (held.meetingId !== meeting.meetingId()) {
      dropHeldTypedLine('dropped a held typed line: the meeting changed before it resumed');
      return;
    }
    clearTimeout(held.timer);
    heldTypedLine = undefined;
    typingUntil = Date.now() + TYPING_QUIET_MS;
    conversation?.humanTyped(held.text);
    log('answered the typed line held during the pause');
  }

  /** Apply a pause locally, without asking the server. */
  function applyLocalPause(next: boolean): void {
    // The pause is ending (or already ended): nothing is waiting for a resume any more.
    if (!next) stopResumeBackstop();
    if (pausedLocally === next) {
      if (!next) {
        greetReturn();
        flushHeldTypedLine();
      }
      return;
    }
    pausedLocally = next;
    if (next) {
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation?.stop();
      return;
    }
    const hostName = meeting.hostName();
    const greetingHolds =
      greetReturnPending && !endedTerminal && conversation !== undefined && !hostIsHuman() &&
      hostName !== undefined && meeting.started();
    if (greetingHolds && humans.size > 0 && conversation !== undefined) {
      greetReturnPending = false;
      const title = conversation.currentTopicTitle();
      const line =
        title === undefined
          ? 'Welcome back.'
          : `Welcome back — we were on ${spokenAgendaName(meeting.scenario(), title)}.`;
      conversation.resumeAfterRejoin(hostName, line);
      flushHeldTypedLine();
      return;
    }
    // A greeting that no longer belongs to a running AI-hosted meeting is dropped; one waiting
    // for a person to reappear in LiveKit stays pending.
    if (greetReturnPending && !meeting.started()) greetReturnPending = false;
    conversation?.resumeFromPause();
    flushHeldTypedLine();
  }

  /**
   * A person pressed Stop. Stop the speech now and hold the local pause until a server snapshot
   * newer than the one held right now arrives. The person's browser sends the real pause straight
   * to the server; the runner never forwards it. When the snapshot already says paused, there is
   * nothing newer to wait for, so no safety timeout is armed.
   */
  function holdLocalStop(): void {
    // A fresh Stop supersedes any resume the runner was waiting for.
    stopResumeBackstop();
    if (meeting.paused() === true) {
      clearStopGate();
      applyLocalPause(true);
      return;
    }
    holdStopGate();
    applyLocalPause(true);
  }

  /**
   * A person pressed Resume. This only asks the server to resume: the runner starts speaking again
   * when a snapshot says the meeting is running, so a Resume whose command never reached the
   * server cannot reopen a paused meeting locally.
   */
  function releaseLocalStop(): void {
    log('the LiveKit resume only asks; waiting for a server snapshot that says the meeting is running');
    expectResume('a person pressed resume');
  }

  /** Remember where the runner was when a Stop arrived, and arm the safety release. */
  function holdStopGate(): void {
    clearStopGate();
    const held = meeting.version();
    stopGate = { seq: held?.seq ?? 0, ...(held === undefined ? {} : { epoch: held.epoch }) };
    const timeoutMs = options.stopGateTimeoutMs ?? STOP_GATE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (stopGate === undefined) return;
      log(
        `no server snapshot newer than the one held at the Stop arrived within ${timeoutMs} ms; ` +
          'releasing the local stop and following the server snapshot',
      );
      clearStopGate();
      applyLocalPause(meeting.paused());
    }, timeoutMs);
    timer.unref?.();
    stopGateTimer = timer;
  }

  /** True when `version` is newer than the snapshot held at the moment of the Stop. */
  function isNewerThanStopGate(version: RunnerSnapshotVersion | undefined): boolean {
    if (stopGate === undefined) return true;
    if (version === undefined) return false;
    if (stopGate.epoch === undefined) return true;
    if (!sameRunnerEpoch(version.epoch, stopGate.epoch)) return true;
    return version.seq > stopGate.seq;
  }

  /** The snapshot is the truth, except while a person's Stop is still newer than every snapshot. */
  function adoptPaused(next: boolean): void {
    // A pause that arrives before the welcome-back line is spoken means the return no longer holds.
    if (next) greetReturnPending = false;
    if (stopGate !== undefined && !isNewerThanStopGate(meeting.version())) {
      log('kept the person\'s stop locally; no newer server snapshot has arrived yet');
      applyLocalPause(true);
      return;
    }
    clearStopGate();
    if (!next && greetReturnPending && humans.size === 0) {
      // The server has resumed, but the person is not back in LiveKit yet. Keep the local hold so
      // the greeting and the resumed conversation start together when they join.
      return;
    }
    applyLocalPause(next);
  }

  /** Say one welcome-back line once the cast is ready and playback allows it. */
  function greetReturn(): void {
    if (!greetReturnPending || endedTerminal || conversation === undefined) return;
    const hostName = meeting.hostName();
    if (hostName === undefined) return;
    if (!meeting.started() || hostIsHuman()) {
      // Not a running AI-hosted meeting any more: there is nothing to welcome anyone back to.
      greetReturnPending = false;
      return;
    }
    // The resume snapshot can arrive before LiveKit shows the person; keep the greeting pending
    // and speak it on the first join.
    if (humans.size === 0) return;
    if (pausedLocally) {
      // The runner held the local pause for exactly this join; resuming speaks the greeting.
      applyLocalPause(false);
      return;
    }
    greetReturnPending = false;
    const title = conversation.currentTopicTitle();
    const line =
      title === undefined
        ? 'Welcome back.'
        : `Welcome back — we were on ${spokenAgendaName(meeting.scenario(), title)}.`;
    conversation.announce(hostName, line);
    log('someone returned; the meeting carries on');
  }

  function prepareMeeting(request: RunnerPrepareRequest): Promise<void> {
    if (closing) return Promise.reject(new Error('the AI runner is stopping'));
    if (request.snapshot !== undefined) {
      adoptSnapshot(request.snapshot);
      const held = meeting.meetingId();
      if (held !== request.meetingId) {
        // A stale prepare must never tear down the newer meeting the runner already holds.
        return Promise.reject(
          new Error(`ignored a prepare for meeting ${request.meetingId}: the runner holds ${held}`),
        );
      }
    }
    const held = meeting.meetingId();
    if (held !== undefined && held !== request.meetingId) {
      log(`the server is preparing meeting ${request.meetingId}; clearing the old meeting ${held}`);
      clearMeeting(request.meetingId);
    } else if (held === undefined) {
      // No snapshot yet: remember the id so a Start for another meeting can still be refused.
      meeting.clear(request.meetingId);
    }
    prepared = undefined;
    endedTerminal = false;
    const generation = runnerGeneration;
    const work = castQueue.then(async () => {
      if (closing) throw new Error('the AI runner is stopping');
      if (generation !== runnerGeneration) throw new Error('the meeting changed before the cast was ready');
      await ensureCast();
      if (generation !== runnerGeneration) throw new Error('the meeting changed before the cast was ready');
      greetReturn();
      prepared = { meetingId: request.meetingId, attempt: request.attempt };
    });
    castQueue = work.catch(() => undefined);
    return work;
  }

  function reconcileMeeting(
    state: RunnerMeetingSnapshot,
    options?: { currentConnection?: boolean; authoritative?: boolean },
  ): boolean {
    const held = meeting.meetingId();
    const heldEpoch = meeting.version()?.epoch;
    const changed = held !== undefined && held !== state.meetingId;
    const previous = meeting.current();
    // The same snapshot arriving again (for example on reconnect) is still reconciled locally: a
    // process that booted from it has not yet opened the meeting or caught up its topic.
    const identical =
      previous !== undefined && previous.meetingId === state.meetingId && sameVersion(previous.version, state.version);
    const accepted = meeting.apply(state, options);
    if (!accepted && !identical) return false;
    if (state.phase !== 'ended') endedTerminal = false;
    if (changed) {
      log(`the server is on meeting ${state.meetingId}; clearing the old meeting ${held}`);
      clearLocalMeeting();
    } else if (accepted && heldEpoch !== undefined && !sameRunnerEpoch(state.version.epoch, heldEpoch)) {
      // A new server incarnation owns the state now: a local hold from the old one cannot apply to it.
      clearStopGate();
    }
    if (state.phase === 'ended') {
      // A reconnect can learn the meeting ended without hearing the live END cue. A closing line is
      // only spoken for a live cue; catching up here just stops the conversation and clears local start.
      if (openedLocally) log(`the server says meeting ${state.meetingId} ended; stopping the conversation`);
      openedLocally = false;
      startInitialized = false;
      openingAgendaIndex = 0;
      startResumed = false;
      pausedLocally = true;
      endedTerminal = true;
      clearStopGate();
      stopResumeBackstop();
      dropHeldTypedLine('dropped the typed line held before the meeting ended');
      greetReturnPending = false;
      prepared = undefined;
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation?.stop();
      if (changed && humans.size > 0) syncCast();
      return accepted;
    }
    const lostStart = openedLocally && !state.started;
    if (lostStart) {
      log(`the server no longer has meeting ${state.meetingId} started; clearing it`);
      clearLocalMeeting();
    }
    if (state.started && !openedLocally) {
      // A preparation for exactly this meeting is the Start attempt we were asked to get ready for:
      // open it through the fresh path so the guest hears the one welcome and the topic initializes.
      // Only an unprepared meeting (a restart or another runner instance) resumes, and a resume
      // deliberately skips the welcome.
      const fresh = prepared?.meetingId === state.meetingId;
      if (fresh) prepared = undefined;
      void markMeetingStarted(`the server says meeting ${state.meetingId} is running`, {
        agendaIndex: state.agendaIndex,
        resumed: !fresh,
      }).catch((error: unknown) => log(`could not resume the running meeting: ${String(error)}`));
    } else if (state.started && openedLocally) {
      // Catch-up after a dropped socket: move the topic exactly as a "Next up" cue would, silently.
      openingAgendaIndex = state.agendaIndex;
      const title = meeting.agenda()[state.agendaIndex]?.title;
      if (title !== undefined && conversation?.currentTopicTitle() !== title) {
        resetDispatchCountOn(title);
        conversation?.agendaMoved(title);
        log(`caught up to agenda item ${state.agendaIndex + 1} (${title}) without repeating the cue`);
      }
    }
    if (accepted && !changed && !lostStart) notePauseTransition(previous, state);
    if (state.started) adoptPaused(state.paused);
    if ((changed || lostStart) && humans.size > 0) syncCast();
    return accepted;
  }

  function registerHuman(participant: RemoteParticipant): void {
    if (meeting.castNames().has(participant.identity)) return;
    const role = participant.metadata?.trim() || 'participant';
    const name = participant.name || participant.identity;
    const seat = humanAttendeeForRole(meeting.scenario(), role)?.name;
    const known = humans.get(participant.identity);
    if (known !== undefined && known.role === role && known.name === name) return;
    humans.set(participant.identity, { name, role, seat });
    if (known === undefined) log(`${name} joined as ${role}`);
    syncCast();
  }

  async function listenTo(track: RemoteTrack, identity: string): Promise<void> {
    const recorder =
      options.recognizer === undefined
        ? undefined
        : new UtteranceRecorder(options.recognizer, {
            sampleRate: SAMPLE_RATE,
            log,
            onAudio: options.debugAudio,
            onRecognizing: (active) => {
              conversation?.humanRecognizing(active);
              if (humanTranscribing !== active) {
                humanTranscribing = active;
                publishState(lastConversationState);
              }
            },
            onNothing: () => conversation?.humanNothing(),
            onText: (text) => {
              if (!meetingOpen()) {
                log(`ignored "${text}": the meeting has not started`);
                return;
              }
              log(`recognised "${text}"`);
              // With the server-side recogniser the browser has no final line to send, so the
              // accepted words are forwarded through the app server's one human-line writer.
              const accepted = conversation === undefined ? text : conversation.humanText(text);
              if (accepted === undefined) return;
              const seat = humans.get(identity)?.role;
              const meetingId = meeting.meetingId();
              if (seat === undefined || meetingId === undefined) return;
              options.postHumanLine?.({
                meetingId,
                participantIdentity: identity,
                seat,
                text: accepted,
                source: 'speech',
                clientLineId: randomUUID(),
              });
            },
          });
    const vad: EnergyVad = new EnergyVad(
      (speaking) => {
        if (!meetingOpen()) return;
        if (speaking && Date.now() < typingUntil) {
          // Typing: the sound is probably a key press. Not speech, not a cut-in; its end is ignored too.
          suppressed.add(identity);
          log(`ignored a sound from ${identity} while they were typing`);
          return;
        }
        if (!speaking && suppressed.delete(identity)) return;
        if (speaking) talking.add(identity);
        else talking.delete(identity);
        log(
          speaking
            ? `${identity} started talking (mic peak ${vad.peak(300).toFixed(3)}, bar ${vad.threshold.toFixed(3)}${vad.guarded ? `, AI was talking: its level ${vad.referenceLevel.toFixed(3)}, its echo in the mic ${vad.leakLevel.toFixed(3)}` : ''})`
            : `${identity} stopped talking`,
        );
        conversation?.humanSpeech(talking.size > 0);
        syncHumanMicState(talking.size > 0);
        // Last, and guarded: a failure in speech recognition must never stop the conversation hearing the person.
        try {
          recorder?.speaking(speaking);
        } catch (error) {
          log(`speech recognition could not ${speaking ? 'start' : 'finish'}: ${String(error)}`);
        }
      },
      options.vad,
      { reference },
    );
    vads.set(identity, vad);
    let lastTrace = 0;
    try {
      for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) {
        if (!meetingOpen()) continue;
        vad.push(frame.data, frame.sampleRate);
        if (suppressed.has(identity) && vad.isSpeaking && Date.now() >= typingUntil) {
          suppressed.delete(identity);
          talking.add(identity);
          log(`${identity} kept speaking past keystroke window; unsuppressing mic`);
          conversation?.humanSpeech(talking.size > 0);
          syncHumanMicState(talking.size > 0);
          try {
            recorder?.speaking(true);
          } catch (error) {
            log(`speech recognition could not start: ${String(error)}`);
          }
        }
        try {
          recorder?.push(frame.data);
        } catch (error) {
          log(`speech recognition could not take audio: ${String(error)}`);
        }
        if (options.traceVad === true && vad.guarded && Date.now() - lastTrace > 500) {
          lastTrace = Date.now();
          log(
            `[vad] mic ${vad.peak(500).toFixed(3)} | AI ${vad.referenceLevel.toFixed(3)} | echo ${vad.leakLevel.toFixed(3)} | bar ${vad.threshold.toFixed(3)}${vad.isSpeaking ? ' | TALKING' : ''}`,
          );
        }
      }
    } catch (error) {
      log(`audio from ${identity} ended: ${String(error)}`);
    } finally {
      recorder?.close();
      vad.close();
      vads.delete(identity);
    }
  }

  const room = listener.room;
  room.on(RoomEvent.ParticipantConnected, registerHuman);
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (!humans.delete(participant.identity)) return;
    talking.delete(participant.identity);
    syncHumanMicState(talking.size > 0);
    if (humans.size === 0 && humanTranscribing) {
      humanTranscribing = false;
      publishState(lastConversationState);
    }
    log(`${participant.identity} left`);
    if (humans.size === 0) {
      // The server watches the room and pauses the meeting itself; the runner just reports it.
      options.onRoomEmpty?.();
      return;
    }
    syncCast();
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (meeting.castNames().has(participant.identity) || track.kind !== TrackKind.KIND_AUDIO) return;
    registerHuman(participant);
    void listenTo(track, participant.identity);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === CONTROL_TOPIC && participant !== undefined && !meeting.castNames().has(participant.identity)) {
      let message: ReturnType<typeof parseControlMessage>;
      try {
        message = parseControlMessage(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        message = undefined;
      }
      if (message === undefined) {
        log('ignored a malformed control message');
      } else if (endedTerminal) {
        log(`ignored ${message.kind} from ${participant.identity}: the meeting has ended`);
      } else if (message.kind === 'typing') {
        typingUntil = Date.now() + TYPING_QUIET_MS;
        conversation?.humanTyping();
      } else if (message.kind === 'start') {
        // The server owns Start now: it prepares the cast, commits the meeting and announces
        // MEETING_STARTED. A browser Start that still arrives here must not open anything.
        log(`ignored a LiveKit Start from ${participant.identity}: the meeting starts on the server`);
      } else if (message.kind === 'stop') {
        if (!openedLocally && !hostIsHuman()) {
          log('ignored stop: the meeting has not started');
          return;
        }
        log(`${participant.identity} pressed stop`);
        holdLocalStop();
      } else if (message.kind === 'resume') {
        if (!openedLocally && !hostIsHuman()) {
          log('ignored resume: the meeting has not started');
          return;
        }
        log(`${participant.identity} pressed resume`);
        releaseLocalStop();
      } else if (message.kind === 'lock') {
        if (openedLocally || hostIsHuman()) conversation?.lockDecision();
      } else if (!openedLocally && !hostIsHuman()) {
        log('ignored typed text: the meeting has not started');
      } else {
        typingUntil = Date.now() + TYPING_QUIET_MS;
        if (message.kind === 'text') {
          // Typing does not resume the meeting by itself: the browser asks the server, and this
          // line waits for the snapshot that proves it resumed.
          if (meetingOpen()) conversation?.humanTyped(message.text);
          else holdTypedLine(message.text);
        }
      }
      return;
    }
    if (topic !== STT_TOPIC || participant === undefined || meeting.castNames().has(participant.identity)) return;
    // With server-side recognition the browser's text is not used: it hears the speakers, not the echo-cancelled track.
    if (options.recognizer !== undefined) return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
      if (typeof message.text === 'string' && meetingOpen()) conversation?.humanText(message.text);
    } catch {
      log('ignored a malformed speech message');
    }
  });
  room.on(RoomEvent.Disconnected, () => {
    if (closing) return;
    log('lost the connection to LiveKit');
    options.onDisconnected?.();
  });
  for (const participant of room.remoteParticipants.values()) registerHuman(participant);

  function announce(text: string, onDone?: (spoken: boolean) => void, shouldStillSpeak?: () => boolean): void {
    if (endedTerminal) return;
    const hostName = meeting.hostName();
    if (hostName === undefined || conversation === undefined) return;
    const isWelcome = text.startsWith(OPENING_PREFIX);
    // The welcome was already spoken when the person arrived; the host cue that follows the first line is not said again.
    if (isWelcome && welcomed) return;
    // The welcome waits for Start: a host cue that arrives earlier (for example from words said before it) must not open the meeting.
    if (isWelcome && !meetingOpen()) return;
    // The welcome is rebuilt for the person in the room: their own name and role, not the seat's scripted name.
    const person = [...humans.values()].at(-1);
    const visitor = person?.seat !== undefined ? { name: person.name, seat: person.seat } : undefined;
    const isNextUp = text.startsWith('Next up:');
    const nextTitle = isNextUp ? text.replace(/^Next up:\s*/, '').replace(/\.$/, '') : undefined;
    let spoken =
      isWelcome && visitor !== undefined
        ? liveOpeningLine(meeting.scenario(), visitor, log)
        : isNextUp && nextTitle !== undefined
          ? liveNextItemLine(meeting.scenario(), nextTitle, visitor,
              conversation?.briefsOnTopic(nextTitle) === true, log)
          : text;
    if (!isWelcome && !isNextUp && visitor !== undefined && visitor.seat !== visitor.name) {
      const escapedSeat = visitor.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      spoken = spoken.replace(new RegExp(`\\b${escapedSeat}\\b`, 'g'), visitor.name);
    }
    const isTaskDispatch = /\b(?:Accept or decline it on your phone|Have a look on your phone and accept or decline|It's on your phone)\./i.test(spoken);
    let releaseCardClaimIfDropped = false;
    if (isTaskDispatch) {
      // Every path that points at the card claims the topic first, so a host cue and the review timer
      // can race without Sam saying the same thing twice.
      if (conversation?.claimCardPointerOnCurrentTopic() === false) {
        log(`skipped ${hostName}'s card cue "${spoken}": the visitor was already pointed to their card`);
        return;
      }
      visitorTaskDispatches += 1;
      releaseCardClaimIfDropped = true;
      const dispatchedName = visitor?.name?.trim() || /^([^,]+),/.exec(text)?.[1]?.trim();
      const topicTitle = conversation?.currentTopicTitle();
      const topicIndex = topicTitle === undefined
        ? undefined
        : meeting.agenda().findIndex((item) => item.title === topicTitle);
      spoken = visitorDispatchLine(dispatchedName, 1, topicIndex === undefined || topicIndex < 0 ? undefined : topicIndex);
    }
    const timeoutMatch =
      /^Time is up on (.+?)\. Keep going, or move on to (.+?)\?$/i.exec(spoken.trim()) ??
      /^(.+?) is at (\d+) minutes, please wrap up\.$/i.exec(spoken.trim()) ??
      /^Hey team, we're a bit past time on (.+?) — let's wrap this one up so we can move on\.$/i.exec(spoken.trim());
    if (timeoutMatch !== null) {
      if (conversation.shouldSkipOvertimeCue()) return;
      const personName = person?.name;
      const itemTitle = spokenAgendaName(meeting.scenario(), timeoutMatch[1] ?? 'this item');
      spoken =
        personName !== undefined
          ? `${personName}, we're a bit past time on ${itemTitle} — do you want another minute on this, or should we make a decision and keep moving?`
          : `We're a bit past time on ${itemTitle} — should we take another minute on this, or make a decision and keep moving?`;
    }
    if (isWelcome) welcomed = true;
    // After the welcome, the first agenda item begins: the person is asked, or the characters start talking it through.
    const finalOnDone = releaseCardClaimIfDropped
      ? (spokenNow: boolean) => {
          if (!spokenNow) conversation?.releaseCardPointerOnCurrentTopic();
          onDone?.(spokenNow);
        }
      : onDone;
    if (isNextUp && nextTitle !== undefined) {
      conversation.announceNextTopic(hostName, nextTitle, spoken, finalOnDone);
      return;
    }
    conversation.announce(
      hostName,
      spoken,
      undefined,
      finalOnDone,
      timeoutMatch === null ? shouldStillSpeak : () =>
        conversation?.shouldSkipOvertimeCue() !== true && (shouldStillSpeak?.() ?? true),
    );
  }
  function hostIsHuman(): boolean {
    return meeting.hostIsHuman();
  }

  return {
    announce,
    meetingId() {
      return meeting.meetingId();
    },
    hostName() {
      return meeting.hostName();
    },
    voiceFor(attendee) {
      return meeting.cast().find((npc) => npc.attendee === attendee)?.voice;
    },
    wasPreparedFor(id) {
      return prepared?.meetingId === id && meeting.meetingId() === id;
    },
    prepareMeeting,
    reconcileMeeting,
    markStarted(state) {
      const requested = state?.meetingId;
      if (requested !== undefined) {
        const held = meeting.meetingId();
        if (held !== undefined && held !== requested) {
          const reason = `ignored a start for meeting ${requested}: this runner is on ${held}`;
          log(reason);
          return Promise.reject(new Error(reason));
        }
        if (held === undefined) meeting.clear(requested);
      }
      prepared = undefined;
      return markMeetingStarted('the server started the meeting', state);
    },
    resetMeeting(nextMeetingId) {
      clearMeeting(nextMeetingId);
    },
    plays(attendee) {
      return conversation?.plays(attendee) ?? false;
    },
    volunteeredOnTopic(attendee) {
      return conversation?.volunteeredOnTopic(attendee) ?? false;
    },
    askedByGuestOnTopic(attendee) {
      return conversation?.askedByGuestOnTopic(attendee) ?? false;
    },
    hostIsHuman,
    agendaMoved(title) {
      resetDispatchCountOn(title);
      conversation?.agendaMoved(title);
    },
    taskStatus(id, origin, status, isVisitorTask, declined) {
      conversation?.taskStatus(id, origin, status, isVisitorTask, declined);
    },
    cancelPendingDispatch(originAgendaTitle) {
      conversation?.cancelPendingDispatch(originAgendaTitle);
    },
    onCurrentAgenda(title) {
      return conversation?.onCurrentAgenda(title) ?? false;
    },
    visitorName() {
      return [...humans.values()].at(-1)?.name;
    },
    visitorRole() {
      const wanted = [...humans.values()].at(-1)?.role;
      return meeting.roles().find((role) => role.id === wanted)?.id;
    },
    say(attendee, text, onDone) {
      if (endedTerminal || conversation === undefined) {
        onDone?.();
        return;
      }
      conversation.announce(attendee, text, undefined, () => onDone?.());
    },
    askColleague(target, note, options) {
      if (endedTerminal || conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.askColleague(target, note, options);
    },
    pointAtCard(note, options) {
      if (endedTerminal || conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.pointAtCard(note, options);
    },
    pause() {
      clearStopGate();
      applyLocalPause(true);
    },
    announceClosing(text) {
      const hostName = meeting.hostName();
      if (hostName === undefined || conversation === undefined) return;
      clearStopGate();
      applyLocalPause(true);
      conversation.announceClosing(hostName, text);
    },
    async stop() {
      closing = true;
      stopResumeBackstop();
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      if (humanSpeakingTimer !== undefined) clearTimeout(humanSpeakingTimer);
      await castQueue;
      conversation?.close();
      for (const vad of vads.values()) vad.close();
      await leaveAll();
    },
  };
}
