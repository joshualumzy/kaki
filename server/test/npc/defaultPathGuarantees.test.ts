import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, SuggestInput } from '@kaki/shared';
import type { ChatMessage } from '../../src/services/llm';
import { NpcConversation, type ConversationOptions, type NpcPorts, type NpcUiState } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import type { GuestReaderInput, GuestReading } from '../../src/npc/guestReader';

const CHECK_IN_NOTE = 'checks in with Visitor in one short, warm, spoken sentence';

const scenario: Scenario = {
  id: 'default-path-guarantees',
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
      directions: ['Ask Auntie Mary to come in.', 'An agency temp needs notice and a till login.'],
    },
    {
      title: 'Delivery app commission squeeze',
      minutes: 5,
      canWait: true,
      deadline: 'after the lunch rush',
      ownerRole: 'cashier',
      decision: 'how do we stop losing on delivered sets?',
      directions: ['Raise the app price.', 'Offer office platters for five or more.'],
    },
  ],
};

interface LlmCall {
  messages: ChatMessage[];
  signal: AbortSignal;
  push(chunk: string): void;
  end(): void;
  fail(error: Error): void;
}

interface Playing {
  speaker: string;
  text: string;
  signal: AbortSignal;
  finish(): void;
  finished: boolean;
}

function reading(overrides: Partial<GuestReading> = {}): GuestReading {
  return {
    kind: 'answer',
    answersOpenQuestion: false,
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

interface HarnessOptions {
  scenarioUsed?: Scenario;
  role?: string;
  humanName?: string;
  readings?: GuestReading[];
  reader?: (input: GuestReaderInput) => GuestReading | Promise<GuestReading>;
  optionOverrides?: Partial<ConversationOptions>;
  synthesize?: (utterance: Utterance, signal: AbortSignal) => Promise<Utterance>;
  gateStream?: (request: { speaker: string; call: string; purpose: string }) => AsyncIterable<string>;
}

function harness(options: HarnessOptions = {}) {
  const scenarioUsed = options.scenarioUsed ?? scenario;
  const readings = [...(options.readings ?? [])];
  const calls: LlmCall[] = [];
  const playing: Playing[] = [];
  const states: NpcUiState[] = [];
  const transcript: Array<[string, string]> = [];
  const transcriptOptions: Array<[string, string, { textOnly?: boolean } | undefined]> = [];
  const logs: string[] = [];
  const settleTopic = vi.fn((_followUp: SuggestInput) => undefined);
  const endMeeting = vi.fn();
  const onReaction = vi.fn();
  let conversation: NpcConversation<Utterance>;
  let agendaIndex = 0;

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
    async synthesize(utterance, signal) {
      if (options.synthesize !== undefined) return options.synthesize(utterance, signal);
      return utterance;
    },
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
    emitTranscript(speaker, text, transcriptOption) {
      transcript.push([speaker, text]);
      transcriptOptions.push([speaker, text, transcriptOption]);
    },
    emitTranscriptUpdate() {},
    emitState(state) { states.push(state); },
    log(message) { logs.push(message); },
    settleTopic,
    endMeeting,
    onReaction,
    advanceAgenda() {
      agendaIndex += 1;
      const next = scenarioUsed.agenda[agendaIndex];
      if (next !== undefined) conversation.agendaMoved(next.title);
    },
  };

  const gateStreamFor = options.gateStream ?? ((request: { speaker: string; call: string; purpose: string }) => (async function* () {
    const lower = request.call.length === 0 ? request.call : `${request.call[0]!.toLowerCase()}${request.call.slice(1)}`;
    yield request.purpose === 'readback'
      ? `${request.speaker}: So it's ${lower}. That's the call?`
      : `${request.speaker}: How about we ${lower}?`;
  })());

  conversation = new NpcConversation<Utterance>(ports, {
    scenario: scenarioUsed,
    responseDelayMs: 0,
    speakerGapMs: 0,
    sentenceGapMs: 0,
    observeDelayMs: 60_000,
    silencePromptMs: 60_000,
    openLiveGraceMs: 1,
    reviewNudgeMs: 1_000,
    reviewWindowMs: 3_000,
    readGuestLine: async (input) => {
      if (options.reader !== undefined) return options.reader(input);
      return readings.shift() ?? reading({ answersOpenQuestion: input.openQuestion !== undefined });
    },
    gateStream: (request) => gateStreamFor(request),
    ...options.optionOverrides,
  });
  conversation.setHuman({ name: options.humanName ?? 'Visitor', role: options.role ?? 'chef' });
  conversation.agendaMoved(scenarioUsed.agenda[0]!.title);

  const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

  async function flushTimes(times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) await flush();
  }

  async function waitForCall(index: number): Promise<LlmCall> {
    for (let i = 0; i < 100 && calls.length <= index; i += 1) await flush();
    if (calls.length <= index) throw new Error(`expected call ${index}, got ${calls.length}`);
    return calls[index]!;
  }

  async function waitForCallMatching(match: (call: LlmCall) => boolean): Promise<LlmCall> {
    for (let i = 0; i < 100; i += 1) {
      const found = calls.find(match);
      if (found !== undefined) return found;
      await flush();
    }
    throw new Error('no matching call');
  }

  async function finishPlaying(): Promise<void> {
    for (let i = 0; i < 80; i += 1) {
      await flush();
      const next = playing.find((entry) => !entry.finished);
      if (next === undefined) return;
      next.finish();
      await flush();
    }
    throw new Error('playback did not finish');
  }

  function expectedSpeaker(call: LlmCall): string {
    const text = call.messages.map((message) => message.content).join('\n');
    const match = /You are ([A-Za-z][A-Za-z' -]*?)(?:,|\n|$)/.exec(text);
    if (match === null) throw new Error('no expected speaker in the request');
    return match[1]!.trim();
  }

  async function settleWith(decision: string, evidence = decision): Promise<void> {
    readings.push(readyReading(evidence));
    conversation.humanTyped(decision);
    await flushTimes(5);
    await finishPlaying();
    readings.push(reading({ kind: 'agree', answersOpenQuestion: true }));
    conversation.humanTyped('Yes.');
    await flushTimes(5);
  }

  function addCard(title = scenarioUsed.agenda[agendaIndex]!.title): void {
    conversation.taskStatus('task-0', title, 'DISPATCHED', true);
  }

  return {
    conversation, ports, calls, playing, states, transcript, transcriptOptions, logs,
    settleTopic, endMeeting, onReaction, readings,
    flush, flushTimes, waitForCall, waitForCallMatching, finishPlaying, settleWith, addCard, expectedSpeaker,
    agendaIndex: () => agendaIndex,
  };
}

const twoNpcScenario: Scenario = {
  ...scenario,
  npcs: scenario.npcs!.filter((npc) => npc.attendee === 'Sam' || npc.attendee === 'Ada'),
};

type H = ReturnType<typeof harness>;

afterEach(() => vi.useRealTimers());

describe('default-path guarantees ported from the legacy tests', () => {
  beforeEach(() => vi.useFakeTimers());

  describe('the visitor can always finish the meeting', () => {
    const twoTopics: Scenario = {
      ...scenario,
      agenda: [
        { ...scenario.agenda[0]!, title: 'Prep', decision: 'how do we cover prep?' },
        { ...scenario.agenda[1]!, title: 'Service', decision: 'how do we survive the lunch rush?' },
      ],
    };

    for (const role of ['chef', 'cashier', 'host'] as const) {
      it(`sends a follow-up on both topics and ends for ${role}`, async () => {
        const h = harness({ scenarioUsed: twoTopics, role });
        for (let topic = 0; topic < 2; topic += 1) {
          const title = twoTopics.agenda[topic]!.title;
          h.conversation.agendaMoved(title);
          await h.flush();
          await h.settleWith(`We will use the plan for ${title} from 8.`);
          expect(h.settleTopic).toHaveBeenCalledTimes(topic + 1);
          expect(h.settleTopic).toHaveBeenLastCalledWith(
            expect.objectContaining({ agendaItemTitle: title, suggestedAssignee: role }), false);
          h.addCard(title);
          h.conversation.taskStatus('task-0', title, 'SYNCED', true);
          await vi.advanceTimersByTimeAsync(2);
          await h.flushTimes(5);
        }
        expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
        expect(h.endMeeting).toHaveBeenCalledTimes(1);
        h.conversation.close();
      });
    }

    it('settles forty differently worded decisions as the visitor progresses', async () => {
      const decisions = [
        "Okay, so let's open the window bar.", 'Right, open the window bar.',
        'No, we keep the kitchen open with fresh stock.', 'Hmm, I think we should use the window bar.',
        "I'll put the stools at the window bar.", 'I will make sure the chef shows the receipt.',
        'Post a staff member at the door.', 'Send the family an apology and pay the bill.',
        'Put table signs on the booths.', 'Open the side door for deliveries.',
        'Keep the ten booths for diners.', 'Switch the wall sockets off during breakfast.',
        'Give solo diners the window seats.', 'Use both counters for the morning rush.',
        'Let the chef check each fresh tray.', 'I choose the smaller menu.',
        'We should trial the new ordering screen.', 'Try a short queue outside.',
        'Actually, keep the old names on receipts.', 'Make the labels larger.',
        'Launch the office platter first.', 'Hold the discount until margins are checked.',
        'Let staff guide first-time customers.', 'Move laptops away from the booths.',
        'Close only the affected fridge.', 'Document the disposal immediately.',
        'Use a direct pickup code.', 'I back the window bar plan.',
        'My decision is to split the queue.', 'Do the slower option to protect quality.',
        'Yes, set up the signs before opening.', 'Sure, give Auntie Mary help at the door.',
        'Wait, use fresh stock instead.', 'Thanks, I choose the office bundle.',
        'File the receipt with the inspection notes.', 'Write the seating policy today.',
        'We can absorb this cost once.', 'Give the hospital a goodwill payment.',
        'Let us hold the kopi price and explain it at the counter.', 'The staff should lead the rollout.',
      ];
      expect(decisions).toHaveLength(40);
      for (const decision of decisions) {
        const h = harness({ scenarioUsed: { ...scenario, agenda: [scenario.agenda[0]!] } });
        await h.settleWith(decision);
        expect(h.settleTopic, decision).toHaveBeenCalledTimes(1);
        expect(h.settleTopic.mock.calls[0]![0].context, decision).toContain(decision);
        h.conversation.close();
      }
    });
  });

  describe('silence check-ins', () => {
    async function seedRoom(h: H): Promise<void> {
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const answer = await h.waitForCall(0);
      answer.push(`${h.expectedSpeaker(answer)}: What do we tell people at the counter?`);
      answer.end();
      await h.flushTimes(5);
      await h.finishPlaying();
    }

    it('lets the room hear the silence nudge about 22 seconds after it goes quiet', async () => {
      const h = harness({
        scenarioUsed: twoNpcScenario,
        optionOverrides: { silencePromptMs: 22_000, silenceNudgeLeadMs: 15_000 },
      });
      await seedRoom(h);
      const quietAt = Date.now();
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.transcript.some(([, line]) => /still there/.test(line))).toBe(false);
      expect(h.states.at(-1)?.kind).not.toBe('thinking');
      const nudge = await h.waitForCall(1);
      nudge.push('Sam: Are you still there?');
      nudge.end();
      await vi.advanceTimersByTimeAsync(4_000);
      await h.finishPlaying();
      await h.conversation.settled();
      expect(h.transcript).toContainEqual(['Sam', 'Visitor, are you still there?']);
      expect(Date.now() - quietAt).toBeGreaterThanOrEqual(22_000);
      expect(Date.now() - quietAt).toBeLessThanOrEqual(25_000);
      h.conversation.close();
    });

    it('forgets a silence check-in the visitor interrupted before any of it was heard', async () => {
      const h = harness({
        scenarioUsed: twoNpcScenario,
        optionOverrides: { silencePromptMs: 1_000, silenceNudgeLeadMs: 999 },
      });
      await seedRoom(h);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.transcript).not.toContainEqual(['Sam', "Visitor, no rush, what's your gut saying?"]);
      const checkIn = await h.waitForCall(1);
      expect(String(checkIn.messages.at(-1)?.content)).toContain(CHECK_IN_NOTE);
      const answerAt = h.calls.length;
      h.conversation.humanTyped('Could a simple sign on some tables help?');
      await h.flushTimes(5);
      const next = await h.waitForCall(answerAt);
      expect(next.messages.some((message) => message.content.includes(CHECK_IN_NOTE))).toBe(false);
      expect(next.messages.at(-1)?.content).toContain('Could a simple sign on some tables help?');
      h.conversation.close();
    });

    it('starts the silence escalation again at the check-in after the visitor speaks', async () => {
      const checkIn = "Visitor, no rush, what's your gut saying?";
      const secondCheckIn = "Visitor, whenever you're ready, what feels right?";
      const h = harness({
        scenarioUsed: twoNpcScenario,
        optionOverrides: { silencePromptMs: 1_000, silenceNudgeLeadMs: 999 },
        reader: () => reading({ kind: 'idea' }),
      });
      await seedRoom(h);
      await vi.advanceTimersByTimeAsync(1_000);
      const first = await h.waitForCall(1);
      first.push(`Sam: ${checkIn}`);
      first.end();
      await h.flush();
      await h.finishPlaying();
      expect(h.transcript).toContainEqual(['Sam', checkIn]);
      expect(h.transcript.filter(([, line]) => line === checkIn)).toHaveLength(1);

      h.conversation.humanTyped('We could put a sign on the tables.');
      await h.flushTimes(5);
      const answer = await h.waitForCall(2);
      answer.push(`${h.expectedSpeaker(answer)}: A sign on the tables would help.`);
      answer.end();
      await h.flush();
      await h.finishPlaying();

      await vi.advanceTimersByTimeAsync(1_000);
      const second = await h.waitForCall(3);
      second.push(`Ada: ${secondCheckIn}`);
      second.end();
      await h.flush();
      await h.finishPlaying();
      expect(h.transcript).toContainEqual(['Ada', secondCheckIn]);
      h.conversation.close();
    });

    it('keeps an unheard silence check-in for its wordless retry', async () => {
      const checkIn = "Visitor, no rush, what's your gut saying?";
      const h = harness({
        scenarioUsed: twoNpcScenario,
        optionOverrides: { silencePromptMs: 1_000, silenceNudgeLeadMs: 999, bargeInMs: 0, retryMs: 100 },
      });
      await seedRoom(h);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.transcript).not.toContainEqual(['Sam', checkIn]);
      const checkInCall = await h.waitForCallMatching((call) =>
        call.messages.some((message) => message.content.includes(CHECK_IN_NOTE)));
      // It has been written, but nothing of it has been heard yet.
      await h.flush();
      expect(h.transcript).not.toContainEqual(['Sam', checkIn]);
      const before = h.calls.length;
      h.conversation.humanSpeech(true);
      h.conversation.humanSpeech(false);
      await vi.advanceTimersByTimeAsync(200);
      await h.flushTimes(5);
      // The wordless cut-in keeps the check-in for its retry instead of losing it.
      const retry = h.calls.length > before ? h.calls.at(-1)! : checkInCall;
      retry.push(`Sam: ${checkIn}`);
      retry.end();
      await h.flush();
      await h.finishPlaying();
      expect(h.transcript, h.logs.join('\n')).toContainEqual(['Sam', checkIn]);
      expect(String(h.calls.at(-1)?.messages.at(-1)?.content)).toContain(CHECK_IN_NOTE);
      h.conversation.close();
    });
  });

  describe('the card review window', () => {
    it('marks the card at 20 s without Sam speaking or moving on', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.transcript.some(([, line]) => line.includes("the follow-up's on your screen"))).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await h.finishPlaying();
      expect(h.logs.filter((line) => line.includes('[card] review nudge on'))).toHaveLength(1);
      expect(h.transcript.some(([, line]) => /on your (?:screen|card)/i.test(line))).toBe(false);
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(false);
      expect(h.agendaIndex()).toBe(0);
      h.conversation.close();
    });

    it('moves on at 45 s when the card is still untouched', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      await vi.advanceTimersByTimeAsync(20_000);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(24_999);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(false);
      expect(h.agendaIndex()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(true);
      expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
      h.conversation.close();
    });

    it('nudges only once in a review sequence', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      await vi.advanceTimersByTimeAsync(20_000);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(24_999);
      await h.finishPlaying();
      expect(h.logs.filter((line) => line.includes('[card] review nudge on'))).toHaveLength(1);
      h.conversation.close();
    });

    it('restarts the review window when the visitor makes progress on the card, without another nudge', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      await vi.advanceTimersByTimeAsync(20_000);
      await h.finishPlaying();
      expect(h.logs.filter((line) => line.includes('[card] review nudge on'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      h.conversation.taskStatus('task-0', 'Prep', 'DISPATCHED', true);
      await vi.advanceTimersByTimeAsync(15_000);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(false);
      expect(h.agendaIndex()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      await h.finishPlaying();
      expect(h.logs.filter((line) => line.includes('[card] review nudge on'))).toHaveLength(1);
      expect(h.logs.some((line) => line.includes('skipped the card nudge'))).toBe(true);
      h.conversation.close();
    });

    it('skips the card nudge once the host handoff line pointed at the card on this topic', async () => {
      const handoff = "Visitor, the follow-up's still on your screen whenever you're ready.";
      const h = harness({
        optionOverrides: { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      h.conversation.announce('Sam', handoff);
      await h.flush();
      await h.finishPlaying();
      expect(h.transcript).toContainEqual(['Sam', handoff]);
      await vi.advanceTimersByTimeAsync(20_000);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes("the follow-up's on your screen"))).toBe(false);
      expect(h.logs.some((line) => line.includes('skipped the card nudge'))).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(true);
      h.conversation.close();
    });

    it('holds the card nudge while a question is open and marks it once it is answered', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 1_000, reviewWindowMs: 3_000 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      h.conversation.announce('Bao', 'Visitor, who covers the counter?');
      await h.flush();
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.logs).toContainEqual(expect.stringContaining('[card] skipped the review nudge while a question to the guest is open'));
      expect(h.transcript.some(([, line]) => /the follow-up's on your screen/i.test(line))).toBe(false);

      h.readings.push(reading({ kind: 'answer', addressee: 'Bao', answersOpenQuestion: true }));
      h.conversation.humanTyped('Bao, Mei covers the counter from nine.');
      await h.flushTimes(5);
      const answer = await h.waitForCall(1);
      answer.push(`${h.expectedSpeaker(answer)}: Mei can cover it from nine.`);
      answer.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(1_000);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(1_000);
      await h.finishPlaying();
      expect(h.logs.some((line) => line.includes('[card] review nudge on')), h.logs.join('\n')).toBe(true);
      expect(h.transcript.some(([, line]) => /on your (?:screen|card)/i.test(line))).toBe(false);
      h.conversation.close();
    });
  });

  describe('timers survive a pause', () => {
    it('resumes the completion grace after Stop so a synced topic can end', async () => {
      const h = harness({ optionOverrides: { openLiveGraceMs: 20 } });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      h.conversation.taskStatus('task-0', 'Prep', 'SYNCED', true);
      h.conversation.stop();
      await vi.advanceTimersByTimeAsync(30);
      expect(h.agendaIndex()).toBe(0);
      h.conversation.resumeFromPause();
      await vi.advanceTimersByTimeAsync(30);
      expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
      h.conversation.close();
    });

    it('resumes the review window after Stop so an unfinished topic can end', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 60_000, reviewWindowMs: 20 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      h.conversation.stop();
      await vi.advanceTimersByTimeAsync(30);
      expect(h.agendaIndex()).toBe(0);
      h.conversation.resumeFromPause();
      await vi.advanceTimersByTimeAsync(550);
      await h.finishPlaying();
      expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
      h.conversation.close();
    });

    it('restores the review window when typing resumes a stopped meeting', async () => {
      const h = harness({
        optionOverrides: { reviewNudgeMs: 60_000, reviewWindowMs: 20 },
      });
      await h.settleWith('We will use the window bar from 8.');
      h.addCard();
      h.readings.push(reading({ kind: 'backchannel' }));
      h.conversation.stop();
      h.conversation.humanTyped('I will check the card.');
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(550);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(1_000);
      await h.finishPlaying();
      expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
      h.conversation.close();
    });
  });

  describe('the topic leaves only when the visitor task is synced', () => {
    it('keeps sure and an early task on this topic until the visitor task is synced', async () => {
      const h = harness({ optionOverrides: { openLiveGraceMs: 1 } });
      await h.settleWith('We will use the window bar from 8.');
      h.conversation.taskStatus('early', 'Prep', 'SYNCED', true);
      await h.flushTimes(5);
      expect(h.agendaIndex()).toBe(0);
      h.addCard();
      h.readings.push(reading({ kind: 'backchannel' }));
      h.conversation.humanTyped('sure');
      await h.flushTimes(5);
      await h.finishPlaying();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.agendaIndex()).toBe(0);
      h.conversation.taskStatus('task-0', 'Prep', 'SYNCED', true);
      await vi.advanceTimersByTimeAsync(2);
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.agendaIndex(), h.logs.join('\n')).toBe(1);
      h.conversation.close();
    });

    it('moves on without the leave-there wrap-up after the visitor parks a topic', async () => {
      const h = harness({ reader: () => reading({ kind: 'park' }) });
      h.conversation.agendaMoved('Delivery app commission squeeze');
      await h.flush();
      h.conversation.humanTyped('Park it for now, we can come back to it.');
      await h.flushTimes(10);
      const answer = await h.waitForCall(0);
      answer.push(`${h.expectedSpeaker(answer)}: We can come back to it after the lunch rush.`);
      answer.end();
      await h.flushTimes(10);
      await h.finishPlaying();
      expect(h.settleTopic).not.toHaveBeenCalled();
      expect(h.endMeeting, h.logs.join('\n')).toHaveBeenCalledTimes(1);
      expect(h.transcript.some(([, line]) => line.includes("Let's leave"))).toBe(false);
      h.conversation.close();
    });
  });

  describe('budget and lock', () => {
    it('reoffers budget recovery after a visitor clarification leaves the topic open', async () => {
      const h = harness({
        reader: () => reading({ kind: 'backchannel' }),
        optionOverrides: {
          topicTurnBudget: 1, budgetSilenceMs: 20, topicTimeBudgetMs: 600_000, silencePromptMs: 600_000,
        },
      });
      h.conversation.humanTyped('Use the window bar.');
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(510);
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.filter(([, line]) => line.includes('How about we'))).toHaveLength(1);

      h.conversation.humanTyped('Could we keep a seat for walk-ins?');
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(510);
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.filter(([, line]) => line.includes('How about we'))).toHaveLength(1);
      h.conversation.close();
    });

    it('blocks another lock-in ask within a minute and suppresses an immediate overtime cue', async () => {
      const h = harness({
        reader: () => reading({ kind: 'backchannel' }),
        optionOverrides: {
          topicTurnBudget: 1, budgetSilenceMs: 20, topicTimeBudgetMs: 600_000, silencePromptMs: 600_000,
        },
      });
      h.conversation.humanTyped('Use the window bar.');
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(510);
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.filter(([, line]) => line.includes('How about we'))).toHaveLength(1);

      h.conversation.humanTyped('Could we wait?');
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(510);
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.filter(([, line]) => line.includes('How about we'))).toHaveLength(1);
      expect(h.logs.some((line) => line.includes('skipped a repeated lock-in ask'))).toBe(false);
      h.conversation.close();
    });

    it('keeps Lock enabled while the model thinks after a visitor line', async () => {
      const h = harness({ reader: () => reading({ kind: 'answer' }) });
      h.conversation.humanTyped('Use the window bar.');
      await h.flushTimes(5);
      expect(h.states.at(-1)).toMatchObject({ kind: 'thinking', canLock: true });
      h.conversation.lockDecision();
      await h.flushTimes(5);
      expect(h.calls.length).toBeGreaterThanOrEqual(1);
      await h.finishPlaying();
      h.conversation.close();
    });

    it('reopens one earlier meeting item, replaces its decision, and returns to the current item', async () => {
      const twoItems: Scenario = {
        ...scenario,
        agenda: [scenario.agenda[0]!, { ...scenario.agenda[1]!, title: 'Service' }],
      };
      const h = harness({ scenarioUsed: twoItems });
      await h.settleWith('We will use the first plan from 8.');
      expect(h.settleTopic).toHaveBeenCalledTimes(1);
      h.conversation.agendaMoved('Service');
      await h.flush();

      h.conversation.humanTyped('Actually, change the Prep plan.');
      await h.flushTimes(5);
      const reopen = await h.waitForCallMatching((call) =>
        call.messages.some((message) => message.content.includes('Actually, change the Prep plan.')));
      reopen.push(`KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reopen":"Prep"}\n${h.expectedSpeaker(reopen)}: Changing that means extra setup.`);
      reopen.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.conversation.onCurrentAgenda('Prep')).toBe(true);

      h.conversation.humanTyped('Use the revised plan.');
      await h.flushTimes(5);
      h.conversation.lockDecision(undefined, { confirmed: true });
      await h.flushTimes(5);
      expect(h.settleTopic).toHaveBeenLastCalledWith(expect.objectContaining({ agendaItemTitle: 'Prep' }), true);
      expect(h.conversation.onCurrentAgenda('Service')).toBe(true);
      h.conversation.close();
    });
  });

  describe('reactions and ownership', () => {
    it('sends a reaction as the reply starts, once, before it finishes playing', async () => {
      const h = harness();
      h.conversation.humanTyped('Can we get help?');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reactions":[{"who":"Ada","emoji":"🙌"}]}\n${h.expectedSpeaker(call)}: It will cost $37.`);
      call.end();
      await h.flushTimes(5);
      expect(h.playing).toHaveLength(1);
      expect(h.playing[0]?.finished).toBe(false);
      expect(h.onReaction).toHaveBeenCalledTimes(1);
      expect(h.onReaction).toHaveBeenCalledWith('Ada', '🙌');
      h.playing[0]?.finish();
      await h.flushTimes(5);
      expect(h.onReaction).toHaveBeenCalledTimes(1);
      h.conversation.close();
    });

    it('sends no reaction when the turn is aborted before any line plays', async () => {
      const h = harness();
      h.conversation.humanTyped('Can we get help?');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reactions":[{"who":"Ada","emoji":"🙌"}]}\n');
      await h.flushTimes(2);
      h.conversation.humanTyped('Never mind.');
      await h.flushTimes(5);
      expect(h.playing).toHaveLength(0);
      expect(h.onReaction).not.toHaveBeenCalled();
      h.conversation.close();
    });

    it('drops a host sentence that tells the visitor to send the follow-up, and logs it', async () => {
      const hostOnly: Scenario = { ...scenario, npcs: scenario.npcs!.filter((npc) => npc.role === 'host') };
      const h = harness({
        scenarioUsed: hostOnly,
        reader: () => reading({ kind: 'question' }),
        optionOverrides: { reviewNudgeMs: 60_000, reviewWindowMs: 60_000 },
      });
      h.conversation.humanTyped('We will use the window bar from 8.');
      await h.flushTimes(5);
      h.conversation.lockDecision(undefined, { confirmed: true });
      await h.flushTimes(5);
      h.addCard();
      h.conversation.humanTyped('Anything else?');
      await h.flushTimes(5);
      const call = await h.waitForCallMatching((entry) =>
        entry.messages.some((message) => message.content.includes('Anything else?')));
      const send = 'Send the decision round to the team in a short note before you head off.';
      call.push(`${h.expectedSpeaker(call)}: ${send}`);
      call.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line === send)).toBe(false);
      expect(h.logs, h.logs.join('\n')).toContain(`[card] dropped host send-instruction: ${send}`);
      h.conversation.close();
    });

    it('drops a colleague taking over the visitor\'s follow-up, and logs it', async () => {
      const h = harness({
        reader: () => reading({ kind: 'answer', addressee: 'Bao' }),
        optionOverrides: { reviewNudgeMs: 60_000, reviewWindowMs: 60_000 },
      });
      h.conversation.humanTyped('What do we say?');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: Right, the price stays. I'll post the update to the team.`);
      call.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => /post the update to the team/i.test(line))).toBe(false);
      expect(h.logs.some((line) => line.startsWith('[owner]'))).toBe(true);
      h.conversation.close();
    });
  });

  describe('barge-in and the speech gate', () => {
    it('does not cut the room off for a short burst of noise, but does for a person who keeps talking', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { bargeInMs: 900, askDelayMs: 600_000 } });
      h.conversation.announce('Sam', 'Morning. Ready when you are.');
      await h.flushTimes(5);
      expect(h.playing).toHaveLength(1);
      const callsBefore = h.calls.length;

      h.conversation.humanSpeech(true);
      await vi.advanceTimersByTimeAsync(500);
      h.conversation.humanSpeech(false);
      h.conversation.humanNothing();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.playing[0]?.signal.aborted).toBe(false);
      expect(h.calls).toHaveLength(callsBefore);

      h.conversation.humanSpeech(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.playing[0]?.signal.aborted).toBe(true);
      h.conversation.close();
    });

    it('stops talking the moment the person talks over it, and remembers only what was heard', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { bargeInMs: 0, askDelayMs: 600_000 } });
      h.conversation.humanTyped('Give me the status.');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: The build is red. We have a crash.`);
      call.end();
      await h.flushTimes(5);
      expect(h.playing.map((entry) => entry.text)).toEqual(['The build is red.']);

      h.conversation.humanSpeech(true);
      expect(h.playing[0]?.signal.aborted).toBe(true);
      h.conversation.humanSpeech(false);
      h.conversation.humanText('Hold on, the crash is only on Android.');
      await h.flushTimes(5);
      const next = await h.waitForCall(1);
      const request = next.messages.map((message) => message.content).join('\n');
      // Only the sentence the room fully heard is remembered; the unheard second one is not.
      expect(request).not.toContain('We have a crash.');
      expect(request).toContain('Hold on, the crash is only on Android.');
      h.conversation.close();
    });

    it('ignores the AI echoing back through the microphone, and carries on speaking', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { askDelayMs: 600_000 } });
      h.conversation.announce('Sam', 'The build is red and we have a crash on Android.');
      await h.flushTimes(5);
      const callsBefore = h.calls.length;
      h.conversation.humanText('the build is red and we have a crash on Android');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.playing[0]?.signal.aborted).toBe(false);
      expect(h.calls).toHaveLength(callsBefore);
      expect(h.logs.some((line) => line.includes('echo'))).toBe(true);
      h.conversation.close();
    });

    it('refuses unexplained text while the AI talks, but accepts it with a voice behind it', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { bargeInMs: 0, askDelayMs: 600_000 } });
      h.conversation.announce('Sam', 'Build is red.');
      await h.flushTimes(5);
      h.conversation.humanText('what about the budget');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.playing[0]?.signal.aborted).toBe(false);
      expect(h.logs.some((line) => line.includes('no-voice'))).toBe(true);

      h.conversation.humanSpeech(true);
      expect(h.playing[0]?.signal.aborted).toBe(true);
      h.conversation.close();
    });

    it('clears cutOff when real speech arrives after a barge-in so humanNothing cannot trigger a stale resume', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { bargeInMs: 0, askDelayMs: 600_000 } });
      h.conversation.announce('Sam', 'Here is the first sentence. Here is the second sentence.');
      await h.flushTimes(5);
      expect(h.playing).toHaveLength(1);
      h.conversation.humanSpeech(true);
      await vi.advanceTimersByTimeAsync(1_500);
      h.conversation.humanSpeech(false);
      h.conversation.humanText('Hold on, let us check the cost.');
      h.conversation.humanNothing();
      await vi.advanceTimersByTimeAsync(2_000);
      const lastCallMessages = JSON.stringify(h.calls.at(-1)?.messages ?? []);
      expect(lastCallMessages).toContain('Hold on, let us check the cost.');
      expect(lastCallMessages).not.toContain('made a sound');
      h.conversation.close();
    });
  });

  describe('held replies and model failures', () => {
    it('carries on held lines when the person cuts in but says nothing, and answers words instead', async () => {
      const h = harness({ scenarioUsed: twoNpcScenario, optionOverrides: { bargeInMs: 0, askDelayMs: 600_000 } });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: Morning. Ready when you are.`);
      call.end();
      await h.flushTimes(5);
      expect(h.playing.map((entry) => entry.text)).toEqual(['Morning.']);

      h.conversation.humanSpeech(true);
      h.conversation.humanSpeech(false);
      h.conversation.humanNothing();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.calls).toHaveLength(1);
      expect(h.logs.some((line) => line.includes('cut-in had no words: carrying on held lines'))).toBe(true);
      await h.finishPlaying();

      h.conversation.humanTyped('Actually, wait.');
      await h.flushTimes(5);
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]?.messages.at(-1)?.content).toContain('Actually, wait.');
      expect(h.calls[1]?.messages.at(-1)?.content).not.toContain('made a sound');
      h.conversation.close();
    });

    it('does not go silent when the model stream fails while a turn is held', async () => {
      const h = harness({
        scenarioUsed: twoNpcScenario,
        optionOverrides: { silencePromptMs: 1_000, silenceNudgeLeadMs: 999, bargeInMs: 0 },
      });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const seed = await h.waitForCall(0);
      seed.push(`${h.expectedSpeaker(seed)}: What do we tell people at the counter?`);
      seed.end();
      await h.flushTimes(5);
      await h.finishPlaying();

      await vi.advanceTimersByTimeAsync(1);
      const nudge = await h.waitForCallMatching((call) =>
        call.messages.some((message) => message.content.includes(CHECK_IN_NOTE)));
      nudge.push('Sam: The build is red.\n');
      await vi.advanceTimersByTimeAsync(1_100);
      await h.flushTimes(3);
      expect(h.playing.at(-1)?.text, h.logs.join('\n')).toBe('Visitor, the build is red.');

      h.conversation.humanSpeech(true);
      expect(h.playing.at(-1)?.signal.aborted).toBe(true);
      nudge.fail(new Error('model died'));
      await h.flushTimes(5);
      h.conversation.humanSpeech(false);
      h.conversation.humanNothing();
      await vi.advanceTimersByTimeAsync(400);
      expect(h.calls.length).toBeGreaterThan(1);
      const retry = h.calls.at(-1)!;
      retry.push('Sam: The build is red, and we have a crash.');
      retry.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes('we have a crash'))).toBe(true);
      h.conversation.close();
    });

    it('retries a failed sentence once and plays it when the second try works', async () => {
      let attempts = 0;
      const h = harness({
        synthesize: async (utterance) => {
          if (utterance.text === 'One line.') {
            attempts += 1;
            if (attempts === 1) throw new Error('voice blip');
          }
          return utterance;
        },
      });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: One line.`);
      call.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(attempts).toBe(2);
      expect(h.transcript).toContainEqual([h.transcript.at(-1)![0], 'One line.']);
      expect(h.transcriptOptions.filter(([, , options]) => options?.textOnly === true)).toHaveLength(0);
      expect(h.logs).toContainEqual(expect.stringMatching(/^\[tts\] retry .*: voice blip$/));
      h.conversation.close();
    });

    it('shows a whole failed reply as text, then keeps the meeting moving', async () => {
      const h = harness({
        synthesize: async (utterance) => {
          if (utterance.text.includes('part.')) throw new Error('voice down');
          return utterance;
        },
      });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: First part. Second part.`);
      call.end();
      await h.flushTimes(5);
      await vi.advanceTimersByTimeAsync(5_000);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line === 'First part.')).toBe(true);
      expect(h.transcript.some(([, line]) => line === 'Second part.')).toBe(true);
      expect(h.transcriptOptions.filter(([, , options]) => options?.textOnly === true)).toHaveLength(2);
      expect(h.logs).toContainEqual(expect.stringMatching(/^\[tts\] retry .*: voice down$/));
      expect(h.logs).toContainEqual(expect.stringMatching(/^\[tts\] shown as text: /));
      expect(h.logs.some((line) => line.includes('lost the whole reply'))).toBe(false);
      h.conversation.close();
    });

    it('does not retry synthesis when the turn was aborted', async () => {
      let attempts = 0;
      const h = harness({
        synthesize: async () => {
          attempts += 1;
          h.conversation.stop();
          throw new Error('aborted');
        },
      });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const call = await h.waitForCall(0);
      call.push(`${h.expectedSpeaker(call)}: One line.`);
      call.end();
      await h.flushTimes(5);
      expect(attempts).toBe(1);
      expect(h.transcriptOptions.filter(([, , options]) => options?.textOnly === true)).toHaveLength(0);
      h.conversation.close();
    });

    it('keeps the meeting moving after a reply dies mid-stream', async () => {
      const h = harness({ optionOverrides: { silencePromptMs: 1_000 } });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const first = await h.waitForCall(0);
      first.push(`${h.expectedSpeaker(first)}: First part.`);
      first.fail(new Error('stream stalled'));
      await h.flushTimes(5);
      const retry = await h.waitForCall(1);
      retry.push(`${h.expectedSpeaker(retry)}: Are you still there?`);
      retry.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes('Are you still there?'))).toBe(true);
      expect(h.logs).toContainEqual(expect.stringContaining('retrying once with a fresh request'));
      h.conversation.close();
    });

    it('keeps what was said before a model failure part-way through', async () => {
      const h = harness({ optionOverrides: { silencePromptMs: 1_000 } });
      h.conversation.humanTyped('Hello team.');
      await h.flushTimes(5);
      const first = await h.waitForCall(0);
      first.push(`${h.expectedSpeaker(first)}: First part. Seco`);
      first.fail(new Error('boom'));
      await h.flushTimes(5);
      const retry = await h.waitForCall(1);
      retry.push(`${h.expectedSpeaker(retry)}: First part. Second part.`);
      retry.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line === 'First part.')).toBe(true);
      expect(h.transcript.some(([, line]) => line === 'Second part.')).toBe(true);
      expect(h.states.at(-1)?.kind).not.toBe('error');
      h.conversation.close();
    });

    it('drops the failed-request recovery when the person says something new during the retry', async () => {
      const h = harness({ optionOverrides: { silencePromptMs: 1_000 } });
      h.conversation.humanTyped('Can we move the launch to Friday?');
      await h.flushTimes(5);
      const first = await h.waitForCall(0);
      first.fail(new Error('LLM request failed: timed out after 20000 ms'));
      await h.flushTimes(5);
      const retry = await h.waitForCall(1);
      h.conversation.humanTyped('Actually, second question.');
      await h.flushTimes(5);
      expect(retry.signal.aborted).toBe(true);
      const call = await h.waitForCall(2);
      call.push(`${h.expectedSpeaker(call)}: Friday works.`);
      call.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      expect(h.transcript.some(([, line]) => line.includes('Sorry, give me a second'))).toBe(false);
      expect(h.calls[2]?.messages.at(-1)?.content).toContain('Actually, second question.');
      h.conversation.close();
    });
  });

  describe('host cues and the final closure', () => {
    it('drops a cue that finds the room busy for too long, and ignores unknown speakers', async () => {
      const h = harness();
      h.conversation.humanSpeech(true);
      h.conversation.announce('Sam', 'Late news.', 2_000);
      h.conversation.announce('Nobody', 'Hello.');
      await vi.advanceTimersByTimeAsync(3_000);
      h.conversation.humanSpeech(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.playing).toHaveLength(0);
      expect(h.logs.join('\n')).toContain('dropped Sam');
      h.conversation.close();
    });

    it('freezes the conversation after announceClosing so trailing speech cannot restart it', async () => {
      const h = harness();
      h.conversation.announceClosing('Sam', 'That concludes our meeting.');
      await h.flushTimes(5);
      await h.finishPlaying();
      await h.conversation.settled();
      h.conversation.humanTyped('Hello, anyone still here?');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.calls).toHaveLength(0);
      h.conversation.close();
    });
  });

  describe('a hand-over between colleagues', () => {
    it('does not chain forever, and the person talking cancels it', async () => {
      const h = harness({ reader: () => reading({ kind: 'idea' }), optionOverrides: { bargeInMs: 0 } });
      h.conversation.humanTyped('What is next?');
      await h.flushTimes(5);
      const first = await h.waitForCall(0);
      first.push(`${h.expectedSpeaker(first)}: Bao, what is your call on the till?`);
      first.end();
      await h.flushTimes(5);
      await h.finishPlaying();
      const second = await h.waitForCall(1);
      h.conversation.humanSpeech(true);
      await h.flushTimes(5);
      expect(second.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      await h.finishPlaying();
      // The chain does not continue: the person has the floor, and Bao never speaks.
      expect(h.transcript.some(([speaker]) => speaker === 'Bao'), h.logs.join('\n')).toBe(false);
      h.conversation.close();
    });
  });

  describe('a failed follow-up leaves Lock open', () => {
    it('reopens Lock and logs an error when follow-up creation fails', async () => {
      const h = harness();
      h.settleTopic.mockRejectedValueOnce(new Error('HTTP 503'));
      await h.settleWith('We will use the window bar from 8.');
      await h.flushTimes(5);
      expect(h.states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });
      expect(h.logs.some((line) => line.includes('ERROR') && line.includes('HTTP 503'))).toBe(true);
      await h.settleWith('We will use the window bar from 8.');
      await h.flushTimes(5);
      expect(h.settleTopic).toHaveBeenCalledTimes(2);
      h.conversation.close();
    });
  });
});
