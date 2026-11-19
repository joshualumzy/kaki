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
import { DEFAULT_BARGE_IN_MS, DEFAULT_SENTENCE_GAP_MS, DEFAULT_SPEAKER_GAP_MS } from './conversation';
import { startNpcRunner, type RunnerMeetingState } from './runner';
import { createMeetingSync, parsePrepareRequest, parseStartedEvent, type PrepareRequest } from './meetingSync';
import { colleagueCue, guestCardNote, shouldStillAskColleague } from '../host/autoDispatch';
import { createCueOrder } from './cueOrder';
import { createTaskResponder, DEFAULT_APPROVE_DELAY_MS } from './taskResponder';
import { postMeetingMemory, postSettledTopic } from './settlement';
import { DEFAULT_VAD_OPTIONS, type VadOptions } from './vad';
import { faultFromEnv, faultyStream, faultySynthesize } from './fault';

/** `npm run npc`: the AI attendees of the live demo meeting, wired to the real model, Azure speech and Kaki. */

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function reasoningEnv(name: string): 'none' | 'low' | 'medium' | 'high' | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'none' || raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  throw new Error(`${name} must be none, low, medium or high, got "${raw}"`);
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

const log = (message: string): void => console.log(`[npc ${new Date().toISOString().slice(11, 23)}] ${message}`);
const logError = (message: string): void => console.error(`[npc ${new Date().toISOString().slice(11, 23)}] ${message}`);

// KAKI_FAULT shows one failure on purpose during a live check; unset is off.
const fault = faultFromEnv(process.env.KAKI_FAULT);
if (fault !== undefined) log(`[fault] ${fault} active`);

const scenario = await loadScenario();
const npcs = scenario.npcs ?? [];
/** The AI host's name, chosen the same way the conversation chooses who chairs; the host never speaks these cues when a person is in that seat. */
const hostName =
  npcs.find((npc) => npc.role === 'host')?.attendee ??
  npcs.find((npc) => npc.role === 'participant')?.attendee ??
  npcs[0]?.attendee;

const llm = llmFromEnv();
if (llm?.stream === undefined) {
  throw new Error('The AI attendees need an LLM: set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL in .env');
}
const stream = llm.stream.bind(llm);
const temperature = numberEnv('NPC_TEMPERATURE', 0.8);
// NPC_REASONING sets how long the model thinks before each spoken line (none|low|medium|high). Default none:
// thinking added ~4 s before the first sentence, sometimes over 12 s, and judged lines were no better with it.
const reasoningEffort = reasoningEnv('NPC_REASONING') ?? 'none';
log(`spoken lines use reasoning effort "${reasoningEffort}"`);
const streamWithFault = faultyStream(
  (messages, signal) =>
    stream(messages, { signal, temperature, reasoningEffort }),
  fault,
  numberEnv('KAKI_LLM_IDLE_MS', 10_000),
);
// The backup model, used for the one retry after a spoken line misses its first-sentence deadline.
const fallback = llm.fallbackStream?.bind(llm);
const fallbackStreamWithFault = fallback === undefined
  ? undefined
  : faultyStream(
    (messages, signal) =>
      fallback(messages, { signal, temperature, reasoningEffort }),
    fault,
    numberEnv('KAKI_LLM_IDLE_MS', 10_000),
  );
// The reader only classifies one line, so it gets a low temperature and no thinking; spoken lines keep their settings.
const readerStreamWithFault = faultyStream(
  (messages, signal) => stream(messages, { signal, temperature: 0.2, reasoningEffort: 'none' }),
  fault,
  numberEnv('KAKI_LLM_IDLE_MS', 10_000),
);
const readerFallbackStreamWithFault = fallback === undefined
  ? undefined
  : faultyStream(
    (messages, signal) => fallback(messages, { signal, temperature: 0.2, reasoningEffort: 'none' }),
    fault,
    numberEnv('KAKI_LLM_IDLE_MS', 10_000),
  );

