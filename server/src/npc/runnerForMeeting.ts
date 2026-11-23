import { llmFromEnv } from '../services/llm';
import { isRunnerMeetingSnapshot, type KakiCommand, type KakiEvent, type Role } from '@kaki/shared';
import { WebSocket } from 'ws';
import { loadScenario } from '../core/loadScenario';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from './wav';
import { createAzureStt } from './azureStt';
import { createAzureTts } from './azureTts';
import { fakeSttFromEnv } from './fakeStt';
import { buildSttPhrases } from './sttPhrases';
import { DEFAULT_BARGE_IN_MS, DEFAULT_SENTENCE_GAP_MS, DEFAULT_SPEAKER_GAP_MS } from './conversation';
import { startNpcRunner, type NpcRunner } from './runner';
import { createMeetingSync, parsePrepareRequest, parseStartedEvent, type PrepareRequest } from './meetingSync';
import { colleagueCue, shouldStillAskColleague } from '../host/autoDispatch';
import { createCueOrder } from './cueOrder';
import { createTaskResponder, DEFAULT_APPROVE_DELAY_MS } from './taskResponder';
import { createRunnerClient } from './runnerClient';
import { createCommandSockets } from './commandSockets';
import { createServiceChannel, createServiceDispatch, isReplayedCue } from './serviceChannel';
import { DEFAULT_VAD_OPTIONS, type VadOptions } from './vad';
import { faultFromEnv, faultyStream, faultySynthesize } from './fault';

/** How one meeting runs at the AI runner: practice speaks and listens; a real meeting only listens. */
export interface RunnerMeetingHandle {
  meetingId: string;
  stop(): Promise<void>;
}

