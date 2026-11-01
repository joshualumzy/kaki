// Must stay the first import: later modules read process.env as they load.
import '../env';
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
import { llmFromEnv } from '../llm';
import { createRoomToken } from '../livekit';
import { loadScenario } from '../loadScenario';
import { createAzureTts, TTS_SAMPLE_RATE } from './azureTts';
import { NpcConversation } from './conversation';
import { DEFAULT_VAD_OPTIONS, EnergyVad, type VadOptions } from './vad';
import { playPcm } from './playback';

/**
 * Runs the AI attendees of the live demo meeting: joins the LiveKit room once per character,
 * listens to the person, and answers in the characters' voices. The decisions live in
 * `NpcConversation`; this file only connects it to LiveKit, Azure speech and Kaki.
 */

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

const log = (message: string): void => console.log(`[npc ${new Date().toISOString().slice(11, 23)}] ${message}`);

const scenario: Scenario = await loadScenario();
const npcs = scenario.npcs ?? [];
if (npcs.length === 0) throw new Error(`Scenario "${scenario.id}" defines no npcs, so there is nobody to run`);
const npcNames = new Set(npcs.map((npc) => npc.attendee));

const llm = llmFromEnv();
if (llm?.stream === undefined) {
  throw new Error('The AI attendees need an LLM: set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL in .env');
}
const stream = llm.stream.bind(llm);

const azureHint = 'Add your Azure Speech key and region to .env (see .env.example).';
const synthesize = createAzureTts(
  requireEnv('AZURE_SPEECH_KEY', azureHint),
  requireEnv('AZURE_SPEECH_REGION', azureHint),
  (speaker) => npcs.find((npc) => npc.attendee === speaker)?.voice,
);

const livekitUrl = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const kakiUrl = process.env.KAKI_URL || `http://localhost:${process.env.PORT ?? '3001'}`;
const roomName = demoRoomName(scenario);
const temperature = numberEnv('NPC_TEMPERATURE', 0.8);
const vadOptions: Partial<VadOptions> = {
  minLevel: numberEnv('NPC_VAD_MIN_LEVEL', DEFAULT_VAD_OPTIONS.minLevel),
  guardedMinLevel: numberEnv('NPC_VAD_GUARDED_MIN_LEVEL', DEFAULT_VAD_OPTIONS.guardedMinLevel),
  startMs: numberEnv('NPC_VAD_START_MS', DEFAULT_VAD_OPTIONS.startMs),
  guardedStartMs: numberEnv('NPC_VAD_GUARDED_START_MS', DEFAULT_VAD_OPTIONS.guardedStartMs),
  hangoverMs: numberEnv('NPC_VAD_HANGOVER_MS', DEFAULT_VAD_OPTIONS.hangoverMs),
};

// --- Join the room once per character, each publishing its own microphone track. ---

interface Character {
  room: Room;
  source: AudioSource;
}

const characters = new Map<string, Character>();
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
  const source = new AudioSource(TTS_SAMPLE_RATE, 1, 400);
  const track = LocalAudioTrack.createAudioTrack('microphone', source);
  await room.localParticipant?.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  characters.set(npc.attendee, { room, source });
  log(`${npc.attendee} joined ${roomName}`);
}
const listener = characters.values().next().value as Character;

// --- What the AI attendees send out: transcript lines to Kaki, state to the browser. ---

let lastTranscriptError = 0;
function postTranscript(speaker: string, text: string): void {
  const attendee = scenario.attendees.find((candidate) => candidate.name === speaker);
  fetch(`${kakiUrl}/dev/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: attendee?.zoomDisplayName ?? speaker, text, timestamp: new Date().toISOString() },
    }),
  })
    .then(async (response) => {
      if (response.ok || Date.now() - lastTranscriptError < 10_000) return;
      lastTranscriptError = Date.now();
      log(`Kaki rejected a transcript line (HTTP ${response.status}); is the server running with KAKI_DEV_ROUTES=1? ${await response.text()}`);
    })
    .catch((error: unknown) => {
      if (Date.now() - lastTranscriptError < 10_000) return;
      lastTranscriptError = Date.now();
      log(`Could not reach Kaki at ${kakiUrl}: ${String(error)}`);
    });
}

function publishState(state: NpcStateMessage): void {
  const data = new TextEncoder().encode(JSON.stringify(state));
  listener.room.localParticipant?.publishData(data, { reliable: true, topic: NPC_STATE_TOPIC }).catch(() => undefined);
}

// --- The person: their voice activity, and the words the browser recognised. ---

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
      stream: (messages, signal) => stream(messages, { signal, temperature }),
      synthesize,
      play: (speaker, clip, signal) => {
        const character = characters.get(speaker);
        if (character === undefined) return Promise.reject(new Error(`${speaker} is not in the room`));
        return playPcm(character.source, clip, TTS_SAMPLE_RATE, signal);
      },
      emitTranscript: postTranscript,
      emitState: (state) => {
        setGuard(state.kind === 'speaking');
        publishState(state);
      },
      log,
    },
    { scenario, responseDelayMs: numberEnv('NPC_RESPONSE_DELAY_MS', 900) },
  );
}

let conversation = makeConversation();
const humans = new Set<string>();

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
  }, vadOptions);
  vads.set(identity, vad);
  try {
    for await (const frame of new AudioStream(track, TTS_SAMPLE_RATE, 1)) vad.push(frame.data, frame.sampleRate);
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
let closing = false;
room.on(RoomEvent.Disconnected, () => {
  if (closing) return;
  log('lost the connection to LiveKit; exiting so it can be restarted');
  process.exit(1);
});
for (const participant of room.remoteParticipants.values()) registerHuman(participant);

log(`ready: ${[...npcNames].join(' and ')} are in the room. Open /demo and talk.`);

async function shutdown(): Promise<void> {
  closing = true;
  conversation.close();
  await Promise.all([...characters.values()].map(({ room: npcRoom }) => npcRoom.disconnect().catch(() => undefined)));
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
