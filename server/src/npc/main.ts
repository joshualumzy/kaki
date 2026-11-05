// Must stay the first import: later modules read process.env as they load.
import '../env';
import { llmFromEnv } from '../llm';
import { aiCast, type KakiCommand, type KakiEvent, type Role } from '@kaki/shared';
import { WebSocket } from 'ws';
import { loadScenario } from '../loadScenario';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from './wav';
import { createAzureStt } from './azureStt';
import { createAzureTts } from './azureTts';
import { DEFAULT_RESPONSE_DELAY_MS, DEFAULT_SPEAKER_GAP_MS } from './conversation';
import { startNpcRunner } from './runner';
import { createTaskResponder } from './taskResponder';
import { DEFAULT_VAD_OPTIONS, type VadOptions } from './vad';

/** `npm run npc`: the AI attendees of the live demo meeting, wired to the real model, Azure speech and Kaki. */

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

const scenario = await loadScenario();
const npcs = scenario.npcs ?? [];

const llm = llmFromEnv();
if (llm?.stream === undefined) {
  throw new Error('The AI attendees need an LLM: set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL in .env');
}
const stream = llm.stream.bind(llm);
const temperature = numberEnv('NPC_TEMPERATURE', 0.8);

const azureHint = 'Add your Azure Speech key and region to .env (see .env.example).';
const synthesize = createAzureTts(
  requireEnv('AZURE_SPEECH_KEY', azureHint),
  requireEnv('AZURE_SPEECH_REGION', azureHint),
  (speaker) => npcs.find((npc) => npc.attendee === speaker)?.voice,
);

// Server-side recognition by default: it hears the echo-cancelled microphone track, so it does not pick up the
// AI's own voice, and it can lean towards the names and words of this meeting. NPC_STT=browser uses Chrome's.
const sttMode = process.env.NPC_STT || 'azure';
if (sttMode !== 'azure' && sttMode !== 'browser') throw new Error(`NPC_STT must be "azure" or "browser", got "${sttMode}"`);
const recognizer =
  sttMode === 'browser'
    ? undefined
    : createAzureStt(requireEnv('AZURE_SPEECH_KEY', azureHint), requireEnv('AZURE_SPEECH_REGION', azureHint), {
        locale: process.env.NPC_STT_LOCALE || 'en-SG',
        phrases: [
          ...new Set([
            ...(scenario.vocabulary ?? []),
            ...scenario.attendees.map((attendee) => attendee.name),
            scenario.organisation,
          ]),
        ],
      });

const kakiUrl = process.env.KAKI_URL || `http://localhost:${process.env.PORT ?? '3001'}`;
let lastTranscriptError = 0;

