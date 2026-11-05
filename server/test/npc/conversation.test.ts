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

function harness(scenarioUsed: typeof scenario = scenario) {
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
  const conversation = new NpcConversation<Utterance>(ports, { scenario: scenarioUsed, responseDelayMs: 900, speakerGapMs: 0, sentenceGapMs: 0 });
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

  it('has an AI host ask the person for their decision once, after their first few lines', async () => {
    const hosted = {
      ...scenario,
      roles: [
        ...scenario.roles,
        { id: 'producer', label: 'Producer', card: { youAre: 'You are Josh.', facts: ['A fact.'], responsibility: 'You decide what ships.' } },
      ],
      npcs: [{ ...scenario.npcs[0]!, role: 'host' as const }, scenario.npcs[1]!],
    };
    const { calls, say } = harness(hosted);
    for (const line of ['One.', 'Two.', 'Three.']) {
      await say(line);
      calls.at(-1)?.end();
    }
    expect(JSON.stringify(calls.map((call) => call.messages.at(-1)?.content))).not.toContain('what they decide');
    await say('Four.');
    const last = String(calls.at(-1)?.messages.at(-1)?.content);
    expect(last).toContain('Ada turns to Josh by name');
    expect(last).toContain('You decide what ships.');
    calls.at(-1)?.end();
    await say('Five.');
    expect(String(calls.at(-1)?.messages.at(-1)?.content)).not.toContain('what they decide');
  });

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

  it('pauses briefly between one speaker\'s sentences, and longer when a different character takes over', async () => {
    const h = harness();
    // Rebuild with gaps: the harness default is none.
    const gapped = new NpcConversation<Utterance>(h.ports, {
      scenario,
      responseDelayMs: 900,
      speakerGapMs: 700,
      sentenceGapMs: 300,
    });
    gapped.setHuman({ name: 'Josh', role: 'Producer' });
    gapped.humanSpeech(true);
    gapped.humanText('Hello team.');
    gapped.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);
    h.calls[0]?.push('Ada: One. Two.\nBao: Three.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['One.']);
    h.playing[0]?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.playing.map((p) => p.text)).toEqual(['One.']);
    await vi.advanceTimersByTimeAsync(100);
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

  it('tells the model who is being addressed, and routes an untagged reply to them', async () => {
    const { calls, playing, flush, say } = harness();
    await say('Bao, I have a question.');
    expect(calls[0]?.messages.at(-1)?.content).toContain('Josh is speaking directly to Bao');
    expect(calls[0]?.messages.at(-1)?.content).toContain('Begin your reply with "Bao:"');
    calls[0]?.push('Sure, go ahead.');
    calls[0]?.end();
    await flush();
    expect(playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual(['Bao: Sure, go ahead.']);
  });

  it('answers again when the answer was cancelled before anything was said and nothing else follows', async () => {
    const { conversation, calls, say, logs } = harness();
    await say('I am addressing this to Ada.');
    expect(calls).toHaveLength(1);
    // A cough: the voice detector says the person talked, but there are no words.
    conversation.humanSpeech(true);
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(2);
    // The question is in the history once, not twice.
    const questions = calls[1]?.messages.filter((m) => m.role === 'user') ?? [];
    expect(questions).toHaveLength(1);
    expect(logs.some((line) => line.includes('answering again'))).toBe(true);
  });

  it('answers a cancelled answer once, and not at all when new words arrive instead', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: Morning Josh. Ready when you are.');
    h.calls[0]?.end();
    await h.flush();
    // Something was said aloud, then the person talks over it and says nothing recognisable.
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.calls).toHaveLength(2); // they carry on once, after a pause, and not again
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(2);

    const second = harness();
    await second.say('First question.');
    second.conversation.humanSpeech(true);
    second.conversation.humanText('Actually, never mind.');
    second.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(second.calls).toHaveLength(2);
  });

  it('carries on when the person cuts in but says nothing, and not when words follow', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: Morning Josh. Ready when you are.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['Morning Josh.']);

    // The person makes a sound over it; nothing is recognised.
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.messages.at(-1)?.content).toContain('made a sound but said nothing');
    expect(h.logs.some((line) => line.includes('carrying on'))).toBe(true);

    // This time they say something: that is answered, with no "carry on" note.
    h.calls[1]?.push('Ada: Sure.');
    h.calls[1]?.end();
    await h.flush();
    h.conversation.humanSpeech(true);
    h.conversation.humanText('Actually, wait.');
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]?.messages.at(-1)).toEqual({ role: 'user', content: 'Actually, wait.' });
  });

  it('carries on quickly when recognition says a cut-in held no words', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: Morning Josh. Ready when you are.');
    h.calls[0]?.end();
    await h.flush();
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(2);
    // Nothing to carry on from when no answer was cut off.
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(2);
  });

  it('answers typed text without any voice behind it, and puts it in the transcript', async () => {
    const h = harness();
    h.conversation.humanTyped('  What is the status?  ');
    await vi.advanceTimersByTimeAsync(900);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'What is the status?' });
    expect(h.transcript[0]).toEqual(['Ada (Chef)', 'What is the status?']);
    h.conversation.humanTyped('   ');
    await vi.advanceTimersByTimeAsync(900);
    expect(h.calls).toHaveLength(1);
  });

  it('typing over an answer stops it, like speaking over it', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: One. Two.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing).toHaveLength(1);
    h.conversation.humanTyped('Wait.');
    expect(h.playing[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(h.calls).toHaveLength(2);
  });

  it('goes quiet on Stop and stays quiet: no carrying on, no retry', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: One. Two.');
    h.calls[0]?.end();
    await h.flush();
    h.conversation.stop();
    expect(h.playing[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ kind: 'idle' });
    // And it still answers the next thing said.
    await h.say('Thanks.');
    expect(h.calls).toHaveLength(2);
  });
  describe('a hand-over to another character', () => {
    it('makes the named character answer, once, without the person saying anything', async () => {
      const h = harness();
      await h.say('What is next?');
      h.calls[0]?.push('Ada: Bao, you own this one. What do you propose?');
      h.calls[0]?.end();
      await h.flush();
      h.playing[0]?.finish();
      await vi.advanceTimersByTimeAsync(1000);
      h.playing[1]?.finish();
      await vi.advanceTimersByTimeAsync(1500);
      await h.flush();
      expect(h.calls).toHaveLength(2);
      expect(JSON.stringify(h.calls[1]?.messages)).toContain('Ada handed over to Bao');
      h.calls[1]?.push('Bao: Make the early coins cheaper.');
      h.calls[1]?.end();
      await h.flush();
      expect(h.playing.map((p) => p.speaker)).toContain('Bao');
    });

    it('does not chain forever, and the person talking cancels it', async () => {
      const h = harness();
      await h.say('What is next?');
      h.calls[0]?.push('Ada: Bao, you go. What do you think?');
      h.calls[0]?.end();
      await h.flush();
      h.playing[0]?.finish();
      h.conversation.humanSpeech(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.calls).toHaveLength(1);
    });
  });

  describe('the host\'s spoken cues', () => {
    it('says the cue aloud with no model call, as a transcript line, and remembers it', async () => {
      const h = harness();
      h.conversation.announce('Ada', 'Welcome, everyone.');
      await h.flush();
      expect(h.calls).toHaveLength(0);
      expect(h.playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual(['Ada: Welcome, everyone.']);
      h.playing[0]?.finish();
      await h.conversation.settled();
      expect(h.transcript).toEqual([['Ada', 'Welcome, everyone.']]);
      // The next answer knows the host already said it.
      await h.say('Hi.');
      expect(JSON.stringify(h.calls[0]?.messages)).toContain('Ada: Welcome, everyone.');
    });

    it('waits for the room to be quiet instead of talking over the person or an answer', async () => {
      const h = harness();
      await h.say('Hello team.');
      h.conversation.announce('Ada', 'Time check.');
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.playing).toHaveLength(0);
      h.calls[0]?.push('Bao: Hi!');
      h.calls[0]?.end();
      await h.flush();
      h.playing[0]?.finish();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.playing.map((p) => p.text)).toEqual(['Hi!', 'Time check.']);
    });

    it('is stopped by the person talking over it, and an old question is not answered again', async () => {
      const h = harness();
      h.conversation.announce('Ada', 'Please wrap up.');
      await h.flush();
      h.conversation.humanSpeech(true);
      expect(h.playing[0]?.signal.aborted).toBe(true);
      h.conversation.humanSpeech(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.calls).toHaveLength(0);
    });

    it('drops a cue that finds the room busy for too long, and ignores unknown speakers', async () => {
      const h = harness();
      h.conversation.humanSpeech(true);
      h.conversation.announce('Ada', 'Late news.', 2000);
      h.conversation.announce('Nobody', 'Hello.');
      await vi.advanceTimersByTimeAsync(3000);
      h.conversation.humanSpeech(false);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.playing).toHaveLength(0);
      expect(h.logs.join('\n')).toContain('dropped Ada');
    });
  });
});
