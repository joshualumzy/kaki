import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../../src/services/llm';
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
    { name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao (Cashier)' },
    { name: 'Sam', role: 'host', displayName: 'Sam (Host)' },
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
        tradeOffs: [{ attendee: 'Bao', role: 'cashier', idea: 'an agency temp', tradeOff: 'A new till login takes fifteen minutes.', question: 'Who covers the till?' }],
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
  sentenceGapMs?: number;
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
  /** Lines that started while another line was still playing: two voices at once. */
  const overlaps: Array<[string, string]> = [];

  const ports: NpcPorts<Utterance> = {
    async *stream(messages) {
      calls.push(messages);
      const reply = replies.shift();
      if (reply !== undefined) yield reply;
    },
    async synthesize(utterance) { return utterance; },
    play(speaker, clip, signal) {
      const still = playing.find((entry) => !entry.finished);
      if (still !== undefined) overlaps.push([still.text, clip.text]);
      return new Promise<void>((resolve) => {
        const entry: Playing = {
          speaker, text: clip.text, finished: false,
          finish: () => ((entry.finished = true), resolve()),
        };
        playing.push(entry);
        // Stopped sound is silent at once, as in the browser.
        signal.addEventListener('abort', () => entry.finish(), { once: true });
      });
    },
    emitTranscript(speaker, text) { spoken.push([speaker, text]); },
    emitTranscriptUpdate() {},
    emitState(state) { states.push(state.kind); },
    log(message) { logs.push(message); },
    settleTopic: settle,
    advanceAgenda() { advanced.push('next'); },
  };

  const conversation = new NpcConversation<Utterance>(ports, {
    scenario,
    responseDelayMs: options.responseDelayMs ?? 0,
    speakerGapMs: 0,
    sentenceGapMs: options.sentenceGapMs ?? 0,
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

  return { conversation, readings, replies, calls, playing, spoken, logs, states, settle, advanced, readerInputs, overlaps };
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
    // The guest's line is still being read, so time-up holds the close for a grace (#67), then closes.
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
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

describe('turn-taking (#66, #67, #68)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds a scripted cue while a reply is still reading the guest, so two lines never play at once (#66)', async () => {
    let resolveReading: ((value: GuestReading) => void) | undefined;
    const h = harness({
      reader: () => new Promise<GuestReading>((resolve) => { resolveReading = resolve; }),
      replies: ['Ada: The eggs are the problem.', 'Ada: The eggs are the problem.', 'Ada: The eggs are the problem.'],
    });
    h.conversation.humanTyped('Ada, what went wrong?');
    for (let i = 0; i < 5; i += 1) await flush();

    h.conversation.announce('Sam', "Okay, we'll leave prep open for now.");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(false);

    resolveReading?.(reading({ kind: 'question', addressee: 'Ada' }));
    for (let i = 0; i < 20; i += 1) await flush();
    await finishPlaying(h);
    await vi.advanceTimersByTimeAsync(1_000);
    await finishPlaying(h);

    expect(h.playing.some((entry) => entry.speaker === 'Ada')).toBe(true);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);
    expect(h.overlaps).toEqual([]);
    h.conversation.close();
  });
  it('never starts a line while the guest is already talking; it waits for them to stop (#67)', async () => {
    let resolveReading: ((value: GuestReading) => void) | undefined;
    const h = harness({
      reader: () => new Promise<GuestReading>((resolve) => { resolveReading = resolve; }),
      replies: ['Ada: The eggs are the problem.', 'Ada: The eggs are the problem.', 'Ada: The eggs are the problem.'],
    });
    h.conversation.humanTyped('Ada, what went wrong?');
    for (let i = 0; i < 5; i += 1) await flush();

    resolveReading?.(reading({ kind: 'question', addressee: 'Ada' }));
    h.conversation.humanSpeech(true);
    for (let i = 0; i < 20; i += 1) await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.playing.filter((entry) => entry.speaker === 'Ada')).toEqual([]);

    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(500);
    for (let i = 0; i < 20; i += 1) await flush();
    await finishPlaying(h);
    expect(h.playing.some((entry) => entry.speaker === 'Ada')).toBe(true);
    h.conversation.close();
  });

  it('holds the time-up close while the guest is talking, then closes once they stop (#67)', async () => {
    const h = harness({ topicTimeBudgetMs: 100, budgetSilenceMs: 10 });
    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('the guest is talking; holding the close'));

    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await finishPlaying(h);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);
    h.conversation.close();
  });
  it('keeps an offer live when the read of the answer fails, so the repeated yes still settles (#68)', async () => {
    const failed: GuestReading = { ...reading({ kind: 'unsure' }), failed: true };
    const queue: GuestReading[] = [];
    const h = harness({
      replies: ['Sam: The choice is how we cover the counter.', 'Sam: Pick the one that feels workable.'],
      reader: async () => queue.shift() ?? reading(),
    });
    queue.push(reading({ kind: 'unsure' }), reading({ kind: 'unsure' }), reading({ kind: 'unsure' }));
    await reachChoiceOffer(h);

    // The first answer is lost: the read and its one retry both fail.
    queue.push(failed, failed);
    await say(h, "Yeah, that's my call.");
    await finishPlaying(h);
    expect(h.logs).toContainEqual(expect.stringContaining('reading the line once more'));
    expect(h.logs).not.toContainEqual(expect.stringContaining('the offer is no longer live'));

    queue.push(reading({ kind: 'agree' }));
    await say(h, 'Yes, that one.');
    await finishPlaying(h);
    await flush();
    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it("keeps the offer live while Sam asks again after a failed read, so the next yes settles (#68)", async () => {
    const failed: GuestReading = { ...reading({ kind: 'unsure' }), failed: true };
    const queue: GuestReading[] = [];
    const h = harness({
      replies: [
        'Sam: The choice is how we cover the counter.',
        'Sam: Pick the one that feels workable.',
        "Sam: Sorry, I missed that. Is that your call?",
      ],
      reader: async () => queue.shift() ?? reading(),
    });
    queue.push(reading({ kind: 'unsure' }), reading({ kind: 'unsure' }), reading({ kind: 'unsure' }));
    await reachChoiceOffer(h);

    queue.push(failed, failed);
    await say(h, "Yeah, that's my call.");
    await finishPlaying(h);
    // Sam's re-ask is actually heard this time, and hearing it must not clear the offer.
    expect(h.playing.some((entry) => entry.text.includes('Is that your call'))).toBe(true);
    expect(h.logs).not.toContainEqual(expect.stringContaining('no longer live'));

    queue.push(reading({ kind: 'agree' }));
    await say(h, 'Yes, that one.');
    await finishPlaying(h);
    await flush();
    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('does not start the next sentence if the guest starts talking during the gap before it (#67)', async () => {
    const h = harness({
      sentenceGapMs: 400,
      readings: [reading({ kind: 'question', addressee: 'Ada' })],
      replies: ['Ada: The eggs are the problem. Ada: We need a second supplier.'],
    });
    h.conversation.humanTyped('Ada, what went wrong?');
    for (let i = 0; i < 20; i += 1) await flush();
    const first = h.playing.find((entry) => entry.text.includes('eggs'));
    expect(first).toBeDefined();
    first!.finish();
    await flush();

    // The guest starts talking inside the 400 ms gap, before the second sentence.
    await vi.advanceTimersByTimeAsync(200);
    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.playing.some((entry) => entry.text.includes('second supplier'))).toBe(false);
    h.conversation.close();
  });

  it('stops a line still playing after the floor wait instead of talking over it (#66)', async () => {
    const h = harness();
    // A scripted Sam line starts and its audio never ends.
    h.conversation.announce('Sam', 'Quick note before we go on.');
    for (let i = 0; i < 5; i += 1) await flush();
    const stuck = h.playing.find((entry) => entry.text.includes('Quick note'));
    expect(stuck?.finished).toBe(false);

    // The next planned step waits for the floor. Public paths rarely reach the timeout (typing interrupts, a held
    // guest line waits for playback), so the wait is driven directly.
    const floor = (h.conversation as unknown as { waitForFloor(signal: AbortSignal): Promise<void> })
      .waitForFloor(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(16_000);
    await floor;

    // The old line was stopped, not left sounding under the next one.
    expect(stuck?.finished).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining('interrupted: another line took the floor'));
    h.conversation.close();
  });
});

describe('topic time follows the agenda', () => {
  beforeEach(() => vi.useFakeTimers());

  it('closes a topic at its agenda minutes, not at a fixed three minutes', async () => {
    const h = harness();
    // "Prep" is a five-minute agenda item.
    await vi.advanceTimersByTimeAsync(180_000);
    await finishPlaying(h);
    expect(h.logs.some((line) => line.includes('time is up'))).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    await finishPlaying(h);
    expect(h.logs).toContainEqual(expect.stringContaining('[lock] time is up'));
    h.conversation.close();
  });

  it('leaves the clock\'s overtime cue to Sam\'s own time-up while he runs an unsettled topic', () => {
    const h = harness();
    expect(h.conversation.shouldSkipOvertimeCue()).toBe(true);
    h.conversation.close();
  });
});

describe('a line said before the topic opened', () => {
  beforeEach(() => vi.useFakeTimers());

  it('is shown but not read as the new topic\'s first guest line, so the opening is not cut short', async () => {
    const h = harness();
    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(2_000);
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(50);
    // The agenda moves on while the recogniser is still finishing the line.
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();
    const before = h.readerInputs.length;
    h.conversation.humanText("Let's move on to the next agenda.");
    for (let i = 0; i < 20; i += 1) await flush();

    expect(h.spoken).toContainEqual(['Josh', "Let's move on to the next agenda."]);
    expect(h.readerInputs.length).toBe(before);
    expect(h.logs).toContainEqual(expect.stringContaining('was said before "Delivery app commission squeeze" opened'));
    h.conversation.close();
  });

  it('still reads a line the person finished after the topic opened', async () => {
    const h = harness();
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await vi.advanceTimersByTimeAsync(50);
    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(2_000);
    h.conversation.humanSpeech(false);
    h.conversation.humanText('Raise the app price.');
    for (let i = 0; i < 20; i += 1) await flush();

    expect(h.readerInputs.some((input) => JSON.stringify(input).includes('Raise the app price'))).toBe(true);
    h.conversation.close();
  });
});