/** Send one transcript line to Kaki, and say so (at most every ten seconds) if that does not work. */
function postTranscript(speaker: string, text: string): void {
  const complain = (message: string): void => {
    if (Date.now() - lastTranscriptError < 10_000) return;
    lastTranscriptError = Date.now();
    log(message);
  };
  fetch(`${kakiUrl}/dev/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker, text, timestamp: new Date().toISOString() },
    }),
  })
    .then(async (response) => {
      if (!response.ok) {
        complain(`Kaki rejected a transcript line (HTTP ${response.status}); is the server running with KAKI_DEV_ROUTES=1? ${await response.text()}`);
      }
    })
    .catch((error: unknown) => complain(`Could not reach Kaki at ${kakiUrl}: ${String(error)}`));
}

// NPC_DEBUG_AUDIO_DIR=some/folder saves every stretch of your speech that was sent to Azure as a WAV file,
// named by time like the log lines, so you can listen to exactly what the server heard.
const debugAudioDir = process.env.NPC_DEBUG_AUDIO_DIR || undefined;
if (debugAudioDir !== undefined) mkdirSync(debugAudioDir, { recursive: true });
function debugAudio(samples: Int16Array): void {
  if (debugAudioDir === undefined) return;
  const file = join(debugAudioDir, `${new Date().toISOString().slice(11, 23).replace(/[:.]/g, '-')}.wav`);
  writeFileSync(file, encodeWav(samples, 16000));
  log(`saved ${(samples.length / 16000).toFixed(1)} s of what the server heard: ${file}`);
}

const vad: Partial<VadOptions> = {
  minLevel: numberEnv('NPC_VAD_MIN_LEVEL', DEFAULT_VAD_OPTIONS.minLevel),
  guardedMinLevel: numberEnv('NPC_VAD_GUARDED_MIN_LEVEL', DEFAULT_VAD_OPTIONS.guardedMinLevel),
  startMs: numberEnv('NPC_VAD_START_MS', DEFAULT_VAD_OPTIONS.startMs),
  guardedStartMs: numberEnv('NPC_VAD_GUARDED_START_MS', DEFAULT_VAD_OPTIONS.guardedStartMs),
  hangoverMs: numberEnv('NPC_VAD_HANGOVER_MS', DEFAULT_VAD_OPTIONS.hangoverMs),
  leakMargin: numberEnv('NPC_VAD_LEAK_MARGIN', DEFAULT_VAD_OPTIONS.leakMargin),
  leakCap: numberEnv('NPC_VAD_LEAK_CAP', DEFAULT_VAD_OPTIONS.leakCap),
};

const runner = await startNpcRunner({
  scenario,
  livekitUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
  stream: (messages, signal) => stream(messages, { signal, temperature }),
  synthesize,
  postTranscript,
  responseDelayMs: numberEnv('NPC_RESPONSE_DELAY_MS', DEFAULT_RESPONSE_DELAY_MS),
  recognizer,
  debugAudio: debugAudioDir === undefined ? undefined : debugAudio,
  speakerGapMs: numberEnv('NPC_SPEAKER_GAP_MS', DEFAULT_SPEAKER_GAP_MS),
  vad,
  traceVad: process.env.NPC_DEBUG_VAD === '1',
  log,
  onDisconnected: () => {
    log('exiting so it can be restarted');
    process.exit(1);
  },
});

// An AI attendee has no phone. When a task is dispatched to their role they answer aloud and this sends their
// Accept or Decline (and approves the draft), over a socket opened as that role like a phone would.
const roleSockets = new Map<Role, { socket: WebSocket; queue: string[] }>();
function sendAs(role: Role, command: KakiCommand): void {
  let entry = roleSockets.get(role);
  if (entry === undefined || entry.socket.readyState > WebSocket.OPEN) {
    const socket = new WebSocket(`${kakiUrl.replace(/^http/, 'ws')}/ws?role=${encodeURIComponent(role)}`);
    entry = { socket, queue: [] };
    const current = entry;
    socket.on('open', () => {
      for (const message of current.queue.splice(0)) socket.send(message);
    });
    socket.on('error', (error) => log(`could not send as ${role}: ${error.message}`));
    roleSockets.set(role, entry);
  }
  const message = JSON.stringify(command);
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(message);
  else entry.queue.push(message);
}
const taskResponder = createTaskResponder({
  scenario,
  llm,
  plays: (attendee) => runner.plays(attendee),
  say: (attendee, text, onDone) => runner.say(attendee, text, onDone),
  send: sendAs,
  log,
});

// The Host's spoken cues (opening, time-out, closing) arrive as events for the shared screen; the host character voices them.
// What the hub replays on connecting (the retained opening) is old news: only cues after the first second are spoken.
// Needs auth to be off, or the screen to be signed in (the socket is the same as the shared screen's).
function followHostCues(): void {
  const url = `${kakiUrl.replace(/^http/, 'ws')}/ws?role=screen`;
  const socket = new WebSocket(url);
  const openedAt = { at: 0 };
  socket.on('open', () => {
    openedAt.at = Date.now();
  });
  socket.on('message', (data) => {
    if (Date.now() - openedAt.at < 1000) return;
    try {
      const event = JSON.parse(data.toString()) as { type?: string; payload?: { text?: unknown } };
      if (event.type === 'TASK_UPDATED') taskResponder.handle(event as unknown as KakiEvent);
      if (event.type === 'HOST_SPEECH_TRIGGERED' && typeof event.payload?.text === 'string') {
        runner.announce(event.payload.text);
      }
    } catch {
      /* not an event we understand */
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => setTimeout(followHostCues, 3000).unref());
}
followHostCues();

log(`speech recognition: ${sttMode === 'azure' ? `Azure (${process.env.NPC_STT_LOCALE || 'en-SG'})` : "the browser's"}`);
log(
  `ready: ${aiCast(scenario).map((npc) => npc.attendee).join(' and ')} are in the room; the other characters join for whoever arrives, as everyone except the role they pick. Open /demo and talk.`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void runner.stop().then(() => process.exit(0)));
}
