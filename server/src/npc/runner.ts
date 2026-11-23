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
  isKakiListener,
  KAKI_LISTENER_IDENTITY,
  FAKE_STT_TOPIC,
  NPC_STATE_TOPIC,
  parseFakeSpeechMessage,
  sameRunnerEpoch,
  SPEECH_STATUS_TOPIC,
  STT_TOPIC,
  type NpcProfile,
  type NpcStateMessage,
  type RunnerMeetingSnapshot,
  type RunnerSnapshotVersion,
  type Scenario,
  type SpeechState,
  type SpeechStatusEntry,
  type SpeechStatusMessage,
  type SuggestInput,
  type MeetingMemoryEntry,
} from '@kaki/shared';
import { OPENING_PREFIX, liveNextItemLine, liveOpeningLine, openingLine, spokenAgendaName } from '../host/opening';
import type { ChatMessage } from '../services/llm';
import { createRoomToken } from '../services/livekit';
import { NpcConversation } from './conversation';
import { MeetingMemory } from './meetingMemory';
import { createRunnerMeeting } from './runnerMeeting';
import type { Utterance } from './director';
import { playPcm } from './playback';
import { PlaybackReference } from './reference';
import { reconnectDelayMs } from './serviceChannel';
import { createSpeechLineOrder } from './speechOrder';
import { UtteranceRecorder, type Recognizer, type SpeechStart, type SpeechTiming } from './utterance';
import { EnergyVad, type VadOptions } from './vad';

/** Sample rate of everything published to and read from LiveKit. */
export const SAMPLE_RATE = 16000;

/**
 * After the AI stops, its sound keeps arriving at the person's microphone for as long as the
 * round trip takes (speakers, room, two network hops). The voice detector stays strict that long,
 * or the tail of the echo would be taken for the person talking.
 */
const GUARD_TAIL_MS = 1400;

/** How many quick attempts the listener makes to rejoin after LiveKit drops it. */
const LISTENER_RECONNECT_ATTEMPTS = 5;

/** After those attempts, how often to keep trying slowly, so a longer LiveKit restart can still recover. */
const LISTENER_RETRY_INTERVAL_MS = 30_000;

/** True when two snapshots came from the same server incarnation at the same sequence. */
function sameVersion(a: RunnerSnapshotVersion, b: RunnerSnapshotVersion): boolean {
  return sameRunnerEpoch(a.epoch, b.epoch) && a.seq === b.seq;
}

interface RunnerOptions {
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
    clientLineId: string;
    /** When the speech itself began and ended (ISO), so Kaki can order it by what was said when. */
    speechStartedAt?: string;
    speechEndedAt?: string;
    /** RMS microphone level (0..1) over the recognised stretch, so a quieter copy of another seat's voice can be told apart. */
    micLevel?: number;
    /** True when this person started speaking before the previous human line had finished. */
    overlap?: boolean;
  }): void;
  responseDelayMs?: number;
  /** Called when the last person has left the room (not when the room was empty to begin with). */
  onRoomEmpty?: () => void;
  /** Called when an observe-only agenda item has been talked through and the meeting should move on. */
  onAdvanceAgenda?: () => void;
  /** Called when the final agenda item has wrapped up and the meeting should conclude. */
  onEndMeeting?: () => void;
  /** Log something that needs attention (the resume backstop gave up); defaults to `log`. */
  logError?(message: string): void;
  /** Pause between one character and the next. */
  speakerGapMs?: number;
  /** Pause between two sentences of the same speaker. */
  sentenceGapMs?: number;
  /** Recognise the person's speech on the server, from their echo-cancelled microphone track; without it, the browser's recognition is used. */
  recognizer?: Recognizer;
  /**
   * Dev and test only (`KAKI_FAKE_STT=1`): accept scripted lines on {@link FAKE_STT_TOPIC} as if the recogniser
   * had heard them. Never on in production; see `fakeSttFromEnv`.
   */
  fakeSpeech?: boolean;
  /**
   * Dev-only fake speech: how long a scripted line waits for its speaker to appear in the room.
   * A line sent just before the join event arrives is held for this long, then dropped (default 10 s).
   */
  fakeSpeechJoinWaitMs?: number;
  /** Receives each stretch of audio sent to the recogniser, to save it for listening. */
  debugAudio?(samples: Int16Array): void;
  vad?: Partial<VadOptions>;
  log?(message: string): void;
  /** Log the voice detector's levels twice a second while the AI talks, for tuning. */
  traceVad?: boolean;
  /** The server's snapshot already known at boot (used when the pack had no AI cast yet). */
  initialMeeting?: RunnerMeetingSnapshot;
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
interface RunnerPrepareRequest extends RunnerStartState {
  /** The meeting this attempt belongs to; a different id means the old meeting is gone. */
  meetingId: string;
  /** Unique per attempt, echoed in the ready acknowledgement. */
  attempt: string;
  /** The server's meeting snapshot at prepare time, so the cast and sealed agenda come from one source. */
  snapshot?: RunnerMeetingSnapshot;
}