interface RunnerMeetingOptions {
  meetingId: string;
  kind: 'real' | 'practice';
  roomName: string;
  kakiUrl: string;
  serviceToken?: string | undefined;
  log(message: string): void;
  logError(message: string): void;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

/**
 * Start the AI side of one meeting. `kind: 'practice'` runs today's full cast and voices;
 * `kind: 'real'` runs only the silent Listener that turns speech into transcript lines.
 */
export async function startRunnerMeeting({
  meetingId,
  kind,
  roomName,
  kakiUrl,
  serviceToken,
  log,
  logError,
}: RunnerMeetingOptions): Promise<RunnerMeetingHandle> {
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


// KAKI_FAULT shows one failure on purpose during a live check; unset is off.
const fault = faultFromEnv(process.env.KAKI_FAULT);
if (fault !== undefined) log(`[fault] ${fault} active`);

const loadedScenario = await loadScenario();
const scenario = kind === 'practice' ? loadedScenario : { ...loadedScenario, npcs: [] };
const isLegacy = meetingId === 'meeting';
const apiPrefix = isLegacy ? '' : `/api/meetings/${meetingId}`;
const runnerClient = createRunnerClient({
  baseUrl: kakiUrl,
  apiPrefix,
  ...(serviceToken === undefined ? {} : { serviceToken }),
  log: logError,
});
// A pack can have no AI seat at all: the runner still joins as the technical listener and hears
// people, and AI characters follow the server's meeting snapshot as its cast changes.
const npcs = scenario.npcs ?? [];

const llm = llmFromEnv();
if (llm?.stream === undefined && kind === 'practice') {
  throw new Error('The AI attendees need an LLM: set KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY and KAKI_LLM_MODEL in .env');
}
const stream = llm?.stream?.bind(llm) ?? (async function* unavailable(): AsyncIterable<string> {
  throw new Error('This meeting has no AI cast, so no spoken line should be asked for');
});
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
const fallback = llm?.fallbackStream?.bind(llm);
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
// The voice belongs to the meeting snapshot's cast, which can change after the process boots.
let runnerForVoice: NpcRunner | undefined;
// The recogniser's phrase list follows the meeting snapshot too; until the runner is ready, it is the boot pack's.
let runnerForStt: NpcRunner | undefined;
const synthesize = faultySynthesize(
  createAzureTts(
    requireEnv('AZURE_SPEECH_KEY', azureHint),
    requireEnv('AZURE_SPEECH_REGION', azureHint),
    (speaker) => runnerForVoice?.voiceFor(speaker) ?? npcs.find((npc) => npc.attendee === speaker)?.voice,
  ),
  fault,
);

// Server-side recognition: it hears the echo-cancelled microphone track, so it does not pick up the
// AI's own voice, and it can lean towards the names and words of this meeting.
const sttMode = process.env.NPC_STT || 'azure';
// Dev and test only: scripted runs "speak" through this instead of a microphone (refused in production).
const fakeSpeech = fakeSttFromEnv();
if (fakeSpeech) log('[fake-stt] KAKI_FAKE_STT=1: scripted lines are accepted as speech');
if (sttMode !== 'azure') throw new Error(`NPC_STT must be "azure"; browser speech recognition was removed, got "${sttMode}"`);
const recognizer = createAzureStt(requireEnv('AZURE_SPEECH_KEY', azureHint), requireEnv('AZURE_SPEECH_REGION', azureHint), {
  locale: process.env.NPC_STT_LOCALE || 'en-SG',
  minConfidence: numberEnv('NPC_STT_MIN_CONFIDENCE', 0.6),
  log,
  phrases: () => {
    const meeting = runnerForStt?.meetingSnapshot();
    return buildSttPhrases({
      startupPack: scenario,
      ...(meeting === undefined ? {} : { meeting }),
      joinedNames: runnerForStt?.presentNames() ?? [],
    });
  },
});

// The runner writes as the screen and as each AI role over command sockets, exactly as a phone would.
// The runner is created below, so its meeting id is read through a holder until then.
let runnerMeetingId: (() => string | undefined) | undefined;
const commandSockets = createCommandSockets({
  baseUrl: kakiUrl,
  ...(serviceToken === undefined ? {} : { token: serviceToken }),
  ...(isLegacy ? {} : { meetingId }),
  log,
  logError,
  // Queued commands are fenced to the meeting they were sent in, so a reconnect cannot replay
  // an old meeting's END_MEETING into the next one.
  currentMeetingId: () => runnerMeetingId?.(),
});
const sendAs = (role: Role | 'screen', command: KakiCommand): void => commandSockets.sendAs(role, command);
let memorySync: Promise<void> = Promise.resolve();
let lastTranscriptError = 0;

/** Say (at most every ten seconds) that Kaki did not take a transcript message. */
function complainTranscript(message: string): void {
  if (Date.now() - lastTranscriptError < 10_000) return;
  lastTranscriptError = Date.now();
  log(message);
}

/** Send one transcript line to Kaki, and say so (at most every ten seconds) if that does not work. */
function postTranscript(
  speaker: string,
  text: string,
  options?: { textOnly?: boolean; catchId?: string; lineId?: string; gate?: 'lock-offer' },
): void {
  runnerClient
    .emit({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: {
        speaker,
        text,
        timestamp: new Date().toISOString(),
        ...(options?.textOnly === true ? { textOnly: true } : {}),
        ...(options?.catchId === undefined ? {} : { catchId: options.catchId }),
        ...(options?.lineId === undefined ? {} : { lineId: options.lineId }),
        ...(options?.gate === undefined ? {} : { gate: options.gate }),
      },
    })
    .then(async (response) => {
      if (!response.ok) {
        complainTranscript(
          `Kaki rejected a transcript line (HTTP ${response.status}); check the server and runner token. ${await response.text()}`,
        );
      }
    })
    .catch((error: unknown) => complainTranscript(`Could not reach Kaki at ${kakiUrl}: ${String(error)}`));
}

/** Cut or restore a line on screen only; the line itself was already recorded when it was spoken. */
function postTranscriptUpdate(speaker: string, text: string, options: { lineId: string; cut: boolean }): void {
  runnerClient
    .emit({
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: {
        lineId: options.lineId,
        speaker,
        text,
        timestamp: new Date().toISOString(),
        cut: options.cut,
      },
    })
    .then(async (response) => {
      if (!response.ok) {
        complainTranscript(
          `Kaki rejected a transcript update (HTTP ${response.status}); check the server and runner token. ${await response.text()}`,
        );
      }
    })
    .catch((error: unknown) => complainTranscript(`Could not reach Kaki at ${kakiUrl}: ${String(error)}`));
}

/**
 * Forward speech that only the server-side recogniser heard. The app server resolves the speaker
 * from the seat and writes the one transcript line, so a retry with the same id cannot duplicate it.
 */
function postHumanLine(line: {
  meetingId: string;
  participantIdentity: string;
  seat: string;
  text: string;
  clientLineId: string;
  speechStartedAt?: string;
  speechEndedAt?: string;
  micLevel?: number;
  overlap?: boolean;
}): void {
  runnerClient
    .postHumanLine(line)
    .then(async (response) => {
      if (!response.ok) {
        complainTranscript(
          `Kaki rejected a recognised human line (HTTP ${response.status}); check the server and runner token. ${await response.text()}`,
        );
      }
    })
    .catch((error: unknown) => complainTranscript(`Could not reach Kaki at ${kakiUrl}: ${String(error)}`));
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
  hangoverMs: numberEnv('NPC_VAD_HANGOVER_MS', 1500),
  leakMargin: numberEnv('NPC_VAD_LEAK_MARGIN', DEFAULT_VAD_OPTIONS.leakMargin),
  leakCap: numberEnv('NPC_VAD_LEAK_CAP', DEFAULT_VAD_OPTIONS.leakCap),
};

// The room is the meeting's, so learn its identity before joining. A server that is not up yet is
// fine: the service channel moves the runner to the right room once it can read the snapshot.
const initialMeeting = await runnerClient.fetchMeetingState().catch((error: unknown) => {
  log(`could not read the meeting identity yet; the service channel will move the runner: ${String(error)}`);
  return undefined;
});
const runner = await startNpcRunner({
  scenario,
  // The server announces the exact room. Pinning it keeps a per-visitor practice in its own room;
  // a practice meeting that rotates its identity still moves to the new identity's room.
  roomName,
  livekitUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
  stream: streamWithFault,
  ...(fallbackStreamWithFault === undefined ? {} : { fallbackStream: fallbackStreamWithFault }),
  readerStream: readerStreamWithFault,
  ...(readerFallbackStreamWithFault === undefined ? {} : { readerFallbackStream: readerFallbackStreamWithFault }),
  synthesize,
  postTranscript,
  postTranscriptUpdate,
  postHumanLine,
  responseDelayMs: numberEnv('NPC_RESPONSE_DELAY_MS', 950),
  recognizer,
  fakeSpeech,
  debugAudio: debugAudioDir === undefined ? undefined : debugAudio,
  speakerGapMs: numberEnv('NPC_SPEAKER_GAP_MS', DEFAULT_SPEAKER_GAP_MS),
  sentenceGapMs: numberEnv('NPC_SENTENCE_GAP_MS', DEFAULT_SENTENCE_GAP_MS),
  bargeInMs: numberEnv('NPC_BARGE_IN_MS', DEFAULT_BARGE_IN_MS),
  vad,
  traceVad: process.env.NPC_DEBUG_VAD === '1',
  log,
  logError,
  // The app server watches the roster and pauses/resumes the meeting itself; the runner only notes
  // that the next person to arrive gets one welcome-back line.
  onRoomEmpty: () => {
    log('the room is empty; holding the meeting for a rejoin');
  },
  onAdvanceAgenda: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'NEXT_AGENDA_ITEM' });
  },
  onEndMeeting: () => {
    if (!runner.hostIsHuman()) sendAs('screen', { type: 'END_MEETING' });
  },
  onMemoryChange: (entries) => {
    memorySync = memorySync.catch(() => undefined).then(() =>
      runnerClient.postMeetingMemory(entries));
    void memorySync.catch((error: unknown) => logError(`could not sync meeting memory: ${String(error)}`));
  },
  onReaction: (who, emoji) => {
    const reaction: KakiEvent = {
      type: 'COLLEAGUE_REACTION',
      audience: { kind: 'all' },
      payload: {
        who,
        emoji: emoji as Extract<KakiEvent, { type: 'COLLEAGUE_REACTION' }>['payload']['emoji'],
        timestamp: new Date().toISOString(),
      },
    };
    void runnerClient
      .emit(reaction)
      .then((response) => { if (!response.ok) logError(`[control] reaction POST rejected: HTTP ${response.status}`); })
      .catch((error: unknown) => logError(`[control] reaction POST failed: ${String(error)}`));
  },
  onTopicSettled: async (followUp, reopened) => {
    await memorySync;
    await runnerClient.postSettledTopic(followUp, reopened);
  },
  ...(initialMeeting === undefined ? {} : { initialMeeting }),
});
runnerForVoice = runner;
runnerForStt = runner;
runnerMeetingId = () => runner.meetingId();

