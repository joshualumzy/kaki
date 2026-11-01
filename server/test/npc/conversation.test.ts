import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm';
import { NpcConversation, type NpcPorts, type NpcUiState } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { testScenario } from '../fixtures/scenario';

const scenario = {
  ...testScenario,
  npcs: [
    { attendee: 'Ada', voice: 'v1', personality: 'Calm chef', agenda: 'Cut waste', concerns: ['Costs'] },
    { attendee: 'Bao', voice: 'v2', personality: 'Chatty cashier', agenda: 'Fix queues', concerns: ['Lines'] },
  ],
};

/** One call to the fake model; the test feeds it chunks like a real stream would. */
interface LlmCall {
  messages: ChatMessage[];
  signal: AbortSignal;
  push(chunk: string): void;
  end(): void;
  fail(error: Error): void;
}

/** One clip being "played"; it ends when the test says so, or when the conversation aborts it. */
interface Playing {
  speaker: string;
  text: string;
  signal: AbortSignal;
  finish(): void;
  finished: boolean;
}

function harness() {
  const calls: LlmCall[] = [];
  const playing: Playing[] = [];
  const states: NpcUiState[] = [];
  const transcript: Array<[string, string]> = [];
  const logs: string[] = [];

  const ports: NpcPorts<Utterance> = {
      stream(messages, signal) {
        const items: string[] = [];
        let wake: (() => void) | undefined;
        let ended = false;
        let failure: Error | undefined;
        const poke = (): void => wake?.();
        const call: LlmCall = {
          messages,
          signal,
          push: (chunk) => (items.push(chunk), poke()),
          end: () => ((ended = true), poke()),
          fail: (error) => ((failure = error), poke()),
        };
        calls.push(call);
        signal.addEventListener('abort', () => ((ended = true), poke()));
        return (async function* () {
          for (;;) {
            if (failure) throw failure;
            const next = items.shift();
            if (next !== undefined) yield next;
            else if (ended) return;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        })();
      },
      synthesize: async (utterance) => utterance,
      play(speaker, clip, signal) {
        return new Promise<void>((resolve) => {
          const entry: Playing = {
            speaker,
            text: clip.text,
            signal,
            finished: false,
            finish: () => ((entry.finished = true), resolve()),
          };
          playing.push(entry);
          signal.addEventListener('abort', () => resolve());
        });
      },
      emitTranscript: (speaker, text) => transcript.push([speaker, text]),
      emitState: (state) => states.push(state),
      log: (message) => logs.push(message),
  };
  const conversation = new NpcConversation<Utterance>(ports, { scenario, responseDelayMs: 900, speakerGapMs: 0 });
  conversation.setHuman({ name: 'Josh', role: 'Producer', transcriptName: 'Ada (Chef)' });

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  /** The person says something and stops; the AI waits out the response delay and starts. */
  async function say(text: string): Promise<void> {
    conversation.humanSpeech(true);
    conversation.humanText(text);
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);
  }
  return { conversation, ports, calls, playing, states, transcript, logs, flush, say };
}

