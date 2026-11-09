import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { CONTROL_TOPIC, NPC_STATE_TOPIC, STT_TOPIC, demoRoomName, type NpcStateMessage } from '@kaki/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm';
import { createRoomToken } from '../../src/livekit';
import { loadScenario } from '../../src/loadScenario';
import { SAMPLE_RATE, startNpcRunner, type NpcRunner } from '../../src/npc/runner';

/**
 * End-to-end test of the AI attendees over a real LiveKit server, with a fake person, a scripted
 * model and fake speech (tones). It checks what unit tests cannot: that audio really flows both
 * ways, that talking over the AI stops it quickly, and that the AI's own voice is not mistaken
 * for the person. It does not cover Azure, the real model, or a browser's echo cancellation.
 *
 * Needs a LiveKit server: `npm run stack:up`, or `livekit-server --dev`. Run it with
 *   LIVEKIT_E2E=1 npx vitest run server/test/npc/livekit.e2e.test.ts
 * and set LIVEKIT_URL if the server is not on ws://127.0.0.1:7880.
 */
const enabled = process.env.LIVEKIT_E2E === '1';
const livekitUrl = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';

const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = now();
  while (!check()) {
    if (now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(15);
  }
}

function tone(ms: number, amplitude: number, hz = 220): Int16Array {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE));
  }
  return samples;
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

interface LlmCall {
  messages: ChatMessage[];
  signal: AbortSignal;
  at: number;
}