const azureHint = 'Add your Azure Speech key and region to .env (see .env.example).';
const synthesize = faultySynthesize(
  createAzureTts(
    requireEnv('AZURE_SPEECH_KEY', azureHint),
    requireEnv('AZURE_SPEECH_REGION', azureHint),
    (speaker) => npcs.find((npc) => npc.attendee === speaker)?.voice,
  ),
  fault,
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
let memorySync: Promise<void> = Promise.resolve();
let lastTranscriptError = 0;

/** Send one transcript line to Kaki, and say so (at most every ten seconds) if that does not work. */
function postTranscript(speaker: string, text: string, options?: { textOnly?: boolean; catchId?: string }): void {
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
      payload: {
        speaker,
        text,
        timestamp: new Date().toISOString(),
        ...(options?.textOnly === true ? { textOnly: true } : {}),
        ...(options?.catchId === undefined ? {} : { catchId: options.catchId }),
      },
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
  hangoverMs: numberEnv('NPC_VAD_HANGOVER_MS', 850),
  leakMargin: numberEnv('NPC_VAD_LEAK_MARGIN', DEFAULT_VAD_OPTIONS.leakMargin),
  leakCap: numberEnv('NPC_VAD_LEAK_CAP', DEFAULT_VAD_OPTIONS.leakCap),
};

const runner = await startNpcRunner({
  scenario,
  livekitUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
  stream: streamWithFault,
  ...(fallbackStreamWithFault === undefined ? {} : { fallbackStream: fallbackStreamWithFault }),
  readerStream: readerStreamWithFault,
  ...(readerFallbackStreamWithFault === undefined ? {} : { readerFallbackStream: readerFallbackStreamWithFault }),
  synthesize,
  postTranscript,
  responseDelayMs: numberEnv('NPC_RESPONSE_DELAY_MS', 950),
  recognizer,
  debugAudio: debugAudioDir === undefined ? undefined : debugAudio,
  speakerGapMs: numberEnv('NPC_SPEAKER_GAP_MS', DEFAULT_SPEAKER_GAP_MS),
  sentenceGapMs: numberEnv('NPC_SENTENCE_GAP_MS', DEFAULT_SENTENCE_GAP_MS),
  bargeInMs: numberEnv('NPC_BARGE_IN_MS', DEFAULT_BARGE_IN_MS),
  vad,
  traceVad: process.env.NPC_DEBUG_VAD === '1',
  log,
  // The visitor left: the runner pauses locally; the app server watches the roster for the reset.
  onRoomEmpty: () => {
    log('the room is empty; holding the meeting for a rejoin');
  },
  onHostChange: (human) => sendAs('screen', { type: 'SET_HOST_MODE', human }),
  onPauseChange: (paused) => sendAs('screen', { type: 'SET_PAUSED', paused }),
  onAdvanceAgenda: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
  },
  onEndMeeting: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'END_MEETING' });
  },
  onWingmanTip: (tip, title, agendaIndex) => {
    const today = new Date().toISOString().slice(0, 10);
    const role = runner.visitorRole();
    if (role === undefined) return;
    fetch(`${kakiUrl}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'FACT_FOUND',
        audience: { kind: 'role', role },
        payload: {
          questionId: `live-${Date.now()}`,
          question: `Live Wingman Brief · ${title}`,
          facts: [{ text: tip, source: 'Live Wingman', date: today }],
          agendaIndex,
        },
      }),
    }).then((response) => {
      if (!response.ok) log(`Wingman tip rejected (HTTP ${response.status})`);
    }).catch((error: unknown) => log(`Wingman tip failed: ${String(error)}`));
  },
  onMemoryChange: (entries) => {
    memorySync = memorySync.catch(() => undefined).then(() =>
      postMeetingMemory(fetch, `${kakiUrl}/dev/meeting-memory`, entries, logError));
    void memorySync.catch(() => undefined);
  },
  onReaction: (who, emoji) => {
    void fetch(`${kakiUrl}/dev/emit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'COLLEAGUE_REACTION', audience: { kind: 'all' },
        payload: { who, emoji, timestamp: new Date().toISOString() } }),
    }).then((response) => { if (!response.ok) logError(`[control] reaction POST rejected: HTTP ${response.status}`); })
      .catch((error: unknown) => logError(`[control] reaction POST failed: ${String(error)}`));
  },
  onTopicSettled: async (followUp, reopened) => {
    await memorySync;
    await postSettledTopic(fetch, `${kakiUrl}/dev/settle-topic`, followUp, logError, reopened);
  },
  onDisconnected: () => {
    log('exiting so it can be restarted');
    process.exit(1);
  },
  fetchScenario: async () => {
    const response = await fetch(`${kakiUrl}/api/scenario`);
    if (!response.ok) throw new Error(`Scenario fetch returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return parseScenario(await response.json());
  },
});

// An AI attendee has no phone. When a task is dispatched to their role they answer aloud and this sends their
// Accept or Decline (and approves the draft), over a socket opened as that role like a phone would.
const roleSockets = new Map<Role | 'screen', { socket: WebSocket; queue: string[] }>();
const serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim();
function sendAs(role: Role | 'screen', command: KakiCommand): void {
  let entry = roleSockets.get(role);
  if (entry === undefined || entry.socket.readyState > WebSocket.OPEN) {
    const socket = new WebSocket(
      `${kakiUrl.replace(/^http/, 'ws')}/ws?role=${encodeURIComponent(role)}`,
      serviceToken === undefined || serviceToken === ''
        ? undefined
        : { headers: { authorization: `Bearer ${serviceToken}` } },
    );
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
  volunteeredOnTopic: (attendee) => runner.volunteeredOnTopic(attendee),
  say: (attendee, text, onDone) =>
    cueOrder.after((spoken) => {
      if (spoken) runner.say(attendee, text, onDone);
      else onDone();
    }),
  send: sendAs,
  log,
  draftOnly: process.env.KAKI_DRAFT_ONLY === '1',
  approveDelayMs: numberEnv('NPC_APPROVE_DELAY_MS', DEFAULT_APPROVE_DELAY_MS),
});

// The Host's spoken cues (opening, time-out, closing) arrive as events for the shared screen; the host character voices them.
// This is the runner's authenticated service channel: it can read those cues with auth on, prepares the cast for a
// server Start, and opens the meeting only when MEETING_STARTED names the meeting it prepared. What the hub replays on
// connecting (the retained opening) is old news: only cues after the first second are spoken.
const taskStatusByTitle = new Map<string, { status: string; topic?: string }>();
const syncedTaskIds = new Set<string>();
const declinedTaskIds = new Set<string>();
async function fetchMeetingState(): Promise<RunnerMeetingState> {
  const response = await fetch(`${kakiUrl}/api/meeting/state`);
  const state = (await response.json().catch(() => ({}))) as {
    meetingId?: unknown;
    started?: unknown;
    agendaIndex?: unknown;
  };
  if (!response.ok) throw new Error(`meeting state fetch returned HTTP ${response.status}`);
  if (typeof state.meetingId !== 'string' || state.meetingId === '' || typeof state.started !== 'boolean') {
    throw new Error('meeting state has no meetingId and started flag');
  }
  return {
    meetingId: state.meetingId,
    started: state.started,
    ...(typeof state.agendaIndex === 'number' ? { agendaIndex: state.agendaIndex } : {}),
  };
}

const meetingSync = createMeetingSync({ runner, fetchState: fetchMeetingState, log });

function followHostCues(): void {
  const url = `${kakiUrl.replace(/^http/, 'ws')}/ws?role=service`;
  const socket = new WebSocket(
    url,
    serviceToken === undefined || serviceToken === ''
      ? undefined
      : { headers: { authorization: `Bearer ${serviceToken}` } },
  );
  const openedAt = { at: 0 };
  socket.on('open', () => {
    openedAt.at = Date.now();
    log('the AI service channel is connected');
    // A reset may have happened while this socket was down; never carry the old meeting into it.
    meetingSync.connected();
  });

  const acknowledge = (
    requestId: string,
    attempt: string,
    meetingId: string,
    opened: boolean,
    reason?: string,
  ): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      logError(`could not tell the server the meeting ${opened ? 'opened' : 'failed to prepare'}: the service channel is closed`);
      return;
    }
    socket.send(
      JSON.stringify(
        opened
          ? { kind: 'ready', requestId, attempt, meetingId }
          : { kind: 'failed', requestId, attempt, meetingId, ...(reason === undefined ? {} : { reason }) },
      ),
    );
  };

  const prepareMeeting = (request: PrepareRequest): void => {
    // Anything the runner learned from a state read before this attempt is already out of date.
    meetingSync.prepareStarted();
    void runner
      .prepareMeeting({
        meetingId: request.meetingId,
        attempt: request.attempt,
        ...(request.agendaIndex === undefined ? {} : { agendaIndex: request.agendaIndex }),
        ...(request.resumed === undefined ? {} : { resumed: request.resumed }),
      })
      .then(() => {
        if (runner.meetingId() !== request.meetingId) {
          throw new Error(`the runner moved to meeting ${runner.meetingId()} while preparing ${request.meetingId}`);
        }
        log(`prepared meeting ${request.meetingId} for server Start attempt ${request.attempt}`);
        acknowledge(request.requestId, request.attempt, request.meetingId, true);
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logError(`the meeting failed to prepare for server Start attempt ${request.attempt}: ${reason}`);
        acknowledge(request.requestId, request.attempt, request.meetingId, false, reason);
      });
  };

  socket.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString()) as {
        kind?: string;
        request?: {
          requestId?: unknown;
          attempt?: unknown;
          meetingId?: unknown;
          agendaIndex?: unknown;
          resumed?: unknown;
        };
        type?: string;
        payload?: {
          text?: unknown;
          speaker?: unknown;
          meetingId?: unknown;
          agendaIndex?: unknown;
          resumed?: unknown;
        };
      };
      if (event.kind === 'prepare') {
        const request = parsePrepareRequest(event.request);
        if (request === undefined) {
          logError('ignored a server prepare request without its meeting id and attempt');
          return;
        }
        prepareMeeting(request);
        return;
      }
      if (event.type === 'MEETING_STARTED') {
        const started = parseStartedEvent(event.payload);
        if (started === undefined) {
          logError('ignored MEETING_STARTED without a meeting id');
          return;
        }
        meetingSync.started(started);
        return;
      }
      if (event.type === 'HOST_SPEECH_TRIGGERED' && Date.now() - openedAt.at < 1000) return;
      if (event.type === 'MEETING_RESET') {
        const meetingId = event.payload?.meetingId;
        if (typeof meetingId !== 'string' || meetingId === '') {
          logError('MEETING_RESET carried no meeting id; clearing the local meeting anyway');
        }
        meetingSync.reset(typeof meetingId === 'string' && meetingId !== '' ? meetingId : undefined);
        taskStatusByTitle.clear();
        syncedTaskIds.clear();
        declinedTaskIds.clear();
        return;
      }
      if (event.type === 'TASK_UPDATED') {
        const task = (event.payload as { task?: {
          id?: string; title?: string; status?: string; assignee?: string; suggestedAssignee?: string;
          declinedBy?: string[]; agendaItemTitle?: string;
        } } | undefined)?.task;
        if (task?.id === undefined || task.status === undefined) return;
        if (task.title !== undefined) {
          taskStatusByTitle.set(task.title.trim().toLowerCase(), { status: task.status, topic: task.agendaItemTitle });
        }
        taskResponder.handle(event as KakiEvent);
        const role = task.assignee ?? task.suggestedAssignee;
        const isVisitorTask = role !== undefined && role === runner.visitorRole();
        const declined = task.declinedBy?.includes(role ?? '') === true;
        runner.taskStatus(task.id, task.agendaItemTitle, task.status, isVisitorTask, declined);
        if (isVisitorTask && runner.onCurrentAgenda(task.agendaItemTitle)) {
          if (declined && !declinedTaskIds.has(task.id)) {
            declinedTaskIds.add(task.id);
            runner.cancelPendingDispatch(task.agendaItemTitle);
            runner.announce(`No worries ${runner.visitorName() ?? 'there'}, we'll cover that follow-up after the call.`);
          } else if (task.status === 'SYNCED' && !syncedTaskIds.has(task.id)) {
            syncedTaskIds.add(task.id);
            runner.announce(`Thanks ${runner.visitorName() ?? 'there'}, that's live now. You can click Open live on your card before we move on.`);
          }
        }
      }
      if (event.type === 'HOST_SPEECH_TRIGGERED' && typeof event.payload?.text === 'string') {
        if (event.payload.text.startsWith('Next up:')) {
          runner.agendaMoved(event.payload.text.replace(/^Next up:\s*/, '').replace(/\.$/, ''));
        }
        // With a person in the host's seat these cues are only suggestions on their Host tab; nobody voices them.
        if (!runner.hostIsHuman()) {
          const payload = event.payload as { kind?: string; text: string; assignee?: string; title?: string; topic?: string };
          if (payload.kind === 'CLOSING') {
            runner.announceClosing(payload.text);
            return;
          }
          // A colleague played by an AI is asked in Sam's own words, through the model; the visitor gets the
          // card pointer in Sam's own words too. Neither ever reads the Note Taker's task title aloud.
          const colleague =
            payload.kind === 'DISPATCH' &&
            payload.assignee !== undefined &&
            payload.title !== undefined &&
            runner.plays(payload.assignee);
          const stillDispatched = (titleKey: string) => (): boolean => {
            const current = taskStatusByTitle.get(titleKey);
            return current === undefined || current.status === 'DISPATCHED';
          };
          if (colleague) {
            const name = payload.assignee!;
            const title = payload.title!;
            const cue = colleagueCue(hostName ?? 'Sam', name, title, {
              volunteered: runner.volunteeredOnTopic(name),
              assignedByGuest: runner.askedByGuestOnTopic(name),
            });
            if (cue.quietBecause !== undefined) {
              log(`[dispatch] Sam stays quiet: ${name} already ${cue.quietBecause}`);
            } else {
              const titleKey = title.trim().toLowerCase();
              const shouldStillAsk = () => {
                const current = taskStatusByTitle.get(titleKey);
                return shouldStillAskColleague(
                  current?.status,
                  payload.topic ?? current?.topic,
                  (topic) => runner.onCurrentAgenda(topic),
                );
              };
              cueOrder.cue((done) => runner.askColleague(name, cue.note!, {
                forbiddenText: title,
                shouldStillSpeak: shouldStillAsk,
                onDone: done,
              }));
            }
          } else if (payload.kind === 'DISPATCH') {
            const titleKey = (payload.title ?? '').trim().toLowerCase();
            const guest = runner.visitorName() ?? payload.assignee ?? 'there';
            runner.pointAtCard(guestCardNote(hostName ?? 'Sam', guest), {
              forbiddenText: payload.title,
              shouldStillSpeak: stillDispatched(titleKey),
            });
          } else {
            runner.announce(payload.text);
          }
        }
      }
    } catch {
      /* not an event we understand */
    }
  });
  socket.on('error', (error) => {
    logError(`the AI service channel failed: ${error.message}`);
  });
  socket.on('close', (code, reason) => {
    logError(
      `the AI service channel closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''}); reconnecting in 3 s`,
    );
    setTimeout(followHostCues, 3000).unref();
  });
}
followHostCues();

log(`speech recognition: ${sttMode === 'azure' ? `Azure (${process.env.NPC_STT_LOCALE || 'en-SG'})` : "the browser's"}`);
const fixedNames = aiCast(scenario).map((npc) => npc.attendee);
const hostFallback = npcs.find((npc) => npc.role === 'host')?.attendee ?? npcs[0]?.attendee ?? 'NPCs';
log(
  `ready: ${fixedNames.length > 0 ? fixedNames.join(' and ') : hostFallback} in the room; the other characters join for whoever arrives, as everyone except the role they pick. Open /demo and talk.`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void runner.stop().then(() => process.exit(0)));
}
