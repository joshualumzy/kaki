import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import { NpcConversation, type NpcPorts } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import type { GuestReaderInput, GuestReading } from '../../src/npc/guestReader';

const scenario: Scenario = {
  id: 'checkpoint-four-review',
  organisation: 'Test Kitchen',
  meetingTitle: 'Opening readiness',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'host', label: 'Host' },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao (Cashier)' },
    { name: 'Sam', role: 'host', zoomDisplayName: 'Sam (Host)' },
  ],
  npcs: [
    { attendee: 'Sam', voice: 'v0', role: 'host', personality: 'Calm', agenda: 'Keep time', concerns: [] },
    { attendee: 'Ada', voice: 'v1', role: 'participant', personality: 'Calm chef', agenda: 'Cut waste', concerns: [] },
    { attendee: 'Bao', voice: 'v2', role: 'participant', personality: 'Chatty cashier', agenda: 'Fix queues', concerns: [] },
  ],
  agenda: [
    {
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      ownerRole: 'chef',
      decision: 'how do we cover prep?',
      directions: [
        'Ask Auntie Mary to come in.',
        'An agency temp needs notice and a till login.',
        'A manager covers the counter.',
      ],
      offScreen: {
        name: 'Auntie Mary',
        role: 'floor staff',
        howTheyAnswer: 'Auntie Mary answers once, in character, after a colleague says they will ask her first.',
      },
      discussion: {
        openingViews: [],
        tradeOffs: [{ attendee: 'Bao', role: 'cashier', tradeOff: 'A new till login takes fifteen minutes.', question: 'Who covers the till?' }],
      },
    },
    {
      title: 'Delivery app commission squeeze',
      minutes: 5,
      canWait: true,
      deadline: 'after the lunch rush',
      ownerRole: 'cashier',
      decision: 'how do we stop losing on delivered sets?',
      directions: [
        'Raise the app price.',
        'Offer office platters for five or more.',
      ],
    },
  ],
};

interface Playing {
  speaker: string;
  text: string;
  finish(): void;
  finished: boolean;
}

function reading(overrides: Partial<GuestReading> = {}): GuestReading {
  return {
    kind: 'answer',
    answersOpenQuestion: true,
    relevantFactIds: [],
    relevantCatchIds: [],
    readiness: {
      action: { covered: false },
      catchAddressed: { covered: false },
      practical: { covered: false },
    },
    ...overrides,
  };
}

function readyReading(text = 'Bao covers the till from 8'): GuestReading {
  return reading({
    readiness: {
      action: { covered: true, evidence: text },
      catchAddressed: { covered: true, evidence: text },
      practical: { covered: true, evidence: text },
    },
  });
}

function harness(options: {
  readings?: GuestReading[];
  replies?: string[];
  topicTimeBudgetMs?: number;
  budgetSilenceMs?: number;
  reviewNudgeMs?: number;
  reviewWindowMs?: number;
  responseDelayMs?: number;
  reader?: (input: GuestReaderInput) => Promise<GuestReading>;
} = {}) {
  const readings = [...(options.readings ?? [])];
  const replies = [...(options.replies ?? [])];
  const calls: ChatMessage[][] = [];
  const playing: Playing[] = [];
  const spoken: Array<[string, string]> = [];
  const logs: string[] = [];
  const states: string[] = [];
  const settle = vi.fn((_followUp: SuggestInput) => undefined);
  const advanced: string[] = [];
  const readerInputs: GuestReaderInput[] = [];

  const ports: NpcPorts<Utterance> = {
    async *stream(messages) {
      calls.push(messages);
      const reply = replies.shift();
      if (reply !== undefined) yield reply;
    },
    async synthesize(utterance) { return utterance; },
    play(speaker, clip) {
      return new Promise<void>((resolve) => {
        const entry: Playing = {
          speaker, text: clip.text, finished: false,
          finish: () => ((entry.finished = true), resolve()),
        };
        playing.push(entry);
      });
    },
    emitTranscript(speaker, text) { spoken.push([speaker, text]); },
    emitState(state) { states.push(state.kind); },
    log(message) { logs.push(message); },
    settleTopic: settle,
    advanceAgenda() { advanced.push('next'); },
  };

  const conversation = new NpcConversation<Utterance>(ports, {
    scenario,
    replies: 'one-speaker',
    responseDelayMs: options.responseDelayMs ?? 0,
    speakerGapMs: 0,
    sentenceGapMs: 0,
    observeDelayMs: 60_000,
    silencePromptMs: 60_000,
    openLiveGraceMs: 1,
    reviewNudgeMs: options.reviewNudgeMs ?? 1_000,
    reviewWindowMs: options.reviewWindowMs ?? 3_000,
    ...(options.topicTimeBudgetMs === undefined ? {} : { topicTimeBudgetMs: options.topicTimeBudgetMs }),
    ...(options.budgetSilenceMs === undefined ? {} : { budgetSilenceMs: options.budgetSilenceMs }),
    readGuestLine: async (input) => {
      readerInputs.push(input);
      if (options.reader !== undefined) return options.reader(input);
      return readings.shift() ?? reading();
    },
    gateStream: (request) => (async function* () {
      const lower = request.call.length === 0 ? request.call : `${request.call[0]!.toLowerCase()}${request.call.slice(1)}`;
      yield request.purpose === 'readback'
        ? `${request.speaker}: So it's ${lower}. That's the call?`
        : `${request.speaker}: How about we ${lower}?`;
    })(),
  });
  conversation.setHuman({ name: 'Josh', role: 'chef' });
  conversation.agendaMoved('Prep');

  return { conversation, readings, replies, calls, playing, spoken, logs, states, settle, advanced, readerInputs };
}

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