/** The host-side AI runner the server calls to speak, move the agenda and settle tasks. */
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
  /** Completed, actually heard lines on the current topic, with the agenda item they were heard on. */
  completedLinesOnTopic(): Array<{ speaker: string; text: string; agendaItemTitle?: string }>;
  /** True when the visitor already gave `attendee` a follow-up at any point on this topic. */
  askedByGuestOnTopic(attendee: string): boolean;
  /** True while a person sits in the host's seat: the AI host stays silent and the host's cues are only suggestions. */
  hostIsHuman(): boolean;
  /** The AI host's spoken name in the current meeting, when it has one. */
  hostName(): string | undefined;
  /** The TTS voice for an attendee in the current cast, when known. */
  voiceFor(attendee: string): string | undefined;
  /** `attendee` says `text` aloud once it is quiet; `onDone(true)` only when the room actually heard it. */
  say(attendee: string, text: string, onDone?: (spoken: boolean) => void): void;
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
  /** Marks the visitor's follow-up card as pointed out, once per topic. Kaki's pop-up points at it; Sam says nothing. */
  markCardShown(options?: { onDone?: (claimed: boolean) => void }): void;
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
  /** The server's snapshot of the meeting the runner follows now, or undefined before it has heard one. */
  meetingSnapshot(): RunnerMeetingSnapshot | undefined;
  /** Display names of the people in the room now, with any role suffix still attached. */
  presentNames(): string[];
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
  const fakeSpeechJoinWaitMs = options.fakeSpeechJoinWaitMs ?? 10_000;
  const logError = options.logError ?? log;
  // Everything that can change during the meeting is read from this one snapshot. The boot pack
  // only supplies content the snapshot does not carry (situation and knowledge).
  const meeting = createRunnerMeeting(bootScenario, options.initialMeeting, log);
  const memory = new MeetingMemory(meeting.scenario(), (entries) => options.onMemoryChange?.(entries), log);
  // Characters nobody can play stay in the room and listen; the rest join for the person who arrives,
  // as everyone except the seat that person took. The listener is a separate fixed technical seat:
  // it joins every meeting, hears people even with no AI cast, and never speaks.
  const permanent = aiCast(meeting.scenario());
  // The room follows the server's meeting identity. Until the runner has heard an identity, it
  // waits in a boot room; the first snapshot moves it to the real one.
  let roomName =
    options.roomName ??
    demoRoomName(bootScenario, options.initialMeeting?.meetingId ?? meeting.meetingId() ?? 'boot');
  /** A pinned room belongs to the identity the runner was opened for, not to every later identity. */
  let pinnedRoomMeetingId = options.initialMeeting?.meetingId;

  // --- The listener joins every room; characters join one by one, each publishing its own microphone track. ---
  const characters = new Map<string, Character>();
  let listenerRoom: Room | undefined;
  const leaveAll = (): Promise<unknown> => {
    const rooms = [...characters.values()].map(({ room }) => room);
    if (listenerRoom !== undefined) rooms.push(listenerRoom);
    return Promise.all(rooms.map((room) => room.disconnect().catch(() => undefined)));
  };

  async function connectToRoom(participantName: string, participantRole: string): Promise<Room> {
    const token = await createRoomToken({ roomName, participantName, participantRole });
    const room = new Room();
    try {
      await room.connect(livekitUrl, token);
    } catch (error) {
      throw new Error(
        `Could not connect ${participantName} to LiveKit at ${livekitUrl} (${String(error) || 'no reason given'}). ` +
          'Is it running? Start it with "npm run stack:up", or set LIVEKIT_URL.',
        { cause: error },
      );
    }
    return room;
  }

  async function joinListener(): Promise<Room> {
    const room = await connectToRoom(KAKI_LISTENER_IDENTITY, 'listener');
    listenerRoom = room;
    log(`${KAKI_LISTENER_IDENTITY} is listening in ${roomName}`);
    return room;
  }

  async function joinCharacter(npc: NpcProfile): Promise<void> {
    if (characters.has(npc.attendee)) return;
    const room = await connectToRoom(npc.attendee, 'AI attendee');
    const source = new AudioSource(SAMPLE_RATE, 1, 400);
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    characters.set(npc.attendee, { room, source });
    log(`${npc.attendee} joined ${roomName}`);
  }

  try {
    await joinListener();
    for (const npc of permanent) await joinCharacter(npc);
  } catch (error) {
    await leaveAll();
    throw error;
  }
  log(`${characters.size} AI character${characters.size === 1 ? '' : 's'} running in ${roomName}`);

  // --- What the AI attendees send out: state to the browser, transcript lines to Kaki. ---
  let lastConversationState: NpcStateMessage = { kind: 'idle' };

  function publishData(topic: string, message: unknown): void {
    const data = new TextEncoder().encode(JSON.stringify(message));
    // While the listener reconnects, a character's room still carries room-wide status to the screen.
    const publisher = listenerRoom?.localParticipant ?? [...characters.values()][0]?.room.localParticipant;
    publisher?.publishData(data, { reliable: true, topic }).catch(() => undefined);
  }

  function publishState(state: NpcStateMessage): void {
    publishData(NPC_STATE_TOPIC, state);
  }

  // Speech health belongs to the person, not the room: one recorder finishing must not clear another
  // person's transcribing badge, and a failure must be shown on the speaker's own tile.
  const speechStates = new Map<string, SpeechStatusEntry>();
  let consecutiveSpeechFailures = 0;
  let speechOutage: string | undefined;

  function publishSpeechStatus(): void {
    const message: SpeechStatusMessage = {
      participants: Object.fromEntries([...speechStates].map(([identity, entry]) => [identity, { ...entry }])),
      ...(speechOutage === undefined ? {} : { outage: { message: speechOutage } }),
    };
    publishData(SPEECH_STATUS_TOPIC, message);
  }

  function setSpeechState(identity: string, state: SpeechState, message?: string): void {
    const previous = speechStates.get(identity);
    if (previous !== undefined && previous.state === state && previous.message === message) return;
    speechStates.set(identity, { state, ...(message === undefined ? {} : { message }) });
    publishSpeechStatus();
  }

  function noteSpeechSuccess(identity: string): void {
    consecutiveSpeechFailures = 0;
    const hadOutage = speechOutage !== undefined;
    speechOutage = undefined;
    const previous = speechStates.get(identity);
    if (!hadOutage && previous?.state === 'listening' && previous.message === undefined) return;
    speechStates.set(identity, { state: 'listening' });
    publishSpeechStatus();
  }

  function reportSpeechFailure(identity: string, error: unknown, timing?: SpeechTiming): void {
    const reason = error instanceof Error ? error.message : String(error);
    consecutiveSpeechFailures += 1;
    if (consecutiveSpeechFailures >= 2) {
      speechOutage = `Speech recognition is not working (${reason}).`;
    }
    speechStates.set(identity, {
      state: 'failed',
      message: 'Kaki could not hear that. Please say it again.',
    });
    publishSpeechStatus();
    // A failed stretch still settles its place in speech order, so nobody after it is held forever.
    if (timing !== undefined) speechLines.settle(timing);
  }

  interface HumanSpeechLine {
    meetingId: string;
    participantIdentity: string;
    seat: string;
    text: string;
    clientLineId: string;
    micLevel?: number;
  }

  // Recognition finishes in any order per person; the transcript must still read in speech order.
  const speechLines = createSpeechLineOrder<HumanSpeechLine>(
    ({ value, startedAt, endedAt, overlap }) => {
      options.postHumanLine?.({
        ...value,
        speechStartedAt: new Date(startedAt).toISOString(),
        speechEndedAt: new Date(endedAt).toISOString(),
        ...(overlap ? { overlap: true } : {}),
      });
    },
    { log },
  );

  // What the AI plays, so the voice detectors can tell how much of it their microphone hears.
  const reference = new PlaybackReference();
  const vads = new Map<string, EnergyVad>();
  // A track can arrive both through TrackSubscribed and through the attach-time scan; listen to it once.
  const listeningTracks = new Set<string>();
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
          options.postTranscript(attendee?.displayName ?? speaker, text, transcriptOptions);
        },
        emitTranscriptUpdate: (speaker, text, updateOptions) => {
          const attendee = meeting.scenario().attendees.find((candidate) => candidate.name === speaker);
          options.postTranscriptUpdate(attendee?.displayName ?? speaker, text, updateOptions);
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
  /** True while the runner deliberately leaves an old room for a meeting's new one. */
  let movingRoom = false;

  /** Make the room match the people in it: everyone but their seats, and a conversation for exactly that cast. */
  let castQueue: Promise<void> = Promise.resolve();
  /** The welcome is spoken once per visit: when the person arrives, not when they first speak. */
  let welcomed = false;
  /** How many task dispatches have been voiced to the visitor on this topic, so the first pointer is plain and later ones are brief. */
  let visitorDispatchTopic: string | undefined;
  const resetDispatchCountOn = (title: string | undefined): void => {
    if (title === undefined || title === visitorDispatchTopic) return;
    visitorDispatchTopic = title;
  };
  /**
   * The person has read their briefing and pressed Start. Until then the AI attendees are in the room but silent, and
   * nothing the person says reaches them. A person in the host's seat opens the meeting themselves, so they skip this.
   * This is the runner having opened the conversation locally, not a mirror of the server snapshot's `started`.
   */
  let openedLocally = false;
  /** The conversation's local playback pause; it follows the server snapshot, except while a Stop holds. */
  let pausedLocally = false;
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
      if (wanted.some((npc) => npc.attendee === name)) continue;
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
    visitorDispatchTopic = undefined;
    openedLocally = false;
    startInitialized = false;
    openingAgendaIndex = 0;
    startResumed = false;
    pausedLocally = false;
    speechLines.reset();
    clearPendingFakeSpeech();
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
    if (nextMeetingId !== undefined) moveToRoom(roomForMeeting(nextMeetingId));
    if (humans.size > 0) syncCast();
  }

  /**
   * A live snapshot for the meeting the runner holds as ended is a new meeting under the same id
   * (a practice meeting is reused): it deserves the same clean slate as a changed id. A reconnect
   * to a meeting that never ended keeps everything.
   */
  function reopensEndedMeeting(state: RunnerMeetingSnapshot): boolean {
    return endedTerminal && state.phase !== 'ended';
  }

  /** Adopt a server snapshot without opening anything: used by prepare and by catch-up reads. */
  function adoptSnapshot(state: RunnerMeetingSnapshot): void {
    const held = meeting.meetingId();
    // No held identity is a move too: a boot-room runner must follow its first accepted snapshot.
    const changed = held !== state.meetingId;
    const previous = meeting.current();
    const identical =
      previous !== undefined && previous.meetingId === state.meetingId && sameVersion(previous.version, state.version);
    // A prepare is fetched on the live service connection, so it may prove a new server epoch.
    const accepted = meeting.apply(state, { currentConnection: true });
    if (!accepted && !identical) return;
    const restarted = reopensEndedMeeting(state);
    if (state.phase !== 'ended') endedTerminal = false;
    if (changed) {
      log(`the server is on meeting ${state.meetingId}; clearing the old meeting ${held}`);
      clearLocalMeeting();
      moveToRoom(roomForMeeting(state.meetingId));
    } else if (restarted) {
      log(`the server says ended meeting ${state.meetingId} is live again; clearing it as a new meeting`);
      clearLocalMeeting();
    }
    if (accepted && !changed && !restarted) notePauseTransition(previous, state);
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

  /** Apply a pause locally, without asking the server. */
  function applyLocalPause(next: boolean): void {
    if (pausedLocally === next) {
      if (!next) greetReturn();
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
      return;
    }
    // A greeting that no longer belongs to a running AI-hosted meeting is dropped; one waiting
    // for a person to reappear in LiveKit stays pending.
    if (greetReturnPending && !meeting.started()) greetReturnPending = false;
    conversation?.resumeFromPause();
  }

  /** The server's pause snapshot is the truth. */
  function adoptPaused(next: boolean): void {
    // A pause that arrives before the welcome-back line is spoken means the return no longer holds.
    if (next) greetReturnPending = false;
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
      // The room follows the snapshot (a prepare carries one from the server), so this placeholder
      // id alone does not move the runner.
      meeting.clear(request.meetingId);
    } else if (openedLocally || endedTerminal) {
      // A prepare is a Start request. The same id with a meeting the runner already opened (or ended)
      // is the next practice meeting reusing it, even when this runner never saw the old end or reset:
      // its paused conversation and briefed topics must not carry into the new one.
      log(`the server is preparing a new meeting ${request.meetingId}; clearing the meeting the runner already ran`);
      clearLocalMeeting();
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
    // No held identity is a move too: a boot-room runner must follow its first accepted snapshot.
    const changed = held !== state.meetingId;
    const previous = meeting.current();
    // The same snapshot arriving again (for example on reconnect) is still reconciled locally: a
    // process that booted from it has not yet opened the meeting or caught up its topic.
    const identical =
      previous !== undefined && previous.meetingId === state.meetingId && sameVersion(previous.version, state.version);
    const accepted = meeting.apply(state, options);
    if (!accepted && !identical) return false;
    const restarted = reopensEndedMeeting(state);
    applyOffTheRecord(state.offTheRecord !== undefined && state.offTheRecord !== null);
    if (state.phase !== 'ended') endedTerminal = false;
    if (changed) {
      log(`the server is on meeting ${state.meetingId}; clearing the old meeting ${held}`);
      clearLocalMeeting();
      moveToRoom(roomForMeeting(state.meetingId));
    } else if (restarted) {
      log(`the server says ended meeting ${state.meetingId} is live again; clearing it as a new meeting`);
      clearLocalMeeting();
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
    if (accepted && !changed && !restarted && !lostStart) notePauseTransition(previous, state);
    if (state.started) adoptPaused(state.paused);
    if ((changed || lostStart) && humans.size > 0) syncCast();
    return accepted;
  }

  function registerHuman(participant: RemoteParticipant): void {
    if (isKakiListener(participant.identity) || meeting.castNames().has(participant.identity)) return;
    const role = participant.metadata?.trim() || 'participant';
    const name = participant.name || participant.identity;
    const seat = humanAttendeeForRole(meeting.scenario(), role)?.name;
    const known = humans.get(participant.identity);
    if (known !== undefined && known.role === role && known.name === name) return;
    humans.set(participant.identity, { name, role, seat });
    if (known === undefined) log(`${name} joined as ${role}`);
    syncCast();
    flushPendingFakeSpeech(participant.identity);
  }

  /** Each person's recorder, so going off the record can stop every one of them at once. */
  const recorders = new Map<string, UtteranceRecorder>();
  // Off the record: no microphone audio reaches speech recognition and no recognised line is posted.
  let offTheRecord = false;

  function applyOffTheRecord(next: boolean): void {
    if (offTheRecord === next) return;
    offTheRecord = next;
    if (next) {
      for (const recorder of recorders.values()) recorder.suspend();
      talking.clear();
      log('the room is off the record; speech recognition is paused');
      return;
    }
    for (const recorder of recorders.values()) recorder.resume();
    log('the room is back on the record; speech recognition resumes');
  }

  /**
   * Words the recogniser heard from one person: the conversation hears them, then the app server's one
   * human-line writer records them in speech order. The dev-only fake recogniser enters here too, so a
   * scripted line behaves exactly like real speech from this point on.
   */
  function acceptRecognisedText(identity: string, text: string, timing: SpeechTiming): void {
    if (offTheRecord) {
      speechLines.settle(timing);
      return;
    }
    if (!meetingOpen()) {
      log(`ignored "${text}": the meeting has not started`);
      speechLines.settle(timing);
      return;
    }
    log(`recognised "${text}"`);
    // With the server-side recogniser the browser has no final line to send, so the
    // accepted words are forwarded through the app server's one human-line writer.
    const accepted = conversation === undefined ? text : conversation.humanText(text);
    if (accepted === undefined) {
      speechLines.settle(timing);
      noteSpeechSuccess(identity);
      return;
    }
    const seat = humans.get(identity)?.role;
    const meetingId = meeting.meetingId();
    if (seat === undefined || meetingId === undefined) {
      speechLines.settle(timing);
      noteSpeechSuccess(identity);
      return;
    }
    noteSpeechSuccess(identity);
    speechLines.settle(timing, {
      meetingId,
      participantIdentity: identity,
      seat,
      text: accepted,
      clientLineId: randomUUID(),
      ...(timing.micLevel === undefined ? {} : { micLevel: timing.micLevel }),
    });
  }

  let fakeSpeechCount = 0;
  /**
   * Scripted lines that arrived before their speaker's join event. LiveKit delivers the data message
   * before this client has processed ParticipantConnected, so dropping it would lose the first line
   * of every scripted meeting; hold it until the person registers, or let it expire.
   */
  const pendingFakeSpeech = new Map<string, Array<{ text: string; timer: ReturnType<typeof setTimeout> }>>();

  /** Deliver the lines held for `identity` once they are a person in the room, in the order sent. */
  function flushPendingFakeSpeech(identity: string): void {
    const pending = pendingFakeSpeech.get(identity);
    if (pending === undefined) return;
    pendingFakeSpeech.delete(identity);
    for (const item of pending) clearTimeout(item.timer);
    for (const item of pending) acceptFakeSpeech(identity, item.text);
  }

  /** Forget held lines: the meeting they were meant for is gone. */
  function clearPendingFakeSpeech(): void {
    for (const pending of pendingFakeSpeech.values()) {
      for (const item of pending) clearTimeout(item.timer);
    }
    pendingFakeSpeech.clear();
  }

  /** A line from the dev-only fake recogniser, said by `identity` as if their microphone had carried it. */
  function acceptFakeSpeech(identity: string, text: string): void {
    if (!humans.has(identity)) {
      const pending = pendingFakeSpeech.get(identity) ?? [];
      const timer = setTimeout(() => {
        const held = pendingFakeSpeech.get(identity);
        if (held === undefined) return;
        const remaining = held.filter((item) => item.timer !== timer);
        if (remaining.length === 0) pendingFakeSpeech.delete(identity);
        else pendingFakeSpeech.set(identity, remaining);
        log(`dropped a fake-speech line for ${identity}: they never joined the room`);
      }, fakeSpeechJoinWaitMs);
      timer.unref?.();
      pendingFakeSpeech.set(identity, [...pending, { text, timer }]);
      log(`held fake speech for ${identity}: they have not joined the room yet`);
      return;
    }
    fakeSpeechCount += 1;
    const now = Date.now();
    const start = { id: `fake-speech-${fakeSpeechCount}`, startedAt: now };
    speechLines.begin(start);
    log(`fake speech from ${identity}`);
    // Real speech reaches the recogniser only after the voice detector heard it start and stop. The speech gate
    // refuses words with no voice behind them while the AI is (or just was) talking, as echo would be, so the fake
    // line carries the same short voice first.
    if (meetingOpen() && !offTheRecord) {
      talking.add(identity);
      conversation?.humanSpeech(true);
      talking.delete(identity);
      conversation?.humanSpeech(talking.size > 0);
    }
    acceptRecognisedText(identity, text, { ...start, endedAt: now });
  }

  async function listenTo(track: RemoteTrack, identity: string): Promise<void> {
    const key = track.sid ?? identity;
    if (listeningTracks.has(key)) return;
    listeningTracks.add(key);
    // Listening means this person's microphone audio is actually reaching the recogniser, not merely that they joined.
    setSpeechState(identity, 'listening');
    const recorder =
      options.recognizer === undefined
        ? undefined
        : new UtteranceRecorder(options.recognizer, {
            sampleRate: SAMPLE_RATE,
            log,
            onAudio: options.debugAudio,
            onSpeechStart: (start: SpeechStart) => {
              speechLines.begin(start);
            },
            onRecognizing: (active) => {
              conversation?.humanRecognizing(active);
              setSpeechState(identity, active ? 'transcribing' : 'listening');
            },
            onNothing: (timing) => {
              conversation?.humanNothing();
              noteSpeechSuccess(identity);
              speechLines.settle(timing);
            },
            onFailure: (error, timing) => {
              reportSpeechFailure(identity, error, timing);
            },
            onSpeechDiscarded: (timing) => {
              speechLines.settle(timing);
            },
            onText: (text, timing) => acceptRecognisedText(identity, text, timing),
          });
    if (recorder !== undefined) recorders.set(identity, recorder);
    const vad: EnergyVad = new EnergyVad(
      (speaking) => {
        if (!meetingOpen()) return;
        if (speaking) talking.add(identity);
        else talking.delete(identity);
        log(
          speaking
            ? `${identity} started talking (mic peak ${vad.peak(300).toFixed(3)}, bar ${vad.threshold.toFixed(3)}${vad.guarded ? `, AI was talking: its level ${vad.referenceLevel.toFixed(3)}, its echo in the mic ${vad.leakLevel.toFixed(3)}` : ''})`
            : `${identity} stopped talking`,
        );
        conversation?.humanSpeech(talking.size > 0);
        if (speaking) setSpeechState(identity, 'listening');
        // Last, and guarded: a failure in speech recognition must never stop the conversation hearing the person.
        try {
          recorder?.speaking(speaking);
        } catch (error) {
          log(`speech recognition could not ${speaking ? 'start' : 'finish'}: ${String(error)}`);
          if (speaking) reportSpeechFailure(identity, error);
        }
      },
      options.vad,
      { reference },
    );
    vads.set(identity, vad);
    let lastTrace = 0;
    try {
      for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) {
        if (!meetingOpen() || offTheRecord) continue;
        vad.push(frame.data, frame.sampleRate);
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
      if (recorders.get(identity) === recorder) recorders.delete(identity);
      recorder?.close();
      vad.close();
      if (vads.get(identity) === vad) vads.delete(identity);
      listeningTracks.delete(key);
    }
  }

  let attachedRoom: Room | undefined;
  let listenerReconnect: Promise<void> | undefined;
  let listenerRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function waitBeforeRetry(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  function scheduleListenerRetry(): void {
    if (listenerRetryTimer !== undefined || closing) return;
    listenerRetryTimer = setTimeout(() => {
      listenerRetryTimer = undefined;
      void reconnectListener();
    }, LISTENER_RETRY_INTERVAL_MS);
    listenerRetryTimer.unref?.();
  }

  /**
   * LiveKit dropped the listener: rejoin it in the same room instead of exiting, because the characters and the
   * server's speech recognition must keep running. The room sees a speech outage while it is away, and the
   * persistent slow retry means a LiveKit restart longer than the quick attempts can still recover.
   */
  async function reconnectListener(): Promise<void> {
    if (closing || movingRoom) return;
    if (listenerReconnect !== undefined) return listenerReconnect;
    listenerReconnect = (async () => {
      listenerRoom = undefined;
      attachedRoom = undefined;
      speechOutage = 'Kaki lost its connection to the room. Reconnecting so everyone can be heard again.';
      publishSpeechStatus();
      log(`lost the connection to LiveKit; reconnecting ${KAKI_LISTENER_IDENTITY} to ${roomName}`);
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= LISTENER_RECONNECT_ATTEMPTS; attempt += 1) {
        if (closing || movingRoom) return;
        try {
          const joined = await joinListener();
          if (closing) {
            await joined.disconnect().catch(() => undefined);
            listenerRoom = undefined;
            return;
          }
          attachRoom(joined);
          speechOutage = undefined;
          log(`${KAKI_LISTENER_IDENTITY} is listening in ${roomName} again`);
          publishSpeechStatus();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          const retryIn = reconnectDelayMs(attempt);
          logError(
            `could not reconnect ${KAKI_LISTENER_IDENTITY} to ${roomName} (attempt ${attempt} of ${LISTENER_RECONNECT_ATTEMPTS}): ${lastError}; retrying in ${retryIn} ms`,
          );
          if (attempt < LISTENER_RECONNECT_ATTEMPTS) await waitBeforeRetry(retryIn);
        }
      }
      speechOutage = `Kaki lost its connection to the room and could not reconnect (${lastError ?? 'no reason given'}). The AI colleagues cannot hear anyone; the runner is still trying.`;
      publishSpeechStatus();
      logError(
        `${KAKI_LISTENER_IDENTITY} could not rejoin ${roomName}; will keep trying every ${LISTENER_RETRY_INTERVAL_MS} ms`,
      );
      scheduleListenerRetry();
    })().finally(() => {
      listenerReconnect = undefined;
    });
    return listenerReconnect;
  }

  function attachRoom(room: Room): void {
    if (attachedRoom === room) return;
    attachedRoom = room;
  room.on(RoomEvent.ParticipantConnected, registerHuman);
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (!humans.delete(participant.identity)) return;
    talking.delete(participant.identity);
    if (speechStates.delete(participant.identity)) publishSpeechStatus();
    log(`${participant.identity} left`);
    if (humans.size === 0) {
      // The server watches the room and pauses the meeting itself; the runner just reports it.
      options.onRoomEmpty?.();
      return;
    }
    syncCast();
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (isKakiListener(participant.identity) || meeting.castNames().has(participant.identity) || track.kind !== TrackKind.KIND_AUDIO) return;
    registerHuman(participant);
    void listenTo(track, participant.identity);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === FAKE_STT_TOPIC) {
      // Only the LiveKit server (an API-key holder) sends without a participant; a browser cannot forge this.
      if (options.fakeSpeech !== true || participant !== undefined) {
        log('ignored a fake-speech message: the fake recogniser is off or the sender is a participant');
        return;
      }
      let message: ReturnType<typeof parseFakeSpeechMessage>;
      try {
        message = parseFakeSpeechMessage(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        message = undefined;
      }
      if (message === undefined) log('ignored a malformed fake-speech message');
      else if (endedTerminal) log(`ignored fake speech from ${message.identity}: the meeting has ended`);
      else acceptFakeSpeech(message.identity, message.text);
      return;
    }
    if (topic !== STT_TOPIC || participant === undefined || isKakiListener(participant.identity) || meeting.castNames().has(participant.identity)) return;
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
    if (closing || movingRoom || attachedRoom !== room) return;
    void reconnectListener();
  });
    for (const participant of room.remoteParticipants.values()) {
      registerHuman(participant);
      if (isKakiListener(participant.identity) || meeting.castNames().has(participant.identity)) continue;
      // The person may already be in the room when the listener connects, so their audio subscription
      // happened before this handler existed. Start listening to every track that is already subscribed.
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (!publication.subscribed || track === undefined || track.kind !== TrackKind.KIND_AUDIO) continue;
        void listenTo(track as RemoteTrack, participant.identity);
      }
    }
  }
  if (listenerRoom === undefined) throw new Error('the technical listener did not join LiveKit');
  attachRoom(listenerRoom);

  /**
   * The room for a meeting identity. A real meeting's room is pinned when the runner is opened
   * (its identity never changes), while a practice meeting can rotate its identity under the same
   * runner and must follow the new identity's room instead of staying in the old one.
   */
  function roomForMeeting(meetingId: string): string {
    if (options.roomName === undefined) return demoRoomName(bootScenario, meetingId);
    pinnedRoomMeetingId ??= meetingId;
    return meetingId === pinnedRoomMeetingId ? options.roomName : demoRoomName(bootScenario, meetingId);
  }

  /** Join the permanent characters into `next`, retrying with backoff until it succeeds or the room moves on. */
  async function syncRoom(next: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      if (closing) throw new Error('the AI runner is stopping');
      // A newer move owns the room now: this attempt must never join the old one.
      if (roomName !== next) return;
      movingRoom = true;
      try {
        await leaveAll();
        characters.clear();
        listenerRoom = undefined;
        const joined = await joinListener();
        // Attach before the characters join, so a person already in the new room (or one arriving during the
        // join) is heard and a listener drop during the join can still be recovered.
        attachRoom(joined);
        for (const npc of permanent) await joinCharacter(npc);
        return;
      } catch (error) {
        const delay = reconnectDelayMs(attempt);
        logError(
          `could not move the AI attendees to ${next} (attempt ${attempt}): ${String(error)}; retrying in ${delay} ms`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
      } finally {
        movingRoom = false;
      }
    }
  }

  /**
   * A new meeting identity means a new room. The returned promise resolves once every permanent
   * character is in the new room, so a Start that is waiting for the cast is not reported ready
   * while the AI is still in the old (or boot) room.
   */
  function moveToRoom(next: string): Promise<void> {
    if (next === roomName) return Promise.resolve();
    const previous = roomName;
    roomName = next;
    log(`the meeting moved to a new room; leaving ${previous} for ${next}`);
    // A slow listener retry belongs to the room being left; syncRoom owns the new room's join.
    if (listenerRetryTimer !== undefined) {
      clearTimeout(listenerRetryTimer);
      listenerRetryTimer = undefined;
    }
    humans.clear();
    talking.clear();
    for (const vad of vads.values()) vad.close();
    vads.clear();
    speechLines.reset();
    speechStates.clear();
    consecutiveSpeechFailures = 0;
    speechOutage = undefined;
    publishSpeechStatus();
    const result = castQueue.then(
      () => syncRoom(next),
      () => syncRoom(next),
    );
    castQueue = result.catch(() => undefined);
    return result;
  }

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
    if (isTaskDispatch) {
      // Kaki's pop-up on the visitor's screen points at the follow-up; Sam is a colleague, not Kaki, so he says nothing.
      log(`${hostName} stays quiet on the card cue: Kaki's pop-up shows the follow-up`);
      conversation?.markCardShown({ onDone: (claimed) => onDone?.(claimed) });
      return;
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
    if (isNextUp && nextTitle !== undefined) {
      conversation.announceNextTopic(hostName, nextTitle, spoken, onDone);
      return;
    }
    conversation.announce(
      hostName,
      spoken,
      undefined,
      onDone,
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
    meetingSnapshot() {
      return meeting.current();
    },
    presentNames() {
      return [...humans.values()].map((person) => person.name);
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
    completedLinesOnTopic() {
      return conversation?.completedLinesOnTopic() ?? [];
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
        onDone?.(false);
        return;
      }
      conversation.announce(attendee, text, undefined, (spoken) => onDone?.(spoken));
    },
    askColleague(target, note, options) {
      if (endedTerminal || conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.askColleague(target, note, options);
    },
    markCardShown(options) {
      if (endedTerminal || conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.markCardShown(options);
    },
    pause() {
      applyLocalPause(true);
    },
    announceClosing(text) {
      const hostName = meeting.hostName();
      if (hostName === undefined || conversation === undefined) return;
      applyLocalPause(true);
      conversation.announceClosing(hostName, text);
    },
    async stop() {
      closing = true;
      if (listenerRetryTimer !== undefined) clearTimeout(listenerRetryTimer);
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      await castQueue;
      conversation?.close();
      for (const vad of vads.values()) vad.close();
      await leaveAll();
    },
  };
}
