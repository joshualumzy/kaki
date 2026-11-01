// Must stay the first import: later modules read process.env as they load.
import '../env';
import { llmFromEnv } from '../llm';
import { aiCast } from '@kaki/shared';
import { loadScenario } from '../loadScenario';
import { createAzureTts } from './azureTts';
import { DEFAULT_RESPONSE_DELAY_MS } from './conversation';
import { startNpcRunner } from './runner';
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

const vad: Partial<VadOptions> = {
  minLevel: numberEnv('NPC_VAD_MIN_LEVEL', DEFAULT_VAD_OPTIONS.minLevel),
  guardedMinLevel: numberEnv('NPC_VAD_GUARDED_MIN_LEVEL', DEFAULT_VAD_OPTIONS.guardedMinLevel),
  startMs: numberEnv('NPC_VAD_START_MS', DEFAULT_VAD_OPTIONS.startMs),
  guardedStartMs: numberEnv('NPC_VAD_GUARDED_START_MS', DEFAULT_VAD_OPTIONS.guardedStartMs),
  hangoverMs: numberEnv('NPC_VAD_HANGOVER_MS', DEFAULT_VAD_OPTIONS.hangoverMs),
};

const runner = await startNpcRunner({
  scenario,
  livekitUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
  stream: (messages, signal) => stream(messages, { signal, temperature }),
  synthesize,
  postTranscript,
  responseDelayMs: numberEnv('NPC_RESPONSE_DELAY_MS', DEFAULT_RESPONSE_DELAY_MS),
  vad,
  traceVad: process.env.NPC_DEBUG_VAD === '1',
  log,
  onDisconnected: () => {
    log('exiting so it can be restarted');
    process.exit(1);
  },
});

log(
  `ready: ${aiCast(scenario).map((npc) => npc.attendee).join(' and ')} are in the room; the other characters join for whoever arrives, as everyone except the role they pick. Open /demo and talk.`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void runner.stop().then(() => process.exit(0)));
}