// Sam asks an AI colleague aloud, then the colleague answers: the answer waits for the question (see cueOrder.ts).
const cueOrder = createCueOrder();
const taskResponder = kind === 'practice' ? createTaskResponder({
  scenario,
  llm: llm!,
  plays: (attendee) => runner.plays(attendee),
  volunteeredOnTopic: (attendee) => runner.volunteeredOnTopic(attendee),
  completedLinesOnTopic: () => runner.completedLinesOnTopic(),
  say: (attendee, text, onDone) =>
    cueOrder.after((spoken) => {
      if (spoken) runner.say(attendee, text, onDone);
      else onDone(false);
    }),
  send: sendAs,
  log,
  draftOnly: process.env.KAKI_DRAFT_ONLY === '1',
  approveDelayMs: numberEnv('NPC_APPROVE_DELAY_MS', DEFAULT_APPROVE_DELAY_MS),
}) : undefined;

// The Host's spoken cues (opening, time-out, closing) arrive as events for the shared screen; the host character voices them.
// This is the runner's authenticated service channel: it can read those cues with auth on, prepares the cast for a
// server Start, and opens the meeting only when MEETING_STARTED names the meeting it prepared. The hub marks every
// retained event `replayed: true`; an old host cue is history and is never spoken again.
const taskStatusByTitle = new Map<string, { status: string; topic?: string }>();
const taskStatusById = new Map<string, { status: string; topic?: string }>();
const syncedTaskIds = new Set<string>();
const declinedTaskIds = new Set<string>();
const resetTaskMaps = (): void => {
  taskStatusByTitle.clear();
  taskStatusById.clear();
  syncedTaskIds.clear();
  declinedTaskIds.clear();
};

