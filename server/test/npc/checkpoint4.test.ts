import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import { NpcConversation, type NpcPorts } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import type { GuestReaderInput, GuestReading } from '../../src/npc/guestReader';

const scenario: Scenario = {
  id: 'checkpoint-four',
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
} = {}) {
  const readings = [...(options.readings ?? [])];
  const replies = [...(options.replies ?? [])];
  const calls: ChatMessage[][] = [];
  const playing: Playing[] = [];
  const spoken: Array<[string, string]> = [];
  const logs: string[] = [];
  const states: string[] = [];
  const settle = vi.fn(() => undefined);
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
    emitTranscriptUpdate() {},
    emitState(state) { states.push(state.kind); },
    log(message) { logs.push(message); },
    settleTopic: settle,
    advanceAgenda() {
      advanced.push('next');
    },
  };

  const conversation = new NpcConversation<Utterance>(ports, {
    scenario,
    responseDelayMs: 0,
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

describe('checkpoint 4: reading, readiness and the card transaction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers "idk" with a short help line instead of silence', async () => {
    const h = harness({
      readings: [reading({ kind: 'unsure' })],
      replies: ['Sam: No problem, the call is how we cover the counter.'],
    });
    await say(h, 'idk');
    await finishPlaying(h);

    expect(h.calls).toHaveLength(1);
    expect(String(h.calls[0]?.map((message) => message.content).join('\n'))).toContain('You are Sam');
    expect(h.spoken).toContainEqual(['Sam', 'No problem, the call is how we cover the counter.']);
    h.conversation.close();
  });

  it('turns "not sure what you mean" into a clarification, not a wait', async () => {
    const h = harness({
      readings: [reading({ kind: 'unsure' })],
      replies: ['Sam: I mean, who stands on the counter from 8 to 10?'],
    });
    await say(h, 'not sure what you mean');
    await finishPlaying(h);

    expect(h.calls).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] Sam (clarify)'));
    expect(h.spoken).toContainEqual(['Sam', 'I mean, who stands on the counter from 8 to 10?']);
    h.conversation.close();
  });

  it('checks once on noise, then waits for a second noise in a row', async () => {
    const h = harness({
      readings: [reading({ kind: 'noise' }), reading({ kind: 'noise' })],
      replies: ['Sam: Can you hear me now?'],
    });
    await say(h, 'testing');
    await finishPlaying(h);
    expect(h.calls).toHaveLength(1);

    await say(h, 'testing again');
    await finishPlaying(h);
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('a second noise in a row'));
    expect(h.logs.some((line) => line.includes('[planner] no reply to guest'))).toBe(false);
    h.conversation.close();
  });

  it('asks Sam to re-confirm when the confirmation is cut off, then commits on the next yes', async () => {
    const h = harness({ readings: [readyReading('Bao covers the till from 8')] });
    await say(h, 'Bao covers the till from 8.');
    await flush();

    const firstConfirm = h.playing.find((entry) => entry.text.includes("So it's"));
    expect(firstConfirm).toBeDefined();
    expect(firstConfirm?.finished).toBe(false);

    // The guest speaks over the confirmation before it is fully heard.
    await say(h, 'Yes.', reading({ kind: 'agree' }));
    expect(h.settle).not.toHaveBeenCalled();
    for (let i = 0; i < 40 && h.playing.filter((entry) => entry.text.includes("So it's")).length < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await flush();
    }
    expect(h.playing.filter((entry) => entry.text.includes("So it's")).length, h.logs.join('\n')).toBeGreaterThanOrEqual(2);

    const secondConfirm = h.playing.filter((entry) => entry.text.includes("So it's")).at(-1)!;
    secondConfirm.finish();
    await finishPlaying(h);
    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await flush();

    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('reopens the call when the guest corrects the confirmation', async () => {
    const h = harness({ readings: [readyReading('Bao covers the till from 8')] });
    await say(h, 'Bao covers the till from 8.');
    await finishPlaying(h);
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);

    await say(h, 'No, not that one.', reading({
      kind: 'answer',
      readiness: {
        action: { covered: true, evidence: 'Bao covers the till from 8' },
        catchAddressed: { covered: true, evidence: 'Bao covers the till from 8' },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);

    expect(h.logs).toContainEqual(expect.stringContaining('[confirm] the guest corrected the call; it is open again'));
    expect(h.settle).not.toHaveBeenCalled();

    await say(h, 'Ada covers it from 8.', reading({
      kind: 'answer',
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: true, evidence: 'Ada covers it from 8' },
      },
    }));
    await finishPlaying(h);
    const reconfirm = h.playing.filter((entry) => entry.text.includes("So it's")).at(-1)!;
    reconfirm.finish();
    await finishPlaying(h);
    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await flush();

    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('goes straight to confirmation when the manual Lock is pressed with an action covered but not ready', async () => {
    const h = harness({
      readings: [reading({
        kind: 'idea',
        readiness: {
          action: { covered: true, evidence: 'Do the plan' },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      })],
      replies: ['Bao: A new till login takes fifteen minutes.'],
    });
    await say(h, 'Do the plan.');
    await finishPlaying(h);
    h.conversation.lockDecision();
    await vi.advanceTimersByTimeAsync(500);
    await finishPlaying(h);

    expect(h.settle).not.toHaveBeenCalled();
    expect(h.playing.some((entry) => entry.text.includes("So it's")), h.logs.join('\n')).toBe(true);
    expect(h.playing.some((entry) => entry.text.includes('how would you deal'))).toBe(false);
    h.conversation.close();
  });

  it('records an unresolved topic and advances when time runs out with nothing usable', async () => {
    const h = harness({
      readings: [reading({ kind: 'unsure' })],
      replies: ['Sam: Tell me what feels workable.'],
      topicTimeBudgetMs: 100,
      budgetSilenceMs: 10,
    });
    await say(h, 'hmm');
    await finishPlaying(h);

    await vi.advanceTimersByTimeAsync(100);
    await finishPlaying(h);
    await vi.advanceTimersByTimeAsync(20);
    await finishPlaying(h);

    expect(h.settle).not.toHaveBeenCalled();
    expect(h.advanced).toContain('next');
    expect(h.logs).toContainEqual(expect.stringContaining('is unresolved: no usable call before time ran out'));
    expect(h.playing.some((entry) =>
      entry.text.startsWith("Okay, we'll leave") &&
      entry.text.includes("open for now, and come back if there's time."))).toBe(true);
    expect(h.playing.some((entry) => /card|screen/i.test(entry.text))).toBe(false);
    expect(h.conversation.memorySnapshot().some((entry) => entry.kind === 'decision')).toBe(false);
    h.conversation.close();
  });

  it('never points at the card before a committed settle', async () => {
    const h = harness();
    const done = vi.fn();
    h.conversation.pointAtCard('Point at the follow-up card', { onDone: done });
    await flush();

    expect(done).toHaveBeenCalledWith(false);
    expect(h.playing.some((entry) => /card/i.test(entry.text))).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('[card] refused to point at the card before the decision was committed'));
    h.conversation.close();
  });

  it('rolls the decision back when the task store fails', async () => {
    const h = harness({ readings: [readyReading('Bao covers the till from 8')] });
    h.settle.mockRejectedValueOnce(new Error('task store down'));
    await say(h, 'Bao covers the till from 8.');
    await finishPlaying(h);
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await flush();

    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.conversation.memorySnapshot().some((entry) => entry.kind === 'decision')).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('could not create follow-up'));
    h.conversation.close();
  });

  it('defers the delivery-app topic to its later slot when the guest parks it', async () => {
    const h = harness({ readings: [reading({ kind: 'park' })], replies: ['Sam: Fine, we will come back to it after the lunch rush.'] });
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();
    await say(h, 'Let us leave that for later.');
    await finishPlaying(h);

    expect(h.calls).toHaveLength(1);
    expect(String(h.calls[0]?.map((message) => message.content).join('\n'))).toContain('after the lunch rush');
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('caps a vague guest at two follow-ups, then offers the guest\'s own idea and settles on yes', async () => {
    const h = harness({
      replies: [
        'Ada: What do you want to do about the counter?',
        'Ada: What should we change first?',
      ],
      reviewNudgeMs: 10,
      reviewWindowMs: 1_000,
    });

    await say(h, 'We should do something.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'You know, the usual.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'Use the kiosk for orders.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);

    expect(h.calls, h.logs.join('\n')).toHaveLength(2);
    expect(h.logs.filter((line) => line.includes('[followup]'))).toHaveLength(2);
    expect(h.playing.some((entry) => /how about we/i.test(entry.text))).toBe(true);
    expect(h.playing.some((entry) => /kiosk for orders/i.test(entry.text))).toBe(true);

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await flush();
    expect(h.settle).toHaveBeenCalledTimes(1);

    h.conversation.taskStatus('task-1', 'Prep', 'DISPATCHED', true);
    await vi.advanceTimersByTimeAsync(10);
    await finishPlaying(h);
    expect(h.playing.some((entry) => /follow-up's on your screen/i.test(entry.text))).toBe(true);
    h.conversation.close();
  });

  it('turns a correction after the offer straight into confirmation of the corrected call', async () => {
    const h = harness({
      replies: [
        'Ada: What do you want to do about the counter?',
        'Ada: What should we change first?',
      ],
    });
    await say(h, 'We should do something.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'You know, the usual.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'Use the kiosk for orders.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);
    expect(h.calls, h.logs.join('\n')).toHaveLength(2);

    await say(h, 'No, use the window bar instead.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'use the window bar instead', revises: true },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);

    expect(h.calls, h.logs.join('\n')).toHaveLength(2);
    const confirm = h.playing.filter((entry) => entry.text.includes("So it's")).at(-1);
    expect(confirm?.text).toContain('use the window bar instead');
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('records an offer left unanswered at time-up as unresolved, with no card', async () => {
    const h = harness({
      replies: [
        'Ada: What do you want to do about the counter?',
        'Ada: What should we change first?',
      ],
      topicTimeBudgetMs: 100,
      budgetSilenceMs: 10,
    });
    await say(h, 'We should do something.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'You know, the usual.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'Use the kiosk for orders.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);

    await vi.advanceTimersByTimeAsync(100);
    await finishPlaying(h);
    await vi.advanceTimersByTimeAsync(20);
    await finishPlaying(h);

    expect(h.settle).not.toHaveBeenCalled();
    expect(h.advanced).toContain('next');
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);
    expect(h.playing.some((entry) => /follow-up's on your screen/i.test(entry.text))).toBe(false);
    h.conversation.close();
  });

  it('proposes the realistic who/when in the confirmation when only the action is covered', async () => {
    const h = harness({ reviewNudgeMs: 10 });
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();

    await say(h, 'Keep the regulars happy.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Keep the regulars happy' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);

    const confirmation = h.playing.map((entry) => entry.text).join(' ');
    expect(confirmation.toLowerCase()).toContain('keep the regulars happy');
    expect(confirmation.toLowerCase()).not.toContain('raise the app price');
    expect(h.settle).not.toHaveBeenCalled();

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await flush();
    expect(h.settle).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('gives two help lines to a confused guest, then offers one concrete call on the third', async () => {
    const h = harness({
      replies: [
        'Sam: The choice is about how we cover the counter before 8.',
        'Sam: Pick the one that feels workable for the counter.',
      ],
    });
    await say(h, 'idk', reading({ kind: 'unsure' }));
    await finishPlaying(h);
    await say(h, 'idk', reading({ kind: 'unsure' }));
    await finishPlaying(h);
    await say(h, 'idk', reading({ kind: 'unsure' }));
    await finishPlaying(h);

    expect(h.calls, h.logs.join('\n')).toHaveLength(2);
    expect(h.playing.some((entry) => /ask auntie mary to come in/i.test(entry.text))).toBe(true);
    expect(h.playing.some((entry) => /agency temp needs notice/i.test(entry.text))).toBe(false);
    h.conversation.close();
  });

  it('explains an urgent deadline once, then offers a concrete call on a second park, never parking', async () => {
    const h = harness({
      replies: ['Ada: We have to decide before doors open at 8, so this one cannot wait.'],
    });
    await say(h, 'Let us leave it for later.', reading({ kind: 'park' }));
    await finishPlaying(h);
    expect(h.playing.some((entry) => entry.text.includes('before doors open at 8'))).toBe(true);

    await say(h, 'We can do it later.', reading({ kind: 'park' }));
    await finishPlaying(h);

    expect(h.playing.some((entry) => /how about we/i.test(entry.text))).toBe(true);
    expect(h.logs.some((line) => line.includes('deferred'))).toBe(false);
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('offers one realistic direction when the manual Lock is pressed with nothing covered', async () => {
    const h = harness({ replies: ['Ada: What do you want to do about the counter?'] });
    await say(h, 'Hmm, maybe.', reading({ kind: 'answer' }));
    await finishPlaying(h);

    h.conversation.lockDecision();
    await finishPlaying(h);

    const offer = h.playing.filter((entry) => /how about we/i.test(entry.text)).at(-1);
    expect(offer?.text.toLowerCase()).toContain('ask auntie mary to come in');
    expect(offer?.text.toLowerCase()).not.toContain('agency temp needs notice');
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });


  it('closes an urgent topic honestly after a third park instead of going silent', async () => {
    const h = harness({
      replies: ['Ada: We have to decide before doors open at 8, so this one cannot wait.'],
    });
    await say(h, 'Let us leave it for later.', reading({ kind: 'park' }));
    await finishPlaying(h);
    await say(h, 'We can do it later.', reading({ kind: 'park' }));
    await finishPlaying(h);
    expect(h.playing.some((entry) => /how about we/i.test(entry.text))).toBe(true);

    await say(h, 'Really, later.', reading({ kind: 'park' }));
    await finishPlaying(h);
    await flush();
    await finishPlaying(h);

    expect(h.settle).not.toHaveBeenCalled();
    expect(h.advanced).toContain('next');
    expect(h.logs).toContainEqual(expect.stringContaining('is unresolved:'));
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(true);
    expect(h.conversation.memorySnapshot().some((entry) => entry.kind === 'decision')).toBe(false);
    h.conversation.close();
  });

  it('confirms the covered call after two offers instead of looping', async () => {
    const h = harness({
      replies: [
        'Ada: What do you want to do about the counter?',
        'Ada: What should we change first?',
      ],
    });
    await say(h, 'We should do something.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'You know, the usual.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'Use the kiosk for orders.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);
    expect(h.playing.filter((entry) => /how about we/i.test(entry.text))).toHaveLength(1);

    await say(h, 'No.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    expect(h.playing.filter((entry) => /how about we/i.test(entry.text))).toHaveLength(2);

    await say(h, 'Hmm.', reading({ kind: 'unsure' }));
    await finishPlaying(h);
    await flush();
    await finishPlaying(h);

    expect(h.playing.filter((entry) => /how about we/i.test(entry.text))).toHaveLength(2);
    expect(h.advanced).not.toContain('next');
    expect(h.playing.some((entry) => entry.text.endsWith("That's the call?"))).toBe(true);
    expect(h.playing.some((entry) => entry.text.includes('open for now'))).toBe(false);
    expect(h.settle).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('commits the guest\'s own call, not the interrupted offer, after a question and answer in between', async () => {
    const h = harness({
      replies: [
        'Bao: What do you want to do about delivered sets?',
        'Bao: What should we change first?',
        'Bao: It works because the delivered set is priced below cost.',
      ],
    });
    h.conversation.agendaMoved('Delivery app commission squeeze');
    await flush();

    await say(h, 'We should do something.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'You know, the usual.', reading({ kind: 'answer' }));
    await finishPlaying(h);
    await say(h, 'Raise the app price.', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Raise the app price' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await finishPlaying(h);
    expect(h.playing.some((entry) => /how about we/i.test(entry.text))).toBe(true);

    await say(h, 'Why would that work?', reading({ kind: 'question' }));
    await finishPlaying(h);
    expect(h.logs).toContainEqual(expect.stringContaining('the offer is no longer live'));

    await say(h, 'Yes.', reading({ kind: 'agree' }));
    await finishPlaying(h);

    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledWith(
      expect.objectContaining({ decisionSource: 'Raise the app price' }), false);
    expect(h.logs.some((line) => line.includes("the guest agreed to Sam's offer"))).toBe(false);
    expect(h.playing.some((entry) => entry.text.includes("So it's"))).toBe(true);
    h.conversation.close();
  });

  it('keeps the off-screen ask in the new reply path', async () => {
    const h = harness({
      replies: ['Ada: I will ask Auntie Mary first, before we count on her.'],
    });
    await say(h, 'Auntie Mary, can you cover the counter?', reading({ kind: 'question' }));
    await finishPlaying(h);

    expect(h.calls).toHaveLength(1);
    const request = String(h.calls[0]?.map((message) => message.content).join('\n'));
    expect(request).toContain('Auntie Mary');
    expect(request).toMatch(/ask (?:her )?first|off-screen/i);
    h.conversation.close();
  });
});