describe('NpcConversation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers once the person has stopped talking, speaking each sentence in order', async () => {
    const { conversation, calls, playing, states, transcript, flush, say } = harness();

    await say('Hello team.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.at(0)?.content).toContain('Calm chef');
    expect(calls[0]?.messages.at(0)?.content).toContain('Josh, the Producer');
    expect(calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello team.' });
    expect(states.at(-1)).toEqual({ kind: 'thinking' });

    calls[0]?.push('Ada: Morning Josh. Ready when you are.\nBao: Hi all!');
    calls[0]?.end();
    await flush();

    // Only the first sentence is playing; the next waits its turn.
    expect(playing.map((p) => p.text)).toEqual(['Morning Josh.']);
    playing[0]?.finish();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['Morning Josh.', 'Ready when you are.']);
    playing[1]?.finish();
    await flush();
    playing[2]?.finish();
    await conversation.settled();

    expect(playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual([
      'Ada: Morning Josh.',
      'Ada: Ready when you are.',
      'Bao: Hi all!',
    ]);
    // The human's line carries the attendee name Kaki knows; each AI sentence is its own line.
    expect(transcript).toEqual([
      ['Ada (Chef)', 'Hello team.'],
      ['Ada', 'Morning Josh.'],
      ['Ada', 'Ready when you are.'],
      ['Bao', 'Hi all!'],
    ]);
    expect(states.map((s) => s.kind)).toEqual(['thinking', 'speaking', 'speaking', 'speaking', 'idle']);
  });

  it('joins words that arrive in pieces into one question', async () => {
    const { conversation, calls } = harness();
    conversation.humanSpeech(true);
    conversation.humanText('Can we delay');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(500);
    conversation.humanSpeech(true);
    conversation.humanText('the launch?');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(899);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.at(-1)?.content).toBe('Can we delay the launch?');
  });

  it('does not answer while the person is still talking', async () => {
    const { conversation, calls } = harness();
    conversation.humanSpeech(true);
    conversation.humanText('So the thing is');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(1);
  });

  it('stops talking the moment the person talks over it, and remembers only what was heard', async () => {
    const { conversation, calls, playing, states, flush, say } = harness();
    await say('Status?');
    calls[0]?.push('Ada: The build is red. We have a crash.\nBao: I can help with that.');
    calls[0]?.end();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['The build is red.']);

    // The person starts talking while the first sentence is still playing.
    conversation.humanSpeech(true);
    expect(playing[0]?.signal.aborted).toBe(true);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(states.at(-1)).toEqual({ kind: 'idle' });
    await flush();
    expect(playing).toHaveLength(1); // nothing else started

    conversation.humanText('Hold on, the crash is only on Android.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);

    const messages = calls[1]?.messages ?? [];
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Status?' },
      {
        role: 'assistant',
        content:
          'Ada: The build is red. [cut off]\n[Josh interrupted here; nothing after this was said aloud.]',
      },
      { role: 'user', content: 'Hold on, the crash is only on Android.' },
    ]);
  });

  it('records a sentence that finished before the interruption as said in full', async () => {
    const { conversation, calls, playing, flush, say } = harness();
    await say('Status?');
    calls[0]?.push('Ada: Build is red. We have a crash.');
    calls[0]?.end();
    await flush();
    playing[0]?.finish();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['Build is red.', 'We have a crash.']);

    conversation.humanSpeech(true);
    conversation.humanText('Wait.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);

    expect(calls[1]?.messages.at(-2)?.content).toBe(
      'Ada: Build is red.\nAda: We have a crash. [cut off]\n[Josh interrupted here; nothing after this was said aloud.]',
    );
  });

  it('cancels the model when the person talks before anything was said', async () => {
    const { conversation, calls, playing, states, flush, say } = harness();
    await say('Question one.');
    expect(calls[0]?.signal.aborted).toBe(false);

    conversation.humanSpeech(true);
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.push('Ada: Too late.'); // a straggler from the cancelled stream
    await flush();
    expect(playing).toHaveLength(0);
    expect(states.at(-1)).toEqual({ kind: 'idle' });

    conversation.humanText('Actually, question two.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(calls[1]?.messages.slice(1).map((m) => m.content)).toEqual(['Question one.', 'Actually, question two.']);
  });

  it('can be interrupted again and again without leaking turns', async () => {
    const { conversation, calls, playing, flush, say } = harness();
    for (let round = 0; round < 5; round += 1) {
      await say(`Point ${round}.`);
      calls[round]?.push(`Ada: Answer ${round}.`);
      calls[round]?.end();
      await flush();
      expect(playing.filter((p) => !p.signal.aborted && !p.finished)).toHaveLength(1);
      conversation.humanSpeech(true);
      conversation.humanSpeech(false);
    }
    expect(calls).toHaveLength(5);
    expect(playing.filter((p) => !p.signal.aborted && !p.finished)).toHaveLength(0);
  });

  it('ignores the AI echoing back through the microphone, and carries on speaking', async () => {
    const { conversation, calls, playing, flush, say, logs, transcript } = harness();
    await say('Status?');
    calls[0]?.push('Ada: The build is red and we have a crash on Android.');
    calls[0]?.end();
    await flush();

    // Recognition hears the AI's own sentence; the person's microphone track was silent.
    conversation.humanText('the build is red and we have a crash on Android');
    await vi.advanceTimersByTimeAsync(2000);
    expect(playing[0]?.signal.aborted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(logs.some((line) => line.includes('echo'))).toBe(true);
    expect(transcript.some(([speaker]) => speaker === 'Ada (Chef)' && transcript.length > 2)).toBe(false);
  });

  it('refuses unexplained text while the AI talks, but accepts it with a voice behind it', async () => {
    const { conversation, calls, playing, flush, say, logs } = harness();
    await say('Status?');
    calls[0]?.push('Ada: Build is red.');
    calls[0]?.end();
    await flush();

    conversation.humanText('what about the budget');
    await vi.advanceTimersByTimeAsync(2000);
    expect(playing[0]?.signal.aborted).toBe(false);
    expect(logs.some((line) => line.includes('no-voice'))).toBe(true);

    conversation.humanSpeech(true);
    expect(playing[0]?.signal.aborted).toBe(true);
  });

  it("keeps the person's words when the recognizer mixed them with the AI's own sentence", async () => {
    const { conversation, calls, playing, flush, say, logs, transcript } = harness();
    await say('Status?');
    calls[0]?.push('Ada: The build is red and we have a crash on Android.');
    calls[0]?.end();
    await flush();
    expect(playing[0]?.signal.aborted).toBe(false);

    // The person talks over the AI; recognition returns the AI's sentence and the person's words together.
    conversation.humanSpeech(true);
    conversation.humanText('the build is red and we have a crash on Android okay can we end the meeting now');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);

    expect(calls[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'okay can we end the meeting now' });
    expect(transcript.at(-1)?.[1]).toBe('okay can we end the meeting now');
    expect(logs.some((line) => line.includes("cut the AI's own words"))).toBe(true);
  });

  it('logs what the AI says, and how long it took to start, so a run can be judged', async () => {
    const { calls, flush, say, logs } = harness();
    await say('Hello?');
    calls[0]?.push('Ada: Morning.');
    calls[0]?.end();
    await flush();
    expect(logs.some((line) => /^speaking \d+ ms after the model was asked$/.test(line))).toBe(true);
    expect(logs).toContain('Ada: Morning.');
  });

  it('says nothing when the Director answers NONE, and keeps listening', async () => {
    const { conversation, calls, playing, states, flush, say } = harness();
    await say('Um.');
    calls[0]?.push('NONE');
    calls[0]?.end();
    await conversation.settled();
    expect(playing).toHaveLength(0);
    expect(states.at(-1)).toEqual({ kind: 'idle' });

    await say('Okay, real question now.');
    await flush();
    expect(calls[1]?.messages.slice(1).map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('reports a failed model call, then recovers on the next remark', async () => {
    const { conversation, calls, playing, states, flush, say } = harness();
    await say('Hello?');
    calls[0]?.fail(new Error('HTTP 429'));
    await conversation.settled();
    expect(states.at(-1)).toEqual({ kind: 'error', message: 'HTTP 429' });
    expect(conversation.busy).toBe(false);

    await say('Hello again?');
    calls[1]?.push('Bao: Sorry about that.');
    calls[1]?.end();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['Sorry about that.']);
  });

  it('keeps what was said before a model failure part-way through', async () => {
    const { conversation, calls, playing, states, flush, say } = harness();
    await say('Hello?');
    calls[0]?.push('Ada: First part. Seco');
    await flush();
    calls[0]?.fail(new Error('boom'));
    await flush();
    playing[0]?.finish();
    await conversation.settled();
    expect(states.at(-1)).toEqual({ kind: 'idle' });
    expect(playing.map((p) => p.text)).toEqual(['First part.']);
  });

  it('stops everything on close', async () => {
    const { conversation, calls, playing, flush, say } = harness();
    await say('Hello?');
    calls[0]?.push('Ada: Hi there.');
    calls[0]?.end();
    await flush();
    conversation.close();
    expect(playing[0]?.signal.aborted).toBe(true);
    expect(calls[0]?.signal.aborted).toBe(true);
    conversation.humanText('anyone there?');
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
  });

  it('refuses a scenario with no AI attendees', () => {
    expect(
      () =>
        new NpcConversation(
          { stream: async function* () {}, synthesize: async () => 0, play: async () => {}, emitTranscript() {}, emitState() {} },
          { scenario: testScenario },
        ),
    ).toThrow(/no npcs/);
  });

  it('pauses when a different character takes over, and not between one character\'s sentences', async () => {
    const h = harness();
    // Rebuild with a gap: the harness default is none.
    const gapped = new NpcConversation<Utterance>(h.ports, { scenario, responseDelayMs: 900, speakerGapMs: 700 });
    gapped.setHuman({ name: 'Josh', role: 'Producer' });
    gapped.humanSpeech(true);
    gapped.humanText('Hello team.');
    gapped.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);
    h.calls[0]?.push('Ada: One. Two.\nBao: Three.');
    h.calls[0]?.end();
    await h.flush();
    h.playing[0]?.finish();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['One.', 'Two.']);
    h.playing[1]?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.playing.map((p) => p.text)).toEqual(['One.', 'Two.']);
    await vi.advanceTimersByTimeAsync(150);
    expect(h.playing.map((p) => p.text)).toEqual(['One.', 'Two.', 'Three.']);
    h.playing[2]?.finish();
    await gapped.settled();
  });
});
