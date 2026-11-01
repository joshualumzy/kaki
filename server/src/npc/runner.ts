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
  demoRoomName,
  humanAttendeeForRole,
  NPC_STATE_TOPIC,
  STT_TOPIC,
  type NpcStateMessage,
  type Scenario,
} from '@kaki/shared';
import type { ChatMessage } from '../llm';
import { createRoomToken } from '../livekit';
import { NpcConversation } from './conversation';
import type { Utterance } from './director';
import { playPcm } from './playback';
import { EnergyVad, type VadOptions } from './vad';

/** Sample rate of everything published to and read from LiveKit. */
export const SAMPLE_RATE = 16000;

export interface RunnerOptions {
  scenario: Scenario;
  livekitUrl: string;
  /** Defaults to the scenario's demo room. */
  roomName?: string;
  /** The Director's reply as it is written. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  /** A sentence as 16 kHz mono samples. */
  synthesize(utterance: Utterance, signal: AbortSignal): Promise<Int16Array>;
  /** A line spoken in the meeting, under the name Kaki's transcript uses. */
  postTranscript(speaker: string, text: string): void;
  responseDelayMs?: number;
  vad?: Partial<VadOptions>;
  log?(message: string): void;
  /** The connection to LiveKit was lost; the runner is no longer usable. */
  onDisconnected?(): void;
}

export interface NpcRunner {
  /** Leave the room and stop everything. */
  stop(): Promise<void>;
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
  const { scenario, livekitUrl } = options;
  const log = options.log ?? (() => undefined);
  const npcs = scenario.npcs ?? [];
  if (npcs.length === 0) throw new Error(`Scenario "${scenario.id}" defines no npcs, so there is nobody to run`);
  const npcNames = new Set(npcs.map((npc) => npc.attendee));
  const roomName = options.roomName ?? demoRoomName(scenario);

  // --- Join the room once per character, each publishing its own microphone track. ---
  const characters = new Map<string, Character>();
  const leaveAll = (): Promise<unknown> =>
    Promise.all([...characters.values()].map(({ room }) => room.disconnect().catch(() => undefined)));

  try {
    for (const npc of npcs) {
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
  } catch (error) {
    await leaveAll();
    throw error;
  }
  const listener = characters.values().next().value as Character;

  // --- What the AI attendees send out: state to the browser, transcript lines to Kaki. ---
  function publishState(state: NpcStateMessage): void {
    const data = new TextEncoder().encode(JSON.stringify(state));
    listener.room.localParticipant?.publishData(data, { reliable: true, topic: NPC_STATE_TOPIC }).catch(() => undefined);
  }

  const vads = new Map<string, EnergyVad>();
  const talking = new Set<string>();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;

  /** While the AI is audible the detector is stricter, with a short tail for the room's reverb. */
  function setGuard(on: boolean): void {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    const apply = (): void => {
      for (const vad of vads.values()) vad.guarded = on;
    };
    if (on) apply();
    else guardTimer = setTimeout(apply, 300);
  }

  function makeConversation(): NpcConversation<Int16Array> {
    return new NpcConversation<Int16Array>(
      {
        stream: options.stream,
        synthesize: options.synthesize,
        play: (speaker, clip, signal) => {
          const character = characters.get(speaker);
          if (character === undefined) return Promise.reject(new Error(`${speaker} is not in the room`));
          return playPcm(character.source, clip, SAMPLE_RATE, signal);
        },
        emitTranscript: (speaker, text) => {
          const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
          options.postTranscript(attendee?.zoomDisplayName ?? speaker, text);
        },
        emitState: (state) => {
          setGuard(state.kind === 'speaking');
          publishState(state);
        },
        log,
      },
      { scenario, responseDelayMs: options.responseDelayMs },
    );
  }

  // --- The person: their voice activity, and the words the browser recognised. ---
  let conversation = makeConversation();
  const humans = new Set<string>();
  let closing = false;

  function registerHuman(participant: RemoteParticipant): void {
    if (npcNames.has(participant.identity)) return;
    humans.add(participant.identity);
    const role = participant.metadata?.trim() || 'participant';
    const name = participant.name || participant.identity;
    conversation.setHuman({ name, role, transcriptName: humanAttendeeForRole(scenario, role)?.zoomDisplayName });
    log(`${name} joined as ${role}`);
  }

  async function listenTo(track: RemoteTrack, identity: string): Promise<void> {
    const vad = new EnergyVad((speaking) => {
      if (speaking) talking.add(identity);
      else talking.delete(identity);
      log(speaking ? `${identity} started talking` : `${identity} stopped talking`);
      conversation.humanSpeech(talking.size > 0);
    }, options.vad);
    vads.set(identity, vad);
    try {
      for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) vad.push(frame.data, frame.sampleRate);
    } catch (error) {
      log(`audio from ${identity} ended: ${String(error)}`);
    } finally {
      vad.close();
      vads.delete(identity);
    }
  }

  const room = listener.room;
  room.on(RoomEvent.ParticipantConnected, registerHuman);
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (!humans.delete(participant.identity)) return;
    talking.delete(participant.identity);
    log(`${participant.identity} left`);
    if (humans.size === 0) {
      // The next person starts a fresh conversation, not one that remembers the last.
      conversation.close();
      conversation = makeConversation();
    }
  });
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (npcNames.has(participant.identity) || track.kind !== TrackKind.KIND_AUDIO) return;
    registerHuman(participant);
    void listenTo(track, participant.identity);
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic !== STT_TOPIC || participant === undefined || npcNames.has(participant.identity)) return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
      if (typeof message.text === 'string') conversation.humanText(message.text);
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

  return {
    async stop() {
      closing = true;
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      conversation.close();
      for (const vad of vads.values()) vad.close();
      await leaveAll();
    },
  };
}
