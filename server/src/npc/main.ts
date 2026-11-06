// Must stay the first import: later modules read process.env as they load.
import '../env';
import { llmFromEnv } from '../llm';
import { aiCast, parseScenario, type KakiCommand, type KakiEvent, type Role } from '@kaki/shared';
import { WebSocket } from 'ws';
import { loadScenario } from '../loadScenario';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from './wav';
import { createAzureStt } from './azureStt';
import { createAzureTts } from './azureTts';
import { DEFAULT_BARGE_IN_MS, DEFAULT_RESPONSE_DELAY_MS, DEFAULT_SENTENCE_GAP_MS, DEFAULT_SPEAKER_GAP_MS } from './conversation';
import { startNpcRunner } from './runner';
import { colleagueLine } from '../host/autoDispatch';
import { createCueOrder } from './cueOrder';
import { createTaskResponder, DEFAULT_APPROVE_DELAY_MS } from './taskResponder';
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
        minConfidence: numberEnv('NPC_STT_MIN_CONFIDENCE', 0.6),
        log,
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
  sentenceGapMs: numberEnv('NPC_SENTENCE_GAP_MS', DEFAULT_SENTENCE_GAP_MS),
  bargeInMs: numberEnv('NPC_BARGE_IN_MS', DEFAULT_BARGE_IN_MS),
  vad,
  traceVad: process.env.NPC_DEBUG_VAD === '1',
  log,
  // The visitor left: end the meeting so its clock stops and the next visitor starts clean (silent: nobody to hear a closing line).
  onRoomEmpty: () => {
    log('the room is empty; ending the meeting');
    sendAs('screen', { type: 'END_MEETING', silent: true });
  },
  onHostChange: (human) => sendAs('screen', { type: 'SET_HOST_MODE', human }),
  onAdvanceAgenda: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
  },
  onEndMeeting: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'END_MEETING' });
  },
  onDisconnected: () => {
    log('exiting so it can be restarted');
    process.exit(1);
  },
  fetchScenario: async () => {
    const response = await fetch(`${kakiUrl}/api/scenario`);
    if (!response.ok) return undefined;
    return parseScenario(await response.json());
  },
});

// An AI attendee has no phone. When a task is dispatched to their role they answer aloud and this sends their
// Accept or Decline (and approves the draft), over a socket opened as that role like a phone would.
const roleSockets = new Map<Role | 'screen', { socket: WebSocket; queue: string[] }>();
function sendAs(role: Role | 'screen', command: KakiCommand): void {
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
// Sam asks an AI colleague aloud, then the colleague answers: the answer waits for the question (see cueOrder.ts).
const cueOrder = createCueOrder();
const taskResponder = createTaskResponder({
  scenario,
  llm,
  plays: (attendee) => runner.plays(attendee),
  say: (attendee, text, onDone) =>
    cueOrder.after((spoken) => {
      if (spoken) runner.say(attendee, text, onDone);
      else onDone();
    }),
  send: sendAs,
  log,
  approveDelayMs: numberEnv('NPC_APPROVE_DELAY_MS', DEFAULT_APPROVE_DELAY_MS),
});

// The Host's spoken cues (opening, time-out, closing) arrive as events for the shared screen; the host character voices them.
// What the hub replays on connecting (the retained opening) is old news: only cues after the first second are spoken.
// Needs auth to be off, or the screen to be signed in (the socket is the same as the shared screen's).
let dispatchCount = 0;
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
      if (event.type === 'TASK_UPDATED') {
        const updatedTask = (event.payload as { task?: { id?: string; status?: string } } | undefined)?.task;
        if (updatedTask?.status === 'DISPATCHED' && !runner.canDispatchTask()) {
          log(`dismissed premature task ${updatedTask.id ?? ''} before visitor spoke on this item`);
          if (updatedTask.id !== undefined) sendAs('screen', { type: 'DISMISS_TASK', taskId: updatedTask.id });
          return;
        }
        taskResponder.handle(event as unknown as KakiEvent);
        if (updatedTask?.status === 'CLAIMED') runner.taskAccepted();
      }
      // With a person in the host's seat these cues are only suggestions on their Host tab; nobody voices them.
      if (event.type === 'HOST_SPEECH_TRIGGERED' && typeof event.payload?.text === 'string' && !runner.hostIsHuman()) {
        const payload = event.payload as { kind?: string; text: string; assignee?: string; title?: string };
        if (payload.kind === 'DISPATCH' && !runner.canDispatchTask()) return;
        if (payload.kind === 'CLOSING') {
          runner.announceClosing(payload.text);
          return;
        }
        // A colleague played by an AI is asked in plain words, with no phone to mention; the visitor gets the full line.
        const colleague = payload.kind === 'DISPATCH' && payload.assignee !== undefined && payload.title !== undefined && runner.plays(payload.assignee);
        if (colleague) cueOrder.cue((done) => runner.announce(colleagueLine(payload.assignee!, payload.title!, dispatchCount++), done));
        else runner.announce(payload.text);
        if (event.payload.text.startsWith('Next up:')) runner.agendaMoved(event.payload.text.replace(/^Next up:\s*/, '').replace(/\.$/, ''));
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
