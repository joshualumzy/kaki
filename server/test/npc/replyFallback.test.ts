import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm';
import { NpcConversation, type NpcPorts } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { testScenario } from '../fixtures/scenario';

const scenario = {
  ...testScenario,
  npcs: [
    { attendee: 'Ada', voice: 'v1', personality: 'Calm chef', agenda: 'Cut waste', concerns: ['Costs'] },
    { attendee: 'Bao', voice: 'v2', personality: 'Chatty cashier', agenda: 'Fix queues', concerns: ['Lines'] },
  ],
};

interface Call {
  messages: ChatMessage[];
  signal: AbortSignal;
}

interface Playing {
  speaker: string;
  text: string;
  finish(): void;
  finished: boolean;
}

function harness(fallback?: (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>) {
  const primary: Call[] = [];
  const backup: Call[] = [];
  const playing: Playing[] = [];
  const transcript: Array<[string, string]> = [];
  const logs: string[] = [];

  const waiting = (messages: ChatMessage[], signal: AbortSignal, into: Call[]) => {
    const call: Call = { messages, signal };
    into.push(call);
    return (async function* () {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    })();
  };

  const ports: NpcPorts<Utterance> = {
    stream: (messages, signal) => waiting(messages, signal, primary),
    ...(fallback === undefined ? {} : {
      fallbackStream: (messages: ChatMessage[], signal: AbortSignal) => {
        const call: Call = { messages, signal };
        backup.push(call);
        return fallback(messages, signal);
      },
    }),
    synthesize: async (utterance) => utterance,
    play(speaker, clip) {
      return new Promise<void>((resolve) => {
        const entry: Playing = {
          speaker, text: clip.text, finished: false,
          finish: () => ((entry.finished = true), resolve()),
        };
        playing.push(entry);
      });
    },
    emitTranscript: (speaker, text) => transcript.push([speaker, text]),
    emitState: () => undefined,
    log: (message) => logs.push(message),
  };
  const conversation = new NpcConversation<Utterance>(ports, {
    scenario,
    responseDelayMs: 0,
    speakerGapMs: 0,
    sentenceGapMs: 0,
    bargeInMs: 0,
    briefFirstChunkMs: 40,
    replies: 'one-speaker',
    readGuestLine: async () => ({
      kind: 'question',
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }),
  });
  conversation.setHuman({ name: 'Josh', role: 'chef', transcriptName: 'Ada (Chef)' });
  return { conversation, primary, backup, playing, transcript, logs };
}

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

async function playOut(playing: Playing[]): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await flush();
    const next = playing.find((entry) => !entry.finished);
    if (next === undefined) return;
    next.finish();
    await flush();
  }
  throw new Error('playback did not finish');
}

describe('backup model on a stalled reply', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries the first-sentence deadline on the backup model when one is wired', async () => {
    const h = harness(() => (async function* () {
      yield 'Ada: We can start with the till.';
    })());
    h.conversation.humanTyped('What should we do about the till?');
    await vi.advanceTimersByTimeAsync(60);
    await flush();

    expect(h.primary).toHaveLength(1);
    expect(h.backup).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('[llm-fallback]'));
    expect(h.transcript).toContainEqual(['Ada', 'We can start with the till.']);

    await playOut(h.playing);
    h.conversation.close();
  });

  it('gives an honest recovery line, not a false "missed that", when both models fail', async () => {
    const h = harness(() => (async function* () {
      await Promise.resolve();
    })());
    h.conversation.humanTyped('What should we do about the till?');
    await vi.advanceTimersByTimeAsync(120);
    await flush();
    await playOut(h.playing);

    const spoken = h.transcript.map(([, text]) => text);
    expect(spoken).toContain('Sorry, give me a second on that.');
    expect(spoken.some((text) => /missed that one|send it again|say that again/i.test(text))).toBe(false);

    // The room re-arms its silence prompt instead of going quiet for good.
    const callsBefore = h.primary.length + h.backup.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.primary.length + h.backup.length).toBeGreaterThan(callsBefore);
    h.conversation.close();
  });
});