const meetingSync = createMeetingSync({
  runner,
  fetchState: () => runnerClient.fetchMeetingState(),
  log,
  // A service reconnect or RUNNER_STATE can reveal a different meeting: old queues and task maps are stale.
  onMeetingChanged: () => {
    commandSockets.dropStale();
    resetTaskMaps();
  },
});

interface ServiceEvent {
  kind?: string;
  type?: string;
  replayed?: boolean;
  request?: {
    requestId?: unknown;
    attempt?: unknown;
    meetingId?: unknown;
    agendaIndex?: unknown;
    resumed?: unknown;
  };
  payload?: {
    text?: unknown;
    speaker?: unknown;
    meetingId?: unknown;
    agendaIndex?: unknown;
    resumed?: unknown;
  };
}

// Every socket that opens gets its own message wiring; the channel above it handles reconnects and backoff.
function wireServiceSocket(socket: WebSocket): void {
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
    // The sync module is the only writer of the runner's meeting snapshot, and its generation fence
    // covers the whole fetch-and-prepare continuation: a superseded attempt never reaches the runner.
    void meetingSync.prepare(request).then((outcome) => {
      if (outcome.kind === 'prepared') {
        log(`prepared meeting ${request.meetingId} for server Start attempt ${request.attempt}`);
        acknowledge(request.requestId, request.attempt, request.meetingId, true);
        return;
      }
      if (outcome.kind === 'superseded') {
        log(`refused a stale prepare for meeting ${request.meetingId}: ${outcome.reason}`);
        return;
      }
      logError(`the meeting failed to prepare for server Start attempt ${request.attempt}: ${outcome.reason}`);
      acknowledge(request.requestId, request.attempt, request.meetingId, false, outcome.reason);
    });
  };

  const onPrepare = (event: ServiceEvent): void => {
    const request = parsePrepareRequest(event.request);
    if (request === undefined) {
      logError('ignored a server prepare request without its meeting id and attempt');
      return;
    }
    prepareMeeting(request);
  };

  const onStarted = (event: ServiceEvent): void => {
    const started = parseStartedEvent(event.payload);
    if (started === undefined) {
      logError('ignored MEETING_STARTED without a meeting id');
      return;
    }
    meetingSync.started(started);
  };

  const onReset = (event: ServiceEvent): void => {
    const meetingId = event.payload?.meetingId;
    if (typeof meetingId !== 'string' || meetingId === '') {
      logError('MEETING_RESET carried no meeting id; clearing the local meeting anyway');
    }
    meetingSync.reset(typeof meetingId === 'string' && meetingId !== '' ? meetingId : undefined);
    // A command queued for the old meeting (e.g. NEXT_AGENDA_ITEM) must not land in the new one.
    commandSockets.dropQueued();
    resetTaskMaps();
  };

  const onTaskUpdated = (event: ServiceEvent): void => {
    const task = (event.payload as { task?: {
      id?: string; title?: string; status?: string; assignee?: string; suggestedAssignee?: string;
      declinedBy?: string[]; agendaItemTitle?: string;
    } } | undefined)?.task;
    if (task?.id === undefined || task.status === undefined) return;
    taskStatusById.set(task.id, { status: task.status, topic: task.agendaItemTitle });
    if (task.title !== undefined) {
      // Kept only for older cues that carry no task id; new cues are keyed by the exact task.
      taskStatusByTitle.set(task.title.trim().toLowerCase(), { status: task.status, topic: task.agendaItemTitle });
    }
    taskResponder?.handle(event as unknown as KakiEvent);
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
  };

  const onHostCue = (event: ServiceEvent): void => {
    if (typeof event.payload?.text !== 'string') return;
    if (event.payload.text.startsWith('Next up:')) {
      runner.agendaMoved(event.payload.text.replace(/^Next up:\s*/, '').replace(/\.$/, ''));
    }
    // With a person in the host's seat these cues are only suggestions on their Host tab; nobody voices them.
    if (!runner.hostIsHuman()) {
      const payload = event.payload as {
        kind?: string; text: string; assignee?: string; title?: string; topic?: string; taskId?: string;
      };
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
      // New cues name the exact task, so two tasks sharing a title never share state. The title map is
      // only the fallback for an older retained cue that carries no id.
      const statusFor = (titleKey: string): { status: string; topic?: string } | undefined =>
        payload.taskId === undefined ? taskStatusByTitle.get(titleKey) : taskStatusById.get(payload.taskId);
      if (colleague) {
        const name = payload.assignee!;
        const title = payload.title!;
        // The old topic-wide volunteer flag no longer silences Sam: a line on the topic is not proof the
        // colleague promised this exact task. The exact judgement happens when the colleague answers.
        const cue = colleagueCue(runner.hostName() ?? 'Sam', name, title, {
          volunteered: false,
          assignedByGuest: runner.askedByGuestOnTopic(name),
        });
        if (cue.quietBecause !== undefined) {
          log(`[dispatch] Sam stays quiet: ${name} already ${cue.quietBecause}`);
        } else {
          const titleKey = title.trim().toLowerCase();
          const shouldStillAsk = () => {
            const current = statusFor(titleKey);
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
        // Kaki's pop-up on the visitor's screen points at the follow-up; Sam only records that it was shown.
        runner.markCardShown();
      } else {
        runner.announce(payload.text);
      }
    }
  };

  const dispatchEvent = (event: ServiceEvent): void => {
    if (event.kind === 'prepare') {
      onPrepare(event);
      return;
    }
    if (event.type === 'RUNNER_STATE') {
      if (!isRunnerMeetingSnapshot(event.payload)) {
        logError('ignored a RUNNER_STATE event that is not a meeting snapshot');
        return;
      }
      meetingSync.snapshot(event.payload);
      return;
    }
    if (event.type === 'MEETING_STARTED') {
      onStarted(event);
      return;
    }
    if (event.type === 'MEETING_RESET') {
      onReset(event);
      return;
    }
    if (event.type === 'TASK_UPDATED') {
      onTaskUpdated(event);
      return;
    }
    if (event.type === 'HOST_SPEECH_TRIGGERED') onHostCue(event);
  };

  const handle = createServiceDispatch({
    dispatch: (event) => dispatchEvent(event as ServiceEvent),
    logError,
    ignore: isReplayedCue,
  });
  socket.on('message', (data) => handle(data.toString()));
}

const serviceChannel = createServiceChannel({
  token: serviceToken,
  createSocket: () =>
    new WebSocket(
      `${kakiUrl.replace(/^http/, 'ws')}/ws?audience=service${isLegacy ? '' : `&meeting=${encodeURIComponent(meetingId)}`}`,
      serviceToken === undefined || serviceToken === ''
        ? undefined
        : { headers: { authorization: `Bearer ${serviceToken}` } },
    ),
  log,
  logError,
  onOpen: (socket) => {
    // A reset may have happened while this socket was down; never carry the old meeting into it.
    meetingSync.connected();
    wireServiceSocket(socket);
  },
});
serviceChannel.start();

log(`speech recognition: Azure (${process.env.NPC_STT_LOCALE || 'en-SG'})`);
log('ready: the listener is in the room; AI characters follow the meeting cast. Open /demo and talk.');

  let stopped = false;
  return {
    meetingId,
    async stop() {
      if (stopped) return;
      stopped = true;
      serviceChannel.stop();
      commandSockets.close();
      await runner.stop();
    },
  };
}
