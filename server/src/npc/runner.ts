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
  setMeetingAgenda,
  STT_TOPIC,
  type NpcProfile,
  type NpcStateMessage,
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
  /** A line said in the meeting, under the name Kaki's transcript uses; `textOnly` marks a line shown as text because its voice failed. */
  postTranscript(speaker: string, text: string, options?: { textOnly?: boolean }): void;
  responseDelayMs?: number;
  /** Called when the last person has left the room (not when the room was empty to begin with). */
  onRoomEmpty?: () => void;
  /** Called when a person takes the host's seat or leaves it (also false when the room empties). */
  onHostChange?: (human: boolean) => void;
  /** Called when an observe-only agenda item has been talked through and the meeting should move on. */
  onAdvanceAgenda?: () => void;
  /** Called when the final agenda item has wrapped up and the meeting should conclude. */
  onEndMeeting?: () => void;
  /** Called when the visitor pauses or resumes the meeting via the TypeBar button or Escape. */
  onPauseChange?: (paused: boolean) => void;
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
  /** Fetch the latest scenario agenda order from the Kaki server when a new visitor session starts. */
  fetchScenario?(): Promise<Scenario | undefined>;
  /** Emit a live 1-sentence Wingman coaching brief for the current agenda item when the visitor's turn updates the discussion state. */
  onWingmanTip?(tip: string, title: string, agendaIndex: number): void;
  /** The visitor's decision on the current item is locked; `followUp` is the task that announces it. */
  onTopicSettled?(followUp: SuggestInput, reopened?: boolean): void | Promise<void>;
  onMemoryChange?(entries: MeetingMemoryEntry[]): void;
  onReaction?(who: string, emoji: string): void;
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
  /** Pause the current conversation (for example when the meeting ends). */
  pause(): void;
  /** Interrupt any running AI turn, speak the closing line from the host, and then keep the conversation stopped. */
  announceClosing(text: string): void;
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
  /** Start a fresh meeting after the server's MEETING_RESET: close the conversation and forget the welcome. */
  resetMeeting(): void;
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
  const { scenario, livekitUrl } = options;
  const log = options.log ?? (() => undefined);
  const memory = new MeetingMemory(scenario, (entries) => options.onMemoryChange?.(entries), log);
  const npcs = scenario.npcs ?? [];
  if (npcs.length === 0) throw new Error(`Scenario "${scenario.id}" defines no npcs, so there is nobody to run`);
  const npcNames = new Set(npcs.map((npc) => npc.attendee));
  // Characters nobody can play stay in the room and listen; the rest join for the person who arrives,
  // as everyone except the seat that person took.
  // When every character is playable (the host's seat too), the host stays connected as a silent listener
  // while a person plays their seat: the AI Sam steps out of the conversation, not out of the room.
  const hostProfile = npcs.find((npc) => npc.role === 'host');
  const hostName = hostProfile?.attendee;
  const alwaysAi = aiCast(scenario);
  const listenerProfile = alwaysAi[0] ?? hostProfile ?? npcs[0]!;
  const permanent = alwaysAi.length > 0 ? alwaysAi : [listenerProfile];
  const roomName = options.roomName ?? demoRoomName(scenario);

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
          const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
          options.postTranscript(attendee?.zoomDisplayName ?? speaker, text, transcriptOptions);
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
      { scenario: { ...scenario, npcs: cast }, memory, responseDelayMs: options.responseDelayMs, speakerGapMs: options.speakerGapMs, sentenceGapMs: options.sentenceGapMs, bargeInMs: options.bargeInMs },
    );
  }

  // --- The person: their voice activity, and the words the browser recognised. ---
  let conversation: NpcConversation<Int16Array> | undefined;
  let castNames = '';
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
   */
  let started = false;
  let paused = false;
  const meetingOpen = (): boolean => (started || hostIsHuman()) && !paused;
  function syncCast(): void {
    castQueue = castQueue
      .then(async () => {
        if (closing) return;
        // Nobody is in the room: keep the conversation paused in case someone returns. Only the server's
        // MEETING_RESET tears it down, so both processes agree on when a meeting really ends.
        if (humans.size === 0) return;
        const seats = new Set([...humans.values()].flatMap((person) => (person.seat === undefined ? [] : [person.seat])));
        const wanted = npcs.filter((npc) => npc.playable !== true || !seats.has(npc.attendee));
        for (const npc of wanted) await joinCharacter(npc);
        for (const [name, character] of [...characters]) {
          if (name === listenerProfile.attendee || wanted.some((npc) => npc.attendee === name)) continue;
          characters.delete(name);
          await character.room.disconnect().catch(() => undefined);
          log(`${name} left ${roomName}`);
        }

        const names = wanted.map((npc) => npc.attendee).join(',');
        if (conversation === undefined || names !== castNames || !started) {
          if (options.fetchScenario !== undefined) {
            let failure: string | undefined;
            const latest = await options.fetchScenario().catch((error: unknown) => {
              failure = String(error).slice(0, 300);
              return undefined;
            });
            if (latest !== undefined && Array.isArray(latest.agenda) && latest.agenda.length > 0) {
              setMeetingAgenda(scenario, latest, latest.agenda);
            } else {
              log(`ERROR: scenario fetch or validation failed: ${failure ?? 'no usable scenario returned'}; keeping current agenda as last resort`);
            }
          }
          if (conversation === undefined || names !== castNames) {
            conversation?.close();
            conversation = makeConversation(wanted);
            castNames = names;
          }
          const person = [...humans.values()].at(-1)!;
          const role = scenario.roles.find(
            (candidate) => candidate.id.toLowerCase() === person.role.trim().toLowerCase() || candidate.label.toLowerCase() === person.role.trim().toLowerCase(),
          );
          conversation.setHuman({
            name: person.name,
            role: person.role,
            transcriptName: role === undefined ? person.name : `${person.name} (${role.label})`,
          });
        }
        // Sam welcomes the person once they press Start, before anyone else speaks (when a person hosts, the NPC co-host kicks off item 1's briefing).
        if (started && !welcomed) {
          if (!hostIsHuman()) {
            conversation?.agendaMoved(scenario.agenda[0]?.title);
            announce(openingLine(scenario));
          } else {
            welcomed = true;
            conversation?.agendaMoved(scenario.agenda[0]?.title);
          }
        }
        if (rejoinPending) {
          rejoinPending = false;
          resumeFromEmptyRoom();
        }
      })
      .catch((error: unknown) => log(`could not change who is in the meeting: ${String(error)}`));
  }

  let lastHostHuman = false;
  function reportHost(): void {
    const now = hostIsHuman();
    if (now === lastHostHuman) return;
    lastHostHuman = now;
    options.onHostChange?.(now);
  }

  /** The meeting was paused because the room emptied, not because the person pressed Pause. */
  let emptyPaused = false;
  /** A person came back into an empty room; resume once the cast for them is ready. */
  let rejoinPending = false;

  /** Nobody is in the room: hold the conversation exactly where it is, like pressing Pause. */
  function pauseForEmptyRoom(): void {
    if (!started && !hostIsHuman()) return;
    if (paused) return;
    paused = true;
    emptyPaused = true;
    talking.clear();
    for (const vad of vads.values()) vad.close();
    options.onPauseChange?.(true);
    conversation?.stop();
    log('the room is empty; the meeting is paused in case someone returns');
  }

  /** The person is back inside the grace window: carry on, and let Sam say one welcome-back line. */
  function resumeFromEmptyRoom(): void {
    if (!emptyPaused) return;
    emptyPaused = false;
    paused = false;
    options.onPauseChange?.(false);
    if (conversation !== undefined && !hostIsHuman() && hostName !== undefined) {
      const title = conversation.currentTopicTitle();
      const line = title === undefined
        ? 'Welcome back.'
        : `Welcome back — we were on ${spokenAgendaName(scenario, title)}.`;
      conversation.resumeAfterRejoin(hostName, line);
    } else {
      conversation?.resumeFromPause();
    }
    log('someone returned; the meeting resumes');
  }

  function registerHuman(participant: RemoteParticipant): void {
    if (npcNames.has(participant.identity)) return;
    const role = participant.metadata?.trim() || 'participant';
    const name = participant.name || participant.identity;
    const seat = humanAttendeeForRole(scenario, role)?.name;
    const known = humans.get(participant.identity);
    if (known !== undefined && known.role === role && known.name === name) return;
    if (humans.size === 0 && emptyPaused) rejoinPending = true;
    humans.set(participant.identity, { name, role, seat });
    reportHost();
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
              conversation?.humanText(text);
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
    reportHost();
    if (humans.size === 0) {
      // Hold the meeting where it is; the server decides whether a later join resumes it or resets it.
      pauseForEmptyRoom();
      options.onRoomEmpty?.();
      return;
    }
    syncCast();
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (npcNames.has(participant.identity) || track.kind !== TrackKind.KIND_AUDIO) return;
    registerHuman(participant);
    void listenTo(track, participant.identity);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === CONTROL_TOPIC && participant !== undefined && !npcNames.has(participant.identity)) {
      let message: ReturnType<typeof parseControlMessage>;
      try {
        message = parseControlMessage(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        message = undefined;
      }
      if (message === undefined) {
        log('ignored a malformed control message');
      } else if (message.kind === 'typing') {
        typingUntil = Date.now() + TYPING_QUIET_MS;
        conversation?.humanTyping();
      } else if (message.kind === 'start') {
        const session = message.session ?? participant.identity;
        log(`received Start from ${participant.identity} (requestId=${message.requestId ?? 'none'}, session=${session})`);
        if (session !== participant.identity) {
          log(`ignored a Start for another session (${session})`);
          return;
        }
        if (!started) {
          started = true;
          log(`${participant.identity} started the meeting`);
          syncCast();
        }
        if (message.requestId !== undefined) {
          log(`acknowledged Start requestId=${message.requestId} for ${session}`);
          publishState({ kind: 'started', requestId: message.requestId, session });
        }
      } else if (message.kind === 'stop') {
        if (!started && !hostIsHuman()) {
          log('ignored stop: the meeting has not started');
          return;
        }
        paused = true;
        options.onPauseChange?.(true);
        talking.clear();
        for (const vad of vads.values()) vad.close();
        log(`${participant.identity} pressed stop`);
        conversation?.stop();
      } else if (message.kind === 'resume') {
        if (!started && !hostIsHuman()) {
          log('ignored resume: the meeting has not started');
          return;
        }
        paused = false;
        options.onPauseChange?.(false);
        log(`${participant.identity} pressed resume`);
        conversation?.resumeFromPause();
      } else if (message.kind === 'lock') {
        if (started || hostIsHuman()) conversation?.lockDecision();
      } else if (!started && !hostIsHuman()) {
        log('ignored typed text: the meeting has not started');
      } else {
        if (paused) {
          paused = false;
          options.onPauseChange?.(false);
        }
        typingUntil = Date.now() + TYPING_QUIET_MS;
        if (message.kind === 'text') conversation?.humanTyped(message.text);
      }
      return;
    }
    if (topic !== STT_TOPIC || participant === undefined || npcNames.has(participant.identity)) return;
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
        ? liveOpeningLine(scenario, visitor, log)
        : isNextUp && nextTitle !== undefined
          ? liveNextItemLine(scenario, nextTitle, visitor,
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
        : scenario.agenda.findIndex((item) => item.title === topicTitle);
      spoken = visitorDispatchLine(dispatchedName, 1, topicIndex === undefined || topicIndex < 0 ? undefined : topicIndex);
    }
    const timeoutMatch =
      /^Time is up on (.+?)\. Keep going, or move on to (.+?)\?$/i.exec(spoken.trim()) ??
      /^(.+?) is at (\d+) minutes, please wrap up\.$/i.exec(spoken.trim()) ??
      /^Hey team, we're a bit past time on (.+?) — let's wrap this one up so we can move on\.$/i.exec(spoken.trim());
    if (timeoutMatch !== null) {
      if (conversation.shouldSkipOvertimeCue()) return;
      const personName = person?.name;
      const itemTitle = spokenAgendaName(scenario, timeoutMatch[1] ?? 'this item');
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
    return hostProfile !== undefined && [...humans.values()].some((person) => person.seat === hostProfile.attendee);
  }

  return {
    announce,
    resetMeeting() {
      conversation?.close();
      conversation = undefined;
      castNames = '';
      welcomed = false;
      visitorTaskDispatches = 0;
      visitorDispatchTopic = undefined;
      started = false;
      paused = false;
      emptyPaused = false;
      rejoinPending = false;
      memory.reset();
      lastConversationState = { kind: 'idle' };
      publishState(lastConversationState);
      if (humans.size > 0) syncCast();
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
      return scenario.roles.find((role) => role.id === wanted || role.label === wanted)?.id;
    },
    say(attendee, text, onDone) {
      if (conversation === undefined) {
        onDone?.();
        return;
      }
      conversation.announce(attendee, text, undefined, () => onDone?.());
    },
    askColleague(target, note, options) {
      if (conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.askColleague(target, note, options);
    },
    pointAtCard(note, options) {
      if (conversation === undefined) {
        options?.onDone?.(false);
        return;
      }
      conversation.pointAtCard(note, options);
    },
    pause() {
      paused = true;
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation?.stop();
    },
    announceClosing(text) {
      if (hostName === undefined || conversation === undefined) return;
      paused = true;
      talking.clear();
      for (const vad of vads.values()) vad.close();
      conversation.announceClosing(hostName, text);
    },
    async stop() {
      closing = true;
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      if (humanSpeakingTimer !== undefined) clearTimeout(humanSpeakingTimer);
      await castQueue;
      conversation?.close();
      for (const vad of vads.values()) vad.close();
      await leaveAll();
    },
  };
}