async function say(h: ReturnType<typeof harness>, text: string, value?: GuestReading): Promise<void> {
  if (value !== undefined) h.readings.push(value);
  h.conversation.humanTyped(text);
  for (let i = 0; i < 20; i += 1) await flush();
}

async function finishPlaying(h: ReturnType<typeof harness>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await flush();
    const next = h.playing.find((entry) => !entry.finished);
    if (next === undefined) return;
    next.finish();
    await flush();
  }
}

async function reachChoiceOffer(h: ReturnType<typeof harness>): Promise<void> {
  await say(h, 'We should do something.', reading({ kind: 'unsure' }));
  await finishPlaying(h);
  await say(h, 'You know, the usual.', reading({ kind: 'unsure' }));
  await finishPlaying(h);
  await say(h, 'Hmm.', reading({ kind: 'unsure' }));
  await finishPlaying(h);
}

describe('checkpoint 4 review fixes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits the option the guest chose from a two-option offer, not an unchosen call', async () => {
    const h = harness({ replies: ['Sam: The choice is how we cover the counter.', 'Sam: Pick the one that feels workable.'] });
    await reachChoiceOffer(h);

    const offer = h.playing.filter((entry) => /how about we/i.test(entry.text)).at(-1);
    expect(offer?.text.toLowerCase()).toContain('ask auntie mary to come in');

    await say(h, 'The first one.', reading({ kind: 'agree', chosenOption: 0 }));
    await finishPlaying(h);
    await flush();

    expect(h.settle).toHaveBeenCalledTimes(1);
    const input = h.settle.mock.calls[0]![0];
    expect(input.decisionSource).toBe('Ask Auntie Mary to come in');
    expect(input.decisionSource).not.toContain('The first one');
    h.conversation.close();
  });

  it('commits a bare yes to the one concrete offer', async () => {
    const h = harness({
      replies: [
        'Sam: The choice is how we cover the counter.',
        'Sam: Pick the one that feels workable.',
      ],
    });
    await reachChoiceOffer(h);

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await finishPlaying(h);
    await flush();

    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.settle.mock.calls[0]?.[0]?.decisionSource?.toLowerCase()).toContain('ask auntie mary to come in');
    h.conversation.close();
  });

  it('names the other realistic direction in a second offer, then closes honestly', async () => {
    const h = harness({
      replies: [
        'Sam: The choice is how we cover the counter.',
        'Sam: Pick the one that feels workable.',
      ],
    });
    await reachChoiceOffer(h);
    expect(h.playing.filter((entry) => /how about we/i.test(entry.text))).toHaveLength(1);

    await say(h, 'I still do not know.', reading({ kind: 'unsure' }));
    await finishPlaying(h);
    const offers = h.playing.filter((entry) => /how about we/i.test(entry.text));
    expect(offers).toHaveLength(2);
    expect(offers.at(-1)?.text.toLowerCase()).toContain('agency temp needs notice');
    expect(offers.at(-1)?.text).not.toContain(' or ');

    await say(h, 'Still not sure.', reading({ kind: 'unsure' }));
    await finishPlaying(h);
    await flush();
    await finishPlaying(h);

    expect(h.settle).not.toHaveBeenCalled();
    expect(h.advanced).toContain('next');
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);
    h.conversation.close();
  });

  it('advances an unresolved topic even when the closing line is cut off', async () => {
    const h = harness({
      readings: [reading({ kind: 'unsure' })],
      replies: ['Sam: Tell me what feels workable.'],
      topicTimeBudgetMs: 100,
      budgetSilenceMs: 10,
    });
    await say(h, 'hmm');
    await finishPlaying(h);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);

    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(h.advanced).toContain('next');
    h.conversation.close();
  });

  it('cancels a pending reading when the topic closes unresolved', async () => {
    let resolveReading: ((value: GuestReading) => void) | undefined;
    const pending = new Promise<GuestReading>((resolve) => { resolveReading = resolve; });
    const h = harness({ reader: () => pending, topicTimeBudgetMs: 100, budgetSilenceMs: 10 });
    h.conversation.humanTyped('Use the window bar.');
    await flush();

    await vi.advanceTimersByTimeAsync(100);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);

    resolveReading?.(readyReading('Use the window bar'));
    for (let i = 0; i < 20; i += 1) await flush();
    expect(h.logs).toContainEqual(expect.stringContaining('[reader] stale reading dropped'));

    await finishPlaying(h);
    await flush();
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.advanced).toContain('next');
    h.conversation.close();
  });

  it('keeps a guest line heard before its reply starts and answers it on resume', async () => {
    const h = harness({ readings: [readyReading('Bao covers the till from 8')], responseDelayMs: 1_000 });
    h.conversation.humanTyped('Bao covers the till from 8.');
    await flush();

    h.conversation.stop();
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.readerInputs).toHaveLength(1);

    h.conversation.resumeFromPause();
    await flush();
    await finishPlaying(h);

    expect(h.playing.some((entry) => entry.text.includes("So it's")), h.logs.join('\n')).toBe(true);

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('drops a reading that finishes after the topic moved on', async () => {
    let resolveReading: ((value: GuestReading) => void) | undefined;
    const pending = new Promise<GuestReading>((resolve) => { resolveReading = resolve; });
    const h = harness({ reader: () => pending });
    h.conversation.humanTyped('Use the window bar.');
    await flush();

    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();
    resolveReading?.(readyReading('Use the window bar'));
    for (let i = 0; i < 20; i += 1) await flush();

    expect(h.logs).toContainEqual(expect.stringContaining('[reader] stale reading dropped'));
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.logs.some((line) => line.includes('[confirm] the guest'))).toBe(false);
    h.conversation.close();
  });

  it('holds a guest line heard over an AI line instead of interrupting it, then reads it', async () => {
    const h = harness({
      readings: [
        readyReading('Bao covers the till from 8'),
        reading({
          kind: 'answer',
          readiness: {
            action: { covered: true, evidence: 'use the window bar instead' },
            catchAddressed: { covered: false },
            practical: { covered: false },
          },
        }),
      ],
    });
    await say(h, 'Bao covers the till from 8.');
    await flush();
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);

    h.conversation.humanSpeech(true);
    h.conversation.humanText('Use the window bar instead.');
    h.conversation.humanSpeech(false);
    await flush();

    expect(h.logs.some((line) => line.startsWith('interrupted:'))).toBe(false);
    expect(h.readerInputs.at(-1)?.line).toBe('Use the window bar instead.');
    expect(h.readerInputs.at(-1)?.saidWhileSpeaking).toBe('Sam');

    await finishPlaying(h);
    await flush();

    // The line was read and answered like any other, not dropped: the room restates or reconfirms.
    expect(h.logs.some((line) => line.includes('[reply] Sam (clarify)') || line.includes('[confirm]'))).toBe(true);
    expect(h.logs.some((line) => line.includes('no reply to guest'))).toBe(false);
    h.conversation.close();
  });

  it('treats a listener backchannel as allowed silence, with no reply', async () => {
    const h = harness({
      readings: [readyReading('Bao covers the till from 8'), reading({ kind: 'backchannel' })],
      replies: ['Sam: This should never be said.'],
    });
    await say(h, 'Bao covers the till from 8.');
    await flush();
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);
    const before = h.calls.length;

    h.conversation.humanSpeech(true);
    h.conversation.humanText('mm');
    h.conversation.humanSpeech(false);
    await flush();
    await finishPlaying(h);
    for (let i = 0; i < 10; i += 1) await flush();

    expect(h.readerInputs.at(-1)?.line).toBe('mm');
    expect(h.readerInputs.at(-1)?.saidWhileSpeaking).toBe('Sam');
    expect(h.calls).toHaveLength(before);
    expect(h.spoken).not.toContainEqual(['Sam', 'This should never be said.']);
    expect(h.logs.some((line) => line.includes('[planner] no reply to guest'))).toBe(false);
    h.conversation.close();
  });

  it('treats a typed listener backchannel as allowed silence too', async () => {
    const h = harness({
      readings: [readyReading('Bao covers the till from 8'), reading({ kind: 'backchannel' })],
      replies: ['Sam: This should never be said.'],
    });
    await say(h, 'Bao covers the till from 8.');
    await flush();
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);
    const before = h.calls.length;

    h.conversation.humanTyped('mm');
    for (let i = 0; i < 20; i += 1) await flush();

    expect(h.readerInputs.at(-1)?.line).toBe('mm');
    expect(h.calls).toHaveLength(before);
    expect(h.spoken).not.toContainEqual(['Sam', 'This should never be said.']);
    expect(h.logs.some((line) => line.includes('[planner] no reply to guest'))).toBe(false);
    h.conversation.close();
  });

  it('records a waitable topic as deferred and moves on when the defer line is heard', async () => {
    const h = harness({ readings: [reading({ kind: 'park' })], replies: ['Sam: Fine, we will come back to it after the lunch rush.'] });
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();

    await say(h, 'Let us leave that for later.');
    await finishPlaying(h);

    expect(h.logs).toContainEqual(expect.stringContaining('deferred to its later slot'));
    expect(h.advanced).toContain('next');
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('still moves on when the defer line could not be said', async () => {
    const h = harness({ readings: [reading({ kind: 'park' })], replies: [] });
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();

    await say(h, 'Let us leave that for later.');
    await finishPlaying(h);

    expect(h.logs).toContainEqual(expect.stringContaining('deferred to its later slot'));
    expect(h.advanced).toContain('next');
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });
});