describe.skipIf(!enabled)('AI attendees over LiveKit', () => {
  const calls: LlmCall[] = [];
  const states: NpcStateMessage[] = [];
  const transcript: Array<[string, string]> = [];
  const logs: string[] = [];
  let reply = 'Arjun: Hello there.';
  let runner: NpcRunner;
  let human: Room;
  let humanMic: AudioSource;
  let lastAiLoud = 0;
  let firstAiLoud = 0;
  let aiLoudFrames = 0;
  /** When on, the fake person's microphone also carries a quieter, delayed copy of the AI: speakers leaking into the mic. */
  let echoCoupling = 0;
  const ECHO_DELAY_MS = 250;

  const resetAiAudio = (): void => {
    lastAiLoud = 0;
    firstAiLoud = 0;
    aiLoudFrames = 0;
  };
  const aiSilentFor = (ms: number): boolean => now() - lastAiLoud > ms;

  // The fake microphone adds what the person says and the echo of the AI, as a real one does, and
  // sends nothing while both are silent.
  const speechQueue: number[] = [];
  const echoQueue: number[] = [];
  let mixer: ReturnType<typeof setInterval> | undefined;
  const FRAME = SAMPLE_RATE / 100; // 10 ms

  function startMixer(): void {
    mixer = setInterval(() => {
      if (speechQueue.length === 0 && echoQueue.length === 0) return;
      const frame = new Int16Array(FRAME);
      for (let index = 0; index < FRAME; index += 1) {
        frame[index] = Math.max(-32768, Math.min(32767, (speechQueue.shift() ?? 0) + (echoQueue.shift() ?? 0)));
      }
      void humanMic.captureFrame(new AudioFrame(frame, SAMPLE_RATE, 1, FRAME)).catch(() => undefined);
    }, 10);
  }

  /** The fake person talks (loud audio) for `ms`; resolves when it has been sent. */
  async function talk(ms: number): Promise<void> {
    speechQueue.push(...tone(ms, 8000));
    await waitFor(() => speechQueue.length === 0, ms + 3000, 'the speech to be sent');
    await sleep(80);
  }

  function say(text: string): void {
    const data = new TextEncoder().encode(JSON.stringify({ text }));
    void human.localParticipant?.publishData(data, { reliable: true, topic: STT_TOPIC });
  }

  beforeAll(async () => {
    const scenario = await loadScenario();
    runner = await startNpcRunner({
      scenario,
      livekitUrl,
      // The model: replies with whatever the test set, written in small pieces like a real stream.
      stream: async function* (messages, signal) {
        calls.push({ messages, signal, at: now() });
        for (const piece of reply.match(/.{1,12}/gs) ?? []) {
          if (signal.aborted) return;
          await sleep(15);
          yield piece;
        }
      },
      // The voice: every sentence is a 1.5 s tone, loud enough to be heard.
      synthesize: async () => tone(1500, 6000, 330),
      postTranscript: (speaker, text) => void transcript.push([speaker, text]),
      log: (message) => void logs.push(message),
      traceVad: process.env.E2E_DEBUG === '1',
    });

    const token = await createRoomToken({
      roomName: demoRoomName(scenario),
      participantName: 'Josh',
      participantRole: 'Operations Director',
    });
    human = new Room();
    await human.connect(livekitUrl, token);
    humanMic = new AudioSource(SAMPLE_RATE, 1, 400);
    await human.localParticipant?.publishTrack(
      LocalAudioTrack.createAudioTrack('microphone', humanMic),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    human.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic === NPC_STATE_TOPIC) states.push(JSON.parse(new TextDecoder().decode(payload)) as NpcStateMessage);
    });
    human.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO || participant.identity === 'Josh') return;
      void (async () => {
        for await (const frame of new AudioStream(track, SAMPLE_RATE, 1)) {
          if (echoCoupling > 0) {
            const leaked = Array.from(frame.data, (sample) => Math.round(sample * echoCoupling));
            setTimeout(() => echoQueue.push(...leaked), ECHO_DELAY_MS);
          }
          if (rms(frame.data) > 0.02) {
            const at = now();
            if (firstAiLoud === 0) firstAiLoud = at;
            lastAiLoud = at;
            aiLoudFrames += 1;
          }
        }
      })();
    });

    // The host listens from the start; the others join once the runner has seen the person and their role.
    // As the Producer, Josh takes Wei Ling's seat, so the AIs are Sam, Arjun, Mei and Daniel.
    startMixer();
    await waitFor(() => human.remoteParticipants.size >= 4, 20_000, 'the AI attendees to join');
    await sleep(500);
    // The AI attendees stay silent until the person presses Start; Sam's welcome follows.
    await human.localParticipant?.publishData(new TextEncoder().encode(JSON.stringify({ kind: 'start' })), { reliable: true, topic: CONTROL_TOPIC });
  }, 60_000);

  afterAll(async () => {
    if (process.env.E2E_DEBUG) console.log(logs.join('\n'));
    if (mixer !== undefined) clearInterval(mixer);
    await runner?.stop();
    await human?.disconnect();
  });

  it('answers when the person speaks: the model is asked, the AI is heard, state and transcript follow', async () => {
    reply = 'Arjun: Hello Josh. We have a crash to discuss. It is a bad one. Let me explain properly.';
    resetAiAudio();

    await talk(600);
    const stoppedTalking = now();
    say('Hello team, what is the status?');

    await waitFor(() => calls.length === 1, 8000, 'the model to be asked');
    await waitFor(() => aiLoudFrames > 5, 8000, 'the AI to be heard');
    const answerDelay = Math.round(firstAiLoud - stoppedTalking);
    console.log(`[e2e] person stopped talking -> AI audible: ${answerDelay} ms (fake model and voice, default settings)`);

    expect(calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello team, what is the status?' });
    expect(calls[0]?.messages[0]?.content).toContain('Josh, the Operations Director');
    await waitFor(() => states.some((state) => state.kind === 'speaking'), 3000, 'a speaking state');
    expect(states.map((state) => state.kind)).toContain('thinking');
    expect(transcript[0]).toEqual(['Josh (Operations Director)', 'Hello team, what is the status?']);
    expect(transcript.some(([speaker]) => speaker === 'Arjun')).toBe(true);
    expect(answerDelay).toBeLessThan(4000);
  }, 40_000);

  it('stops quickly when the person talks over the AI, and remembers only what was heard', async () => {
    // Let the previous answer play out, then start a long one.
    await waitFor(() => aiSilentFor(600), 20_000, 'the previous answer to finish');
    const before = calls.length;
    reply = 'Arjun: First long sentence. Second long sentence. Third long sentence. Fourth long sentence.';
    resetAiAudio();
    await talk(500);
    say('Tell me everything about the crash.');
    await waitFor(() => calls.length === before + 1 && aiLoudFrames > 15, 10_000, 'the long answer to be playing');

    const interruptedCall = calls[before]!;
    const talkOverStart = now();
    await talk(450); // the person talks over the AI
    await waitFor(() => aiSilentFor(250), 5000, 'the AI to go quiet');
    const stopDelay = Math.round(lastAiLoud - talkOverStart);
    console.log(`[e2e] person starts talking over the AI -> AI silent: ${stopDelay} ms`);

    expect(interruptedCall.signal.aborted).toBe(true);
    expect(stopDelay).toBeLessThan(1500);

    say('Hold on, only on Android.');
    await waitFor(() => calls.length === before + 2, 8000, 'the model to be asked again');
    const history = calls[before + 1]!.messages.slice(1);
    const heard = history.find((message) => message.role === 'assistant' && message.content.includes('[cut off]'));
    expect(heard?.content).toContain('interrupted here');
    expect(heard?.content).not.toContain('Fourth long sentence');
    expect(history.at(-1)).toEqual({ role: 'user', content: 'Hold on, only on Android.' });
  }, 60_000);

  it("does not mistake the AI's own voice, or unexplained text, for the person", async () => {
    // The previous test's last answer may still be playing: wait for it to end, then for a calm moment.
    await waitFor(() => states.at(-1)?.kind === 'idle' && aiSilentFor(800), 25_000, 'the AI to finish speaking');
    await sleep(2500);
    const before = calls.length;
    reply = 'Arjun: The release candidate crashes after ten customers in a row. That is the main blocker today.';
    resetAiAudio();
    await talk(500);
    say('Give me a status on the release.');
    await waitFor(() => calls.length === before + 1, 10_000, 'the model to be asked');
    // Audio left over from an earlier answer can still arrive; only count audio after this one began.
    resetAiAudio();
    await waitFor(() => aiLoudFrames > 10, 10_000, 'the AI to be speaking');
    const speakingCall = calls[before]!;

    // The recognizer hears the AI's own sentence, and some other words, with nobody talking.
    say('the release candidate crashes after ten customers in a row');
    say('what about the budget for the booth');
    await sleep(1500);

    expect(speakingCall.signal.aborted).toBe(false);
    expect(calls.length).toBe(before + 1);
    expect(logs.some((line) => line.includes('echo'))).toBe(true);
    expect(logs.some((line) => line.includes('no-voice'))).toBe(true);
  }, 60_000);

  it('does not cut itself off on its own echo through the speakers, and still hears a person talking over it', async () => {
    await waitFor(() => states.at(-1)?.kind === 'idle' && aiSilentFor(800), 25_000, 'the AI to finish speaking');
    await sleep(1500);
    const before = calls.length;
    reply = 'Arjun: First long sentence. Second long sentence. Third long sentence. Fourth long sentence.';
    resetAiAudio();
    await talk(500);
    say('Tell me about the build.');
    await waitFor(() => calls.length === before + 1, 10_000, 'the model to be asked');
    const call = calls[before]!;

    // From now on the microphone also hears the AI, a quarter as loud, a quarter of a second late:
    // about 0.03 RMS, above the fixed bar a detector without a playback reference would use.
    echoCoupling = 0.25;
    resetAiAudio();
    await waitFor(() => aiLoudFrames > 10, 10_000, 'the AI to be speaking');
    await sleep(2500);
    expect(call.signal.aborted).toBe(false); // it did not mistake its own echo for the person
    expect(aiLoudFrames).toBeGreaterThan(100);

    // A person speaking clearly over it is still heard.
    const talkOverStart = now();
    const talking = talk(500);
    await waitFor(() => call.signal.aborted, 3000, 'the AI to be interrupted');
    console.log(`[e2e] with speaker echo: person talks over the AI -> AI interrupted after ${Math.round(now() - talkOverStart)} ms`);
    echoCoupling = 0;
    await talking;
    expect(logs.some((line) => /started talking \(.*AI was talking/.test(line))).toBe(true);
  }, 60_000);
});
