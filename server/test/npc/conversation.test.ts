import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/services/llm';
import { claimsStepGivenToOther, NpcConversation, type ConversationOptions, type NpcPorts, type NpcUiState } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { readGuestLine, type GuestReaderInput, type GuestReading } from '../../src/npc/guestReader';
import { testScenario } from '../fixtures/scenario';

/** Say one line as the guest, through the same speech path the recogniser uses. */
function speak(conversation: { humanSpeech(talking: boolean): void; humanText(text: string): string | undefined }, text: string): void {
  conversation.humanSpeech(true);
  conversation.humanSpeech(false);
  conversation.humanText(text);
}

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

/** A test-only stand-in for the reader: the real one is a model call, and these tests care about routing. */
function fakeReading(input: GuestReaderInput): GuestReading {
  const text = input.line.toLowerCase();
  const open = input.openQuestion !== undefined;
  const addressee = input.colleagues.find((colleague) =>
    new RegExp(`\\b${colleague.name}\\b`, 'i').test(input.line))?.name;
  const facts = input.colleagues.flatMap((colleague) => colleague.facts);
  const catches = input.colleagues.flatMap((colleague) => colleague.catches);
  const relevantFactIds = facts.filter((fact) => {
    const words = fact.text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    return words.some((word) => text.includes(word) && !['that', 'this', 'with', 'from', 'before', 'opening', 'needs'].includes(word));
  }).map((fact) => fact.id);
  const relevantCatchIds = catches.filter((entry) =>
    entry.text.toLowerCase().split(/\W+/).some((word) => word.length >= 5 && text.includes(word))).map((entry) => entry.id);
  const covered = (evidence: string) => ({ covered: true, evidence });
  const off = { covered: false } as const;
  const yes = /^(yes|yeah|yep|ok|okay|sure|do it|that works|sounds good)\b/.test(text);
  const unsure = /\b(not sure|idk|i don't know|don't know|what do you mean|don't understand)\b/.test(text);
  const park = /\b(leave it|later|come back to)\b/.test(text);
  const noise = /\b(testing|can you hear|mic|hello\?)\b/.test(text);
  const ideaQuestion = /^(?:let us|let's|what if|shall we|why not|how about|use |call |i think)/i.test(input.line.trim());
  const kind = noise ? 'noise' : unsure ? 'unsure' : park ? 'park' : yes ? 'agree'
    : ideaQuestion ? 'idea' : /\?$/.test(input.line) ? 'question' : 'idea';
  const routedAddressee = addressee ?? (kind === 'idea' && catches.length === 0 ? 'Ada' : undefined);
  return {
    kind,
    ...(routedAddressee === undefined ? {} : { addressee: routedAddressee }),
    answersOpenQuestion: yes && open,
    relevantFactIds,
    relevantCatchIds,
    readiness: {
      action: yes || relevantFactIds.length > 0 ? covered(input.line) : off,
      catchAddressed: relevantCatchIds.length > 0 && yes ? covered(input.line) : off,
      practical: /\b(from|at|before|by)\s+\d/.test(text) ? covered(input.line) : off,
    },
  };
}

function harness(
  scenarioUsed: typeof scenario = scenario,
  bargeInMs = 0,
  reader: (input: GuestReaderInput) => GuestReading | Promise<GuestReading> = fakeReading,
  optionOverrides: Partial<ConversationOptions> = {},
) {
  const calls: LlmCall[] = [];
  const playing: Playing[] = [];
  const states: NpcUiState[] = [];
  const transcript: Array<[string, string]> = [];
  const transcriptOptions: Array<[string, string, { textOnly?: boolean; catchId?: string; lineId?: string } | undefined]> = [];
  const transcriptUpdates: Array<[string, string, { lineId: string; cut: boolean }]> = [];
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
      emitTranscript: (speaker, text, options) => {
        transcript.push([speaker, text]);
        transcriptOptions.push([speaker, text, options]);
      },
      emitTranscriptUpdate: (speaker, text, options) => {
        transcriptUpdates.push([speaker, text, options]);
      },
      emitState: (state) => states.push(state),
      log: (message) => logs.push(message),
  };
  const conversation = new NpcConversation<Utterance>(ports, { scenario: scenarioUsed, bargeInMs, responseDelayMs: 900, speakerGapMs: 0, sentenceGapMs: 0,
    readGuestLine: async (input) => reader(input),
    gateStream: (request) => (async function* () {
      const lower = request.call.length === 0 ? request.call : `${request.call[0]!.toLowerCase()}${request.call.slice(1)}`;
      yield request.purpose === 'readback'
        ? `${request.speaker}: So it's ${lower}. That's the call?`
        : `${request.speaker}: How about we ${lower}?`;
    })(),
    ...optionOverrides });
  conversation.setHuman({ name: 'Josh', role: 'operations_director', transcriptName: 'Ada (Chef)' });

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  /** The person says something and stops; the AI waits out the response delay and starts. */
  async function say(text: string): Promise<void> {
    conversation.humanSpeech(true);
    conversation.humanSpeech(false);
    conversation.humanText(text);
    await vi.advanceTimersByTimeAsync(900);
  }
  return { conversation, ports, calls, playing, states, transcript, transcriptOptions, transcriptUpdates, logs, flush, say };
}

describe('one-speaker replies to the guest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type H = ReturnType<typeof harness>;

  async function waitForCall(h: H, index: number): Promise<LlmCall> {
    for (let i = 0; i < 80 && h.calls.length <= index; i += 1) await h.flush();
    if (h.calls.length <= index) throw new Error(`expected call ${index}, got ${h.calls.length}`);
    return h.calls[index]!;
  }

  async function finishPlaying(h: H): Promise<void> {
    for (let i = 0; i < 80; i += 1) {
      await h.flush();
      const next = h.playing.find((entry) => !entry.finished);
      if (next === undefined) return;
      next.finish();
      await h.flush();
    }
    throw new Error('playback did not finish');
  }

  async function reply(h: H, text: string): Promise<void> {
    const call = h.calls.at(-1);
    if (call === undefined) throw new Error('no call to answer');
    call.push(text);
    call.end();
    await h.flush();
    await finishPlaying(h);
  }

  const catchScenario = {
    ...scenario,
    agenda: [
      {
        title: 'Prep',
        minutes: 5,
        canWait: false,
        deadline: 'before service',
        ownerRole: 'chef',
        decision: 'how do we cover prep?',
        discussion: {
          openingViews: [],
          tradeOffs: [
            { attendee: 'Bao', role: 'cashier', idea: 'calling Auntie Mary in', tradeOff: 'Calling Auntie Mary in means double pay.', question: 'Who covers it?' },
          ],
        },
      },
    ],
  };

  const withDirections = (directions: string[]) => ({
    ...scenario,
    agenda: scenario.agenda.map((item) => ({ ...item, directions })),
  });

  const readyFor = (evidence: string) => ({
    kind: 'answer' as const,
    answersOpenQuestion: false,
    relevantFactIds: [],
    relevantCatchIds: [],
    readiness: {
      action: { covered: true, evidence },
      catchAddressed: { covered: false },
      practical: { covered: false },
    },
  });

  const nothingCovered = {
    kind: 'answer' as const,
    answersOpenQuestion: false,
    relevantFactIds: [],
    relevantCatchIds: [],
    readiness: {
      action: { covered: false },
      catchAddressed: { covered: false },
      practical: { covered: false },
    },
  };

  const withColleagueHost = (base: typeof scenario) => ({
    ...base,
    roles: [...base.roles, { id: 'host', label: 'Host' }],
    attendees: [...base.attendees, { name: 'Sam', role: 'host', displayName: 'Sam (Host)' }],
    npcs: [
      ...base.npcs,
      { attendee: 'Sam', voice: 'v0', role: 'host' as const, personality: 'Calm', agenda: 'Keep time', concerns: [] },
    ],
  });

  it('answers a substantive guest line with one planned speaker, then waits for the guest', async () => {
    const h = harness(withColleagueHost(scenario), 0);
    await h.say('Let us call Auntie Mary in.');

    expect(h.calls).toHaveLength(1);
    const request = String(h.calls[0]?.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Ada');
    expect(request).toContain('Answer the point directly');
    expect(request).not.toContain('ONE colleague answers');
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] Ada (answer) asked; responding to "Let us call Auntie Mary in.'));

    await reply(h, 'Ada: Who would cover the counter?');
    expect(h.transcript).toContainEqual(['Ada', 'Who would cover the counter?']);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    h.conversation.close();
  });

  it('lets the colleague the guest names answer first, one call per speaker', async () => {
    const h = harness(scenario, 0);
    await h.say('Bao, what about the till?');

    expect(h.calls).toHaveLength(1);
    const request = String(h.calls[0]?.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    expect(request).toContain('Answer the point directly');
    await reply(h, 'Bao: I can cover the till before opening.');
    expect(h.transcript).toContainEqual(['Bao', 'I can cover the till before opening.']);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    h.conversation.close();
  });

  it('raises the first idea catch with a second planned speaker, then waits', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');

    const first = await waitForCall(h, 0);
    const firstRequest = String(first.messages.map((message) => message.content).join('\n'));
    expect(firstRequest).toContain('You are Ada');
    await reply(h, 'Ada: That could work.');

    const second = await waitForCall(h, 1);
    const secondRequest = String(second.messages.map((message) => message.content).join('\n'));
    expect(secondRequest).toContain('You are Bao');
    expect(secondRequest).toContain('Raise this real catch');
    expect(secondRequest).toContain('Calling Auntie Mary in means double pay.');
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] Bao (catch) asked; responding to "That could work.'));
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');

    await h.flush();
    expect(h.transcript).toContainEqual(['Bao', 'Calling her in means double pay for her rest day.']);
    expect(h.calls).toHaveLength(2);
    h.conversation.close();
  });

  it('marks the heard catch line with the catch id the planner raised', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');
    await waitForCall(h, 0);
    await reply(h, 'Ada: That could work.');
    await waitForCall(h, 1);
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');

    expect(h.transcriptOptions).toContainEqual([
      'Bao',
      'Calling her in means double pay for her rest day.',
      expect.objectContaining({ catchId: '0:catch:0' }),
    ]);
    h.conversation.close();
  });

  it('answers a terse yes instead of treating it as filler', async () => {
    const h = harness(withColleagueHost(scenario), 0, () => ({
      kind: 'agree',
      addressee: 'Ada',
      answersOpenQuestion: true,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));
    await h.say('Yes.');
    expect(h.calls).toHaveLength(1);
    const request = String(h.calls[0]?.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Ada');
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] Ada (answer)'));
    h.conversation.close();
  });

  it('discards the prefetched second speaker when the guest speaks again', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work.');
    first.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);
    const prefetched = await waitForCall(h, 1);

    speak(h.conversation, 'Wait, what about the till?');
    await h.flush();
    expect(prefetched.signal.aborted).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] cancelled: the guest spoke'));
    expect(h.transcript.some(([speaker]) => speaker === 'Bao')).toBe(false);
    h.conversation.close();
  });

  it('rejects a prefetched reply whole before any of it plays, then retries fresh', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work.');
    first.end();
    await h.flush();
    const prefetched = await waitForCall(h, 1);
    prefetched.push('Ada: We should not do that.');
    prefetched.end();
    await finishPlaying(h);

    expect(h.transcript.some(([, text]) => text === 'We should not do that.')).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] Bao (catch) rejected: another speaker'));
    const retry = await waitForCall(h, 2);
    const request = String(retry.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');
    expect(h.transcript).toContainEqual(['Bao', 'Calling her in means double pay for her rest day.']);
    h.conversation.close();
  });

  it('ignores the model settled control on the new path when the practical slot is open', async () => {
    const h = harness(scenario, 0, () => ({
      kind: 'question',
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'Do the double pay plan' },
        catchAddressed: { covered: true, evidence: 'Do the double pay plan' },
        practical: { covered: false },
      },
    }));
    h.conversation.setHuman({ name: 'Josh', role: 'chef', transcriptName: 'Ada (Chef)' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Do the double pay plan.');
    await reply(h, 'KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"}}\nAda: Fine, we will pay the double pay.');

    expect(settleTopic).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.stringContaining('[control] ignored model settle; readiness decides'));
    expect(h.transcript).toContainEqual(['Ada', 'Fine, we will pay the double pay.']);
    h.conversation.close();
  });

  it('never speaks or transcribes a control line whose header uses a space', async () => {
    const h = harness(withColleagueHost(scenario), 0);
    await h.say('Do the double pay plan.');
    await reply(h, 'KAKI CONTROL {"state":"open"}\nAda: Fine, we will pay the double pay.');

    expect(h.transcript).toContainEqual(['Ada', 'Fine, we will pay the double pay.']);
    expect(h.transcript.some(([, text]) => /KAKI/i.test(text))).toBe(false);
    h.conversation.close();
  });

  it('rejects an answer that does not carry its promised fact, then retries', async () => {
    const factScenario = {
      ...scenario,
      agenda: [
        {
          title: 'Prep',
          minutes: 5,
          canWait: false,
          deadline: 'before service',
          ownerRole: 'chef',
          decision: 'how do we cover prep?',
          briefing: [
            { text: 'The till needs a new login before opening.', knownBy: [{ attendee: 'Bao', why: 'you run the tills' }] },
          ],
        },
      ],
    };
    const h = harness(factScenario, 0);
    await h.say('What about the till login?');

    const first = await waitForCall(h, 0);
    const request = String(first.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    expect(request).toContain('The till needs a new login before opening.');
    first.push('Bao: We can sort that out.');
    first.end();
    await h.flush();
    expect(h.transcript.some(([, text]) => text === 'We can sort that out.')).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('did not carry the fact'));

    const retry = await waitForCall(h, 1);
    expect(String(retry.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    await reply(h, 'Bao: The till needs a new login before opening.');
    expect(h.transcript).toContainEqual(['Bao', 'The till needs a new login before opening.']);
    h.conversation.close();
  });

  it('answers a question about a fact the room already heard without demanding that fact, and never recovers', async () => {
    const factScenario = {
      ...scenario,
      agenda: [
        {
          title: 'Prep',
          minutes: 5,
          canWait: false,
          deadline: 'before service',
          ownerRole: 'chef',
          decision: 'how do we cover prep?',
          briefing: [
            { text: 'The till needs a new login before opening.', knownBy: [{ attendee: 'Bao', why: 'you run the tills' }] },
          ],
        },
      ],
    };
    const h = harness(factScenario, 0, () => ({
      kind: 'question',
      answersOpenQuestion: false,
      relevantFactIds: ['0:0'],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }));

    await h.say('What about the till login?');
    const first = await waitForCall(h, 0);
    expect(String(first.messages.map((message) => message.content).join('\n'))).toContain('You may tell only this');
    await reply(h, 'Bao: The till needs a new login before opening.');
    expect(h.transcript).toContainEqual(['Bao', 'The till needs a new login before opening.']);

    await h.say('And has anyone said what she actually ate yesterday?');
    const second = await waitForCall(h, 1);
    const secondRequest = String(second.messages.map((message) => message.content).join('\n'));
    expect(secondRequest).not.toContain('You may tell only this');
    expect(secondRequest).toContain("say plainly that you don't know");
    const speaker = /You are (\w+)/.exec(secondRequest)?.[1];
    expect(speaker).toBeDefined();
    await reply(h, `${speaker}: I don't know what she ate.`);

    expect(h.transcript).toContainEqual([speaker!, "I don't know what she ate."]);
    expect(h.transcript.some(([, text]) => text === 'Sorry, give me a second on that.')).toBe(false);
    expect(h.calls).toHaveLength(2);
    h.conversation.close();
  });

  it('resumes a stopped reply from the last line the room heard', async () => {
    const h = harness(scenario, 0);
    await h.say('Let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: Who would cover the counter?');
    first.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);

    h.conversation.stop();
    await h.flush();
    const before = h.calls.length;
    h.conversation.resumeFromPause();
    await h.flush();

    const resumed = await waitForCall(h, before);
    expect(String(resumed.messages.map((message) => message.content).join('\n'))).toContain('You are Ada');
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] resuming'));
    await reply(h, 'Ada: Who would cover the counter?');
    expect(h.transcript).toContainEqual(['Ada', 'Who would cover the counter?']);
    h.conversation.close();
  });
  it('resumes a stopped second speaker after the first one was fully heard', async () => {
    const h = harness(catchScenario, 0);
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work.');
    first.end();
    await h.flush();
    await finishPlaying(h);

    const second = await waitForCall(h, 1);
    second.push('Bao: Calling her in means double pay for her rest day.');
    second.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);

    h.conversation.stop();
    await h.flush();
    const before = h.calls.length;
    h.conversation.resumeFromPause();
    await h.flush();

    const resumed = await waitForCall(h, before);
    expect(String(resumed.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] resuming'));
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');
    expect(h.transcript).toContainEqual(['Bao', 'Calling her in means double pay for her rest day.']);
    h.conversation.close();
  });

  it('rejects a catch reply that does not carry the catch, then retries with a paraphrase', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');
    await reply(h, 'Ada: That could work.');

    const second = await waitForCall(h, 1);
    expect(String(second.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    second.push('Bao: That could work for me too.');
    second.end();
    await h.flush();
    expect(h.transcript.some(([, text]) => text === 'That could work for me too.')).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('did not carry the catch'));

    const retry = await waitForCall(h, 2);
    expect(String(retry.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    retry.push('Bao: We would have to pay Auntie Mary double for her rest day.');
    retry.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Bao', 'We would have to pay Auntie Mary double for her rest day.']);
    await h.flush();
    expect(h.calls).toHaveLength(3);
    h.conversation.close();
  });

  it('counts a two-sentence reply as one speaker when choosing the second colleague', async () => {
    const h = harness(withColleagueHost(catchScenario), 0);
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work. I will check the rota.');
    first.end();
    await h.flush();

    const second = await waitForCall(h, 1);
    const request = String(second.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    expect(request).toContain('Raise this real catch');
    expect(request).toContain('Calling Auntie Mary in means double pay.');
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');

    expect(h.transcript.filter(([speaker]) => speaker === 'Ada')).toEqual([
      ['Ada', 'That could work.'],
      ['Ada', 'I will check the rota.'],
    ]);
    expect(h.calls).toHaveLength(2);
    h.conversation.close();
  });

  it('stops a third AI speaker after the second responder asks them a question', async () => {
    const withCai = {
      ...scenario,
      npcs: [...scenario.npcs,
        { attendee: 'Cai', voice: 'v3', personality: 'Quiet', agenda: 'Open on time', concerns: [] }],
      attendees: [...scenario.attendees, { name: 'Cai', role: 'cashier', displayName: 'Cai' }],
    };
    const h = harness(withCai, 0);
    await h.say('Ada, let us check the till.');
    await reply(h, 'Ada: Bao, can you check the till? I will watch the counter.');

    const second = await waitForCall(h, 1);
    expect(String(second.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    second.push('Bao: The till is fine. Cai, can you cover drinks?');
    second.end();
    await h.flush();
    await finishPlaying(h);

    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.transcript.some(([speaker]) => speaker === 'Cai')).toBe(false);
    h.conversation.close();
  });

  it('answers the guest point after a rejoin welcome when the reply was unfinished', async () => {
    const h = harness(catchScenario, 0);
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    expect(String(first.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    first.push('Bao: Calling her in means double pay for her rest day.');
    first.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);

    h.conversation.stop();
    await h.flush();
    const before = h.calls.length;
    h.conversation.resumeAfterRejoin('Bao', 'Welcome back, Josh.');
    await h.flush();
    expect(h.playing.some((entry) => entry.text === 'Welcome back, Josh.')).toBe(true);
    await finishPlaying(h);

    const resumed = await waitForCall(h, before);
    const request = String(resumed.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('The guest just said');
    expect(request).toContain('Ada, let us call Auntie Mary in.');
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');
    expect(h.transcript.filter(([, text]) => text === 'Calling her in means double pay for her rest day.')).toHaveLength(2);
    expect(h.transcript.filter(([, text]) => text === 'Welcome back, Josh.')).toHaveLength(1);
    await h.flush();
    expect(h.calls).toHaveLength(before + 1);
    h.conversation.close();
  });

  it('treats guest lines gathered for one response as one turn and raises the first idea catch', async () => {
    const h = harness(catchScenario, 0);
    h.conversation.humanSpeech(true);
    h.conversation.humanText('Let us call Auntie Mary in.');
    h.conversation.humanText('What will that cost us?');
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);

    const first = await waitForCall(h, 0);
    const request = String(first.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    expect(request).toContain('Raise this real catch');
    expect(request).toContain('Let us call Auntie Mary in.');
    expect(request).toContain('What will that cost us?');
    await reply(h, 'Bao: It means double pay for Auntie Mary.');
    expect(h.transcript).toContainEqual(['Bao', 'It means double pay for Auntie Mary.']);
    h.conversation.close();
  });

  it('nudges once after read-back silence, then commits the read-back call', async () => {
    const ready = {
      kind: 'answer' as const,
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'Old price only on the small cup' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(scenario, 0,
      () => ready,
      { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Old price only on the small cup.');
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Ada', "So it's old price only on the small cup."]);
    expect(h.transcript).toContainEqual(['Ada', "That's the call?"]);

    // Nobody answers: one fixed nudge, never a second read-back.
    for (let i = 0; i < 80 && !h.transcript.some(([, text]) => text === 'Still with me?'); i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    expect(h.transcript.filter(([, text]) => text === 'Still with me?')).toHaveLength(1);
    expect(h.transcript.filter(([, text]) => text === "So it's old price only on the small cup.")).toHaveLength(1);
    expect(settleTopic).not.toHaveBeenCalled();

    // Still nobody answers: the call Sam read back is committed and the topic moves on.
    for (let i = 0; i < 80 && settleTopic.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(settleTopic).toHaveBeenCalledWith(
      expect.objectContaining({ decisionSource: 'Old price only on the small cup' }), false);
    expect(h.logs).toContainEqual('[confirm] no answer after nudge; committing the read-back call');
    expect(h.transcript.filter(([, text]) => text === 'Still with me?')).toHaveLength(1);
    h.conversation.close();
  });

  it('caps the read-back after two asks and offers one call instead of a third', async () => {
    const h = harness(withDirections(['Signs only this morning.']), 0,
      (input) => ({ ...readyFor(input.line), answersOpenQuestion: true }),
      { silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    const readBacks = (): number => h.logs.filter((line) => line.startsWith('[confirm] read-back:')).length;

    await h.say('Counter duty from eight.');
    await finishPlaying(h);
    expect(readBacks()).toBe(1);

    await h.say('Change it: nine o clock.');
    await finishPlaying(h);
    expect(readBacks()).toBe(2);

    await h.say('Add a cup deal.');
    await finishPlaying(h);
    expect(readBacks()).toBe(2);
    expect(h.logs).toContainEqual(expect.stringContaining('2 read-backs have already been heard'));
    expect(h.transcript.some(([, text]) => text.startsWith('How about we'))).toBe(true);
    h.conversation.close();
  });

  it('waits the full silence after a read-back before nudging, not the write-ahead window', async () => {
    const h = harness(scenario, 0, () => readyFor('Old price only on the small cup'), {
      silencePromptMs: 22_000,
      silenceNudgeLeadMs: 15_000,
      topicTimeBudgetMs: 600_000,
    });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Old price only on the small cup.');
    await finishPlaying(h);
    expect(h.transcript.some(([, text]) => text.endsWith("That's the call?"))).toBe(true);

    const quietAt = Date.now();
    await vi.advanceTimersByTimeAsync(21_999);
    await finishPlaying(h);
    expect(h.transcript.some(([, text]) => text === 'Still with me?')).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await finishPlaying(h);
    expect(h.transcript.some(([, text]) => text === 'Still with me?')).toBe(true);
    expect(Date.now() - quietAt).toBeGreaterThanOrEqual(22_000);
    h.conversation.close();
  });

  it('does not speak a held silence cue after the room has moved to another topic', async () => {
    const twoItems = {
      ...scenario,
      agenda: [
        scenario.agenda[0]!,
        { title: 'Service', minutes: 5, canWait: true, deadline: 'before doors open at 8', ownerRole: 'cashier' },
      ],
    };
    const h = harness(twoItems);
    const spoken: string[] = [];
    const hold = h.conversation as unknown as {
      speakAfterSilenceWait(notBefore: number, speak: () => void): void;
      reopenedTitle: string | undefined;
    };
    hold.speakAfterSilenceWait(Date.now() + 100, () => spoken.push('stale cue'));
    // The item changes while the cue is still held; the timer itself must notice, not only the paths that
    // remember to clear the silence timer.
    hold.reopenedTitle = 'Service';
    await vi.advanceTimersByTimeAsync(150);
    expect(spoken).toEqual([]);
    h.conversation.close();
  });

  it('asks the read-back when a reply chain ends with readiness met, instead of a free model check-in', async () => {
    const factScenario = {
      ...scenario,
      agenda: [
        {
          title: 'Prep',
          minutes: 5,
          canWait: false,
          deadline: 'before service',
          ownerRole: 'chef',
          decision: 'how do we cover prep?',
          briefing: [
            { text: 'The till needs a new login before opening.', knownBy: [{ attendee: 'Bao', why: 'you run the tills' }] },
          ],
        },
      ],
    };
    const readyQuestion = {
      kind: 'question' as const,
      answersOpenQuestion: false,
      relevantFactIds: ['0:0'],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'We use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(factScenario, 0, () => readyQuestion,
      { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });

    await h.say('Bao, can the till take a new login? We use the kiosk for orders.');
    const answer = await waitForCall(h, 0);
    expect(String(answer.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    await reply(h, 'Bao: The till needs a new login before opening.');
    await h.flush();

    expect(h.logs).toContainEqual('[confirm] the reply chain has ended with readiness met; asking for the read-back');
    expect(h.transcript.some(([, text]) => text.includes("That's the call?"))).toBe(true);
    expect(h.calls).toHaveLength(1);
    h.conversation.close();
  });

  it('still nudges and commits the read-back when the guest stays silent after the reply chain', async () => {
    const factScenario = {
      ...scenario,
      agenda: [
        {
          title: 'Prep',
          minutes: 5,
          canWait: false,
          deadline: 'before service',
          ownerRole: 'chef',
          decision: 'how do we cover prep?',
          briefing: [
            { text: 'The till needs a new login before opening.', knownBy: [{ attendee: 'Bao', why: 'you run the tills' }] },
          ],
        },
      ],
    };
    const readyQuestion = {
      kind: 'question' as const,
      answersOpenQuestion: false,
      relevantFactIds: ['0:0'],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'We use the kiosk for orders' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(factScenario, 0, () => readyQuestion,
      { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Bao, can the till take a new login? We use the kiosk for orders.');
    const answer = await waitForCall(h, 0);
    expect(String(answer.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    await reply(h, 'Bao: The till needs a new login before opening.');
    await finishPlaying(h);
    expect(h.transcript.filter(([, text]) => text.includes("That's the call?"))).toHaveLength(1);

    // Nobody answers the read-back: one fixed nudge.
    for (let i = 0; i < 80 && !h.transcript.some(([, text]) => text === 'Still with me?'); i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    expect(h.transcript.filter(([, text]) => text === 'Still with me?')).toHaveLength(1);
    expect(settleTopic).not.toHaveBeenCalled();

    // Still nobody answers: the read-back call is committed and the topic moves on.
    for (let i = 0; i < 80 && settleTopic.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(settleTopic).toHaveBeenCalledWith(
      expect.objectContaining({ decisionSource: 'We use the kiosk for orders' }), false);
    expect(h.transcript.filter(([, text]) => text.includes("That's the call?"))).toHaveLength(1);
    h.conversation.close();
  });

  it('does not speak a stale read-back after the guest speaks during the gate write', async () => {
    let releaseGate: (() => void) | undefined;
    let gateCalls = 0;
    const h = harness(scenario, 0, () => readyFor('Old price only on the small cup'), {
      gateStream: (request) => (async function* () {
        gateCalls += 1;
        if (gateCalls === 1) await new Promise<void>((resolve) => { releaseGate = resolve; });
        yield `${request.speaker}: So it's old price only on the small cup. That's the call?`;
      })(),
    });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Old price only on the small cup.');
    for (let i = 0; i < 40 && releaseGate === undefined; i += 1) await h.flush();
    expect(releaseGate).toBeDefined();

    // The guest corrects the call while the read-back is still being written.
    speak(h.conversation, 'No, signs only this morning.');
    await h.flush();
    releaseGate?.();
    await h.flush();

    expect(h.playing.some((entry) => entry.text === 'Josh, is that your call?')).toBe(false);
    expect(h.transcript.some(([, text]) => text === 'Josh, is that your call?')).toBe(false);
    expect(h.logs).not.toContainEqual('[confirm] read-back: Josh, is that your call?');
    h.conversation.close();
  });

  it('does not send a silence nudge while a read-back is still being written', async () => {
    let releaseGate: (() => void) | undefined;
    const h = harness(withColleagueHost(scenario), 0,
      () => readyFor('Old price only on the small cup'), {
        silencePromptMs: 5,
        silenceNudgeLeadMs: 0,
        topicTimeBudgetMs: 600_000,
        gateStream: (request) => (async function* () {
          await new Promise<void>((resolve) => { releaseGate = resolve; });
          yield `${request.speaker}: So it's old price only on the small cup. That's the call?`;
        })(),
      });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Old price only on the small cup.');
    for (let i = 0; i < 40 && releaseGate === undefined; i += 1) await h.flush();
    expect(releaseGate).toBeDefined();

    // The silence prompt is due while the read-back is still being written; it must not start a free nudge.
    await vi.advanceTimersByTimeAsync(50);
    expect(h.logs).not.toContainEqual('[respond] asking the model');
    expect(h.calls).toHaveLength(0);

    releaseGate?.();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript.some(([, text]) => text.includes("That's the call?"))).toBe(true);
    h.conversation.close();
  });

  it('reads back the whole standing call, not an earlier request that added nothing to it', async () => {
    const first = "We're split on this — let's table it for now and set up a follow-up to settle it later.";
    const second = 'Fair point — put me on the counter myself from 8 to 10, and we keep Auntie Mary on her rest day.';
    const reader = (input: GuestReaderInput): GuestReading => input.line === first
      ? {
        kind: 'park',
        answersOpenQuestion: false,
        relevantFactIds: [],
        relevantCatchIds: [],
        readiness: {
          action: { covered: false },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      }
      : readyFor('put me on the counter myself from 8 to 10');
    const h = harness(withColleagueHost(scenario), 0, reader, {
      silencePromptMs: 600_000,
      topicTimeBudgetMs: 600_000,
      gateStream: (request) => (async function* () {
        // A stand-in for the live writer: it restates every guest line it is handed.
        const said = request.purpose === 'readback' ? request.guestLines.join(', ') : request.call;
        yield `${request.speaker}: So the call is ${said.replace(/[.!?]/g, '')}, is that your call?`;
      })(),
    });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say(first);
    await waitForCall(h, 0);
    await reply(h, 'Ada: This has to be decided before service.');

    await h.say(second);
    await h.flush();
    await finishPlaying(h);

    const readback = h.transcript.find(([, text]) => text.endsWith('is that your call?'));
    expect(readback?.[0]).toBe('Sam');
    expect(readback?.[1]).toContain('put me on the counter myself from 8 to 10');
    // The reader quoted only part of the line; the read-back still gets the whole line, so no part is lost.
    expect(readback?.[1]).toContain('Auntie Mary on her rest day');
    expect(readback?.[1]).not.toContain('table it for now');
    h.conversation.close();
  });

  it('drops a prepared read-back when the guest speaks before it is heard', async () => {
    let releaseGate: (() => void) | undefined;
    let releaseReader: (() => void) | undefined;
    const h = harness(withColleagueHost(scenario), 0, (input) => {
      if (input.line.startsWith('Yes,')) {
        return new Promise<GuestReading>((resolve) => {
          releaseReader = () => resolve(readyFor('put me on the counter myself from 8 to 10'));
        });
      }
      return readyFor('put me on the counter myself from 8 to 10');
    }, {
      silencePromptMs: 600_000,
      topicTimeBudgetMs: 600_000,
      gateStream: (request) => (async function* () {
        if (request.purpose === 'readback') {
          await new Promise<void>((resolve) => { releaseGate = resolve; });
        }
        yield `${request.speaker}: So it's put me on the counter myself from 8 to 10. That's the call?`;
      })(),
    });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Put me on the counter myself from 8 to 10.');
    for (let i = 0; i < 40 && releaseGate === undefined; i += 1) await h.flush();
    expect(releaseGate).toBeDefined();

    // Keep the room busy so the written read-back waits its turn.
    h.conversation.announce('Bao', 'One moment, checking the rota.');
    await h.flush();
    releaseGate?.();
    await h.flush();
    expect(h.transcript.some(([, text]) => text.includes("That's the call?"))).toBe(false);

    // The guest speaks again before the prepared read-back is heard; the new line's reader is still working.
    speak(h.conversation, "Yes, that's the call — I'm on the counter from 8 to 10.");
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 40 && releaseReader === undefined; i += 1) await h.flush();
    expect(releaseReader).toBeDefined();
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 80; i += 1) {
      await h.flush();
      const next = h.playing.find((entry) => !entry.finished);
      if (next === undefined) break;
      next.finish();
      await h.flush();
    }

    expect(h.transcript.some(([, text]) => text.includes("That's the call?"))).toBe(false);
    h.conversation.close();
  });

  it('keeps the open question when settling fails, so the room does not treat it as answered', async () => {
    const readerInputs: GuestReaderInput[] = [];
    const h = harness(scenario, 0, (input) => {
      readerInputs.push(input);
      return readyFor('Old price only on the small cup');
    }, { silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockRejectedValueOnce(new Error('task store down'));
    h.ports.settleTopic = settleTopic;

    h.conversation.announce('Bao', 'Josh, who covers the counter?');
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();

    speak(h.conversation, 'Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.stringContaining('could not create follow-up'));

    speak(h.conversation, 'Yes, old price still.');
    await h.flush();
    expect(readerInputs.at(-1)?.openQuestion?.text).toBe('Josh, who covers the counter?');
    h.conversation.close();
  });

  it('clears a stale open question on settle so the card nudge is not blocked', async () => {
    const h = harness(scenario, 0, () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    h.conversation.announce('Bao', 'Josh, who covers the counter?');
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.transcript).toContainEqual(['Bao', 'Josh, who covers the counter?']);

    speak(h.conversation, 'Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    h.conversation.taskStatus('task-1', scenario.agenda[0]!.title, 'DISPATCHED', true);

    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(h.logs).not.toContainEqual(expect.stringContaining('skipped the review nudge while a question to the guest is open'));
    expect(h.logs).toContainEqual(expect.stringContaining("Kaki's pop-up points at the card, Sam says nothing"));
    expect(h.transcript.some(([, text]) => /on your (?:screen|card)/i.test(text))).toBe(false);
    h.conversation.close();
  });

  it('moves on without a pointer when no TASK_UPDATED card arrives', async () => {
    const h = harness(scenario, 0, () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    speak(h.conversation, 'Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();

    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(h.logs).toContainEqual('[card] skipped the review nudge: no follow-up card exists yet');

    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.logs).toContainEqual('[card] moving on without a pointer: no follow-up card arrived');
    expect(h.transcript.some(([, text]) => /card|screen/i.test(text))).toBe(false);
    h.conversation.close();
  });

  it('marks a card that arrives while the no-card wrap-up is still queued, without speaking it', async () => {
    const h = harness(scenario, 0, () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const advanceAgenda = vi.fn();
    h.ports.advanceAgenda = advanceAgenda;

    speak(h.conversation, 'Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();

    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.logs).toContainEqual('[card] moving on without a pointer: no follow-up card arrived');

    // The card lands while that wrap-up is still queued or playing.
    h.conversation.taskStatus('task-1', scenario.agenda[0]!.title, 'DISPATCHED', true);
    await h.flush();
    await finishPlaying(h);
    await vi.advanceTimersByTimeAsync(1000);
    await finishPlaying(h);

    expect(h.logs).toContainEqual(expect.stringContaining("Kaki's pop-up points at the card, Sam says nothing"));
    expect(h.transcript.some(([, text]) => /on your (?:screen|card)/i.test(text))).toBe(false);
    expect(advanceAgenda).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('takes an answer after the nudge normally and commits on agree', async () => {
    const ready = {
      kind: 'answer' as const,
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'Old price only on the small cup' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const agree = { ...ready, kind: 'agree' as const, answersOpenQuestion: true };
    const h = harness(scenario, 0,
      (input) => (input.line.trim().toLowerCase().startsWith('yes') ? agree : ready),
      { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Old price only on the small cup.');
    await finishPlaying(h);
    for (let i = 0; i < 80 && !h.transcript.some(([, text]) => text === 'Still with me?'); i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    expect(h.transcript.filter(([, text]) => text === 'Still with me?')).toHaveLength(1);
    expect(settleTopic).not.toHaveBeenCalled();

    await h.say('Yes.');
    await finishPlaying(h);
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(settleTopic).toHaveBeenCalledWith(
      expect.objectContaining({ decisionSource: 'Old price only on the small cup' }), false);
    expect(settleTopic.mock.calls[0]?.[0].context).not.toContain('Open question');
    expect(h.transcript.filter(([, text]) => text === "So it's old price only on the small cup.")).toHaveLength(1);
    h.conversation.close();
  });

  it('ignores a legacy settle tag so only the planner\'s confirmation speaks after readiness', async () => {
    const vague = {
      kind: 'answer' as const,
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const ready = {
      ...vague,
      kind: 'idea' as const,
      readiness: {
        action: { covered: true, evidence: 'Old price only on the small cup' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(scenario, 0,
      (input) => (input.line.toLowerCase().includes('old price') ? ready : vague),
      { topicTimeBudgetMs: 600_000 });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    await h.say('We should do something.');
    await reply(h, 'KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"}}\nAda: Let us look at the counter first.');
    await h.say('Old price only on the small cup.');
    await finishPlaying(h);

    const confirmations = h.transcript.filter(([speaker, text]) => speaker === 'Ada' && text.includes("That's the call?"));
    expect(confirmations).toHaveLength(1);
    expect(h.transcript.some(([, text]) => text.toLowerCase().includes('shall we lock in'))).toBe(false);
    h.conversation.close();
  });

  it('reads the guest call back in plain words, with no quotes and no extra direction', async () => {
    const written = "So it's signs only this morning, and we leave the sockets alone. That's the call?";
    const h = harness(withDirections(['Raise the app price.']), 0,
      () => readyFor('Signs only this morning'), {
        gateStream: () => (async function* () { yield `Ada: ${written}`; })(),
      });
    await h.say('Signs only this morning.');
    await finishPlaying(h);

    expect(h.logs).toContainEqual(`[confirm] read-back: ${written}`);
    expect(h.transcript).toContainEqual(['Ada', "So it's signs only this morning, and we leave the sockets alone."]);
    expect(h.transcript).toContainEqual(['Ada', "That's the call?"]);
    expect(h.transcript.some(([, text]) => text.includes('"'))).toBe(false);
    expect(h.transcript.some(([, text]) => /raise the app price/i.test(text))).toBe(false);
    h.conversation.close();
  });

  it('falls back to a plain check when the read-back writer quotes the guest', async () => {
    const h = harness(withDirections(['Raise the app price.']), 0,
      () => readyFor('Signs only this morning'), {
        gateStream: () => (async function* () { yield 'Ada: So your call is "signs only". Is that right?'; })(),
      });
    await h.say('Signs only this morning.');
    await finishPlaying(h);

    expect(h.logs).toContainEqual('[confirm] read-back: Josh, is that your call?');
    expect(h.transcript).toContainEqual(['Ada', 'Josh, is that your call?']);
    expect(h.transcript.some(([, text]) => text.includes('"'))).toBe(false);
    h.conversation.close();
  });

  it('offers one concrete call in plain words and commits it on agree', async () => {
    const agree = {
      ...readyFor('Ask Auntie Mary to come in'),
      kind: 'agree' as const,
      answersOpenQuestion: true,
    };
    const readerInputs: GuestReaderInput[] = [];
    const h = harness(withDirections(['Ask Auntie Mary to come in.', 'An agency temp needs notice.']),
      0,
      (input) => {
        readerInputs.push(input);
        return input.line.trim().toLowerCase().startsWith('yes') ? agree : nothingCovered;
      }, {
        gateStream: () => (async function* () { yield 'Ada: How about we ask Auntie Mary in, nicely?'; })(),
      });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('We should do something.');
    const clarify = await waitForCall(h, 0);
    clarify.push('Ada: What do you want to do?');
    clarify.end();
    await h.flush();
    await finishPlaying(h);
    h.conversation.lockDecision();
    h.conversation.lockDecision();
    for (let i = 0; i < 40 && !h.transcript.some(([, text]) => /how about we/i.test(text)); i += 1) {
      await vi.advanceTimersByTimeAsync(600);
      await finishPlaying(h);
    }
    await finishPlaying(h);
    expect(h.logs.filter((line) => line.startsWith('[offer] spoken:')).length).toBe(1);
    expect(h.transcript).toContainEqual(['Ada', 'How about we ask Auntie Mary in, nicely?']);
    expect(h.transcript.some(([, text]) => text.includes('"'))).toBe(false);
    expect(h.transcript.some(([, text]) => /agency temp needs notice/i.test(text))).toBe(false);

    await h.say('Yes.');
    await finishPlaying(h);
    expect(readerInputs.find((input) => input.line === 'Yes.')?.offer?.proposal)
      .toBe('How about we ask Auntie Mary in, nicely?');
    expect(settleTopic).toHaveBeenCalledWith(
      expect.objectContaining({ decisionSource: 'Ask Auntie Mary to come in' }), false);
    h.conversation.close();
  });

  it('does not queue a second confirmation while one is queued or speaking', async () => {
    const h = harness(withDirections([]), 0,
      () => readyFor('Signs only this morning'));
    await h.say('Signs only this morning.');
    h.conversation.lockDecision();
    h.conversation.lockDecision();
    await finishPlaying(h);
    h.conversation.lockDecision();
    await h.flush();

    expect(h.logs.filter((line) => line.startsWith('[confirm] read-back:')).length).toBe(1);
    expect(h.transcript.filter(([, text]) => text.includes("That's the call?"))).toHaveLength(1);
    h.conversation.close();
  });

  it('does not queue a second offer while one is queued or speaking', async () => {
    const h = harness(withDirections(['Ask Auntie Mary to come in.']), 0,
      () => nothingCovered);
    await h.say('We should do something.');
    const clarify = await waitForCall(h, 0);
    clarify.push('Ada: What do you want to do?');
    clarify.end();
    await h.flush();
    await finishPlaying(h);
    h.conversation.lockDecision();
    h.conversation.lockDecision();
    for (let i = 0; i < 40 && !h.transcript.some(([, text]) => /how about we/i.test(text)); i += 1) {
      await vi.advanceTimersByTimeAsync(600);
      await finishPlaying(h);
    }
    await finishPlaying(h);
    h.conversation.lockDecision();
    await h.flush();

    expect(h.logs.filter((line) => line.startsWith('[offer] spoken:')).length).toBe(1);
    expect(h.transcript.filter(([, text]) => /how about we/i.test(text))).toHaveLength(1);
    h.conversation.close();
  });

  it('routes the one-speaker budget through a confirmation the planner recognises, and a following yes commits', async () => {
    const ready = {
      kind: 'idea' as const,
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: ['0:catch:0'],
      readiness: {
        action: { covered: true, evidence: 'Let us call Auntie Mary in' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const backchannel = {
      ...ready,
      kind: 'backchannel' as const,
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const agree = { ...ready, kind: 'agree' as const, answersOpenQuestion: true };
    const h = harness(catchScenario, 0, (input) => {
      const text = input.line.trim().toLowerCase();
      if (text.startsWith('yes')) return agree;
      if (text.startsWith('hmm')) return backchannel;
      return ready;
    }, { topicTurnBudget: 2, topicTimeBudgetMs: 600_000, silencePromptMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Let us call Auntie Mary in.');
    const catchCall = await waitForCall(h, 0);
    expect(String(catchCall.messages.map((message) => message.content).join('\n'))).toContain('You are Bao');
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');

    // The second guest line trips the turn budget; the budget must ask a gate the planner can commit.
    await h.say('Hmm.');
    for (let i = 0; i < 40 && !h.transcript.some(([, text]) => text.includes("That's the call?")); i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await finishPlaying(h);
    }
    expect(h.transcript).toContainEqual(['Ada', "So it's let us call Auntie Mary in."]);
    expect(h.transcript).toContainEqual(['Ada', "That's the call?"]);
    expect(h.transcript.some(([, text]) => text.toLowerCase().includes('shall we lock in'))).toBe(false);

    await h.say('Yes.');
    await finishPlaying(h);
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(settleTopic.mock.calls[0]?.[0].context).not.toContain('Open question');
    h.conversation.close();
  });

  it('retries the budget when a reply line blocked it, so a backchannel still gets an offer', async () => {
    const off = {
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(scenario, 60_000, (input) =>
      input.line.trim().toLowerCase().startsWith('hmm')
        ? { ...off, kind: 'backchannel' as const }
        : { ...off, kind: 'idea' as const },
    { topicTurnBudget: 2, topicTimeBudgetMs: 600_000, silencePromptMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work, but who covers the counter?');
    first.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);

    // The second line trips the budget while Ada is still speaking; it must stay owed, not be spent.
    h.conversation.humanSpeech(true);
    h.conversation.humanText('Hmm.');
    await h.flush();
    expect(h.transcript.some(([, text]) => text.includes('how about we'))).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('the budget could not ask yet'));

    // The guest stops after Ada's line finishes, so the backchannel gets its reply and the budget retries.
    await finishPlaying(h);
    h.conversation.humanSpeech(false);
    for (let i = 0; i < 40 && !h.transcript.some(([, text]) => text.includes('how about we')); i += 1) {
      await vi.advanceTimersByTimeAsync(900);
      await finishPlaying(h);
    }
    expect(h.transcript).toContainEqual(['Ada', 'Josh, what would you rather do?']);
    h.conversation.close();
  });

  it('gives the reader the question the guest was answering, so a clear call gets confirmed', async () => {
    const samHosted = {
      ...scenario,
      roles: [...scenario.roles, { id: 'host', label: 'Host' }],
      attendees: [...scenario.attendees, { name: 'Sam', role: 'host', displayName: 'Sam (Host)' }],
      npcs: [...scenario.npcs,
        { attendee: 'Sam', role: 'host' as const, voice: 'v4', personality: 'Calm', agenda: 'Keep time', concerns: [] }],
    };
    const readerInputs: GuestReaderInput[] = [];
    const payload = (covered: boolean): string => JSON.stringify({
      kind: covered ? 'idea' : 'off_topic',
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: covered ? { covered: true, evidence: 'small cup at old price' } : { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    });
    const h = harness(samHosted, 0, async (input) => {
      readerInputs.push(input);
      const text = payload(input.line.startsWith('Small cup'));
      return readGuestLine(input, {
        stream: () => (async function* () { yield text; })(),
        log: () => undefined,
      });
    }, { topicTimeBudgetMs: 600_000, silencePromptMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });

    await h.say('Can we talk about the weather?');
    const first = await waitForCall(h, 0);
    first.push('Sam: Josh, where is your head at on the regulars and the price?');
    first.end();
    await h.flush();
    await finishPlaying(h);

    await h.say('Small cup at old price.');
    const asked = readerInputs.find((input) => input.line === 'Small cup at old price.');
    expect(asked?.openQuestion).toEqual({
      from: 'Sam', to: 'Josh', text: 'Josh, where is your head at on the regulars and the price?',
    });

    for (let i = 0; i < 40 && !h.transcript.some(([, text]) => text.includes("That's the call?")); i += 1) {
      await h.flush();
      await finishPlaying(h);
    }
    expect(h.transcript).toContainEqual(['Sam', "So it's small cup at old price."]);
    h.conversation.close();
  });

  it('speaks the host move-back line when a second reopen is refused on the reply path', async () => {
    const twoItems = { ...scenario, agenda: [scenario.agenda[0]!,
      { title: 'Service', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' }] };
    const ready = {
      kind: 'answer' as const,
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'the plan' },
        catchAddressed: { covered: true, evidence: 'the plan' },
        practical: { covered: true, evidence: 'the plan' },
      },
    };
    const h = harness(withColleagueHost(twoItems), 0, () => ready);
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;

    await h.say('Use the first plan.');
    await reply(h, 'Ada: Understood.');
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    expect(h.conversation.memorySnapshot()).toContainEqual({ kind: 'decision', item: 'Prep', text: 'Use the first plan.' });

    h.conversation.agendaMoved('Service');
    await h.say('Actually, change the Prep plan.');
    await reply(h, 'KAKI_CONTROL {"state":"open","reopen":"Prep"}\nAda: Changing that means extra setup.');
    expect(h.conversation.onCurrentAgenda('Prep')).toBe(true);

    speak(h.conversation, 'Use the revised plan.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    expect(h.conversation.onCurrentAgenda('Service')).toBe(true);

    const beforeAgain = h.calls.length;
    await h.say('Actually, change Prep again.');
    const reopenedAgain = await waitForCall(h, beforeAgain);
    const callsAfterAgain = h.calls.length;
    reopenedAgain.push('KAKI_CONTROL {"state":"open","reopen":"Prep"}\nAda: I will change it again.');
    reopenedAgain.end();
    for (let i = 0; i < 12 && !h.playing.some((entry) => entry.text === "Let's keep going with Service."); i += 1) {
      await h.flush();
      await vi.advanceTimersByTimeAsync(600);
      await finishPlaying(h);
    }

    expect(h.logs).toContainEqual(expect.stringContaining('[control] dropped reopen: Prep was already reopened'));
    expect(h.playing.some((entry) => entry.text === "Let's keep going with Service.")).toBe(true);
    expect(h.transcript).toContainEqual(['Sam', "Let's keep going with Service."]);
    expect(h.conversation.onCurrentAgenda('Service')).toBe(true);
    await h.flush();
    expect(h.calls.length).toBe(callsAfterAgain);
    h.conversation.close();
  });

});

describe('robustness with real people', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type H = ReturnType<typeof harness>;

  async function waitForCall(h: H, index: number): Promise<LlmCall> {
    for (let i = 0; i < 80 && h.calls.length <= index; i += 1) await h.flush();
    if (h.calls.length <= index) throw new Error(`expected call ${index}, got ${h.calls.length}`);
    return h.calls[index]!;
  }

  async function finishPlaying(h: H): Promise<void> {
    for (let i = 0; i < 80; i += 1) {
      await h.flush();
      const next = h.playing.find((entry) => !entry.finished);
      if (next === undefined) return;
      next.finish();
      await h.flush();
    }
    throw new Error('playback did not finish');
  }

  it('lets a colleague accept a share the visitor gave them in plain words', async () => {
    const assigned = {
      kind: 'idea' as const,
      addressee: 'Bao',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: true, evidence: 'Bao shares the decision with the team' },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    };
    const h = harness(scenario, 0, () => assigned);
    await h.say('I want Bao to share the decision with the team.');
    const call = await waitForCall(h, 0);
    call.push('Bao: Of course, I will share the decision with the team.');
    call.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Bao', 'Of course, I will share the decision with the team.']);
    expect(h.logs).not.toContainEqual(expect.stringContaining('dropped a sentence that gives the visitor\'s follow-up'));
    h.conversation.close();
  });

  it('drops a colleague claiming a step the visitor gave someone else', async () => {
    const toAda = {
      kind: 'idea' as const,
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: { action: { covered: false }, catchAddressed: { covered: false }, practical: { covered: false } },
    };
    const h = harness(scenario, 0, () => toAda);
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    await h.say('Add the regulars price tonight, and Bao will test the rule before 8.');
    const call = await waitForCall(h, 0);
    call.push("Ada: I'd sooner be the one testing that button before eight. I'll put the button on the till tonight.");
    call.end();
    await h.flush();
    await finishPlaying(h);
    const said = h.transcript.map(([, text]) => text);
    expect(said.join(' ')).toContain("I'll put the button on the till tonight.");
    expect(h.transcript.some(([speaker, text]) => speaker === 'Ada' && /test/i.test(text))).toBe(false);
    expect(h.logs.filter((text) => text.includes('claims a step the visitor gave someone else'))).toHaveLength(1);
    h.conversation.close();
  });

  it('keeps the assignee taking their own step, and steps nobody was given', async () => {
    const toAda = {
      kind: 'idea' as const,
      addressee: 'Ada',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: { action: { covered: false }, catchAddressed: { covered: false }, practical: { covered: false } },
    };
    const h = harness(scenario, 0, () => toAda);
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    await h.say('Bao will test the rule before 8.');
    const call = await waitForCall(h, 0);
    call.push("Ada: I'll print the new price cards. I can help Bao with anything he needs.");
    call.end();
    await h.flush();
    await finishPlaying(h);
    const said = h.transcript.map(([, text]) => text).join(' ');
    expect(said).toContain("I'll print the new price cards.");
    expect(said).toContain('I can help Bao with anything he needs.');
    expect(h.logs.some((text) => text.includes('claims a step the visitor gave someone else'))).toBe(false);
    h.conversation.close();
  });

  describe('which colleague sentences count as claiming a step given to someone else', () => {
    const names = ['Ada', 'Bao', 'Mei', 'Josh'];
    it.each([
      ['Bao will test the rule before 8.', "I'd sooner be the one testing that button."],
      ['Bao will test the rule before 8.', "I'll test it myself tonight."],
      ['Let Mei print the price cards.', 'I can print them faster.'],
      ['Bao will test the rule before 8.', "I'll be the one to test it tonight."],
      ['Bao will test the rule before 8.', "I'd rather be the one to test it."],
    ])('drops: visitor "%s", Ada "%s"', (guest, line) => {
      expect(claimsStepGivenToOther(line, 'Ada', [guest], names)).toBe(true);
    });
    it.each([
      // Naming someone else's step while claiming a different one.
      ['Bao will test the rule before 8.', "I'll print the cards so Bao can test them tonight."],
      ['Bao will test the rule before 8.', "Bao will test it, and I'll prep the price cards."],
      // Same general verb, different job.
      ['Mei will check the fridge temps.', "I'll check the till float tonight."],
      ['Mei will tell the regulars.', "I'll tell the kitchen crew."],
      ['Mei will post the notice.', "I'll update the poster by the counter."],
      // The visitor moved the step to Ada.
      ['Bao will test the rule. Actually Ada, you test it instead.', "Sure, I'll test it then."],
      // "be the one" without a claim before it.
      ['Mei will test the rule before 8.', 'That could be the one test that matters.'],
    ])('keeps: visitor "%s", Ada "%s"', (guest, line) => {
      expect(claimsStepGivenToOther(line, 'Ada', [guest], names)).toBe(false);
    });
  });

  it('keeps a second AI question to the visitor who has gone quiet, and says so loudly', async () => {
    const h = harness(scenario, 0, undefined, { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    await h.say('We should close the counter early on Monday.');
    const first = await waitForCall(h, 0);
    first.push('Ada: Closing early saves the overtime budget. Josh, can you cover the late deliveries?');
    first.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Ada', 'Josh, can you cover the late deliveries?']);

    // The visitor goes quiet: the check-in asks again, then a colleague asks their own question.
    for (let i = 0; i < 200 && h.calls.length < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    const checkIn = await waitForCall(h, 1);
    checkIn.push('Ada: Josh, are you still with me? What should we do about the counter?');
    checkIn.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Ada', 'Josh, are you still with me?']);
    expect(h.transcript).toContainEqual(['Ada', 'What should we do about the counter?']);

    for (let i = 0; i < 200 && h.calls.length < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    const colleague = await waitForCall(h, 2);
    colleague.push('Bao: The supplier arrives at nine. Josh, can you manage the queue?');
    colleague.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Bao', 'Josh, can you manage the queue?']);
    expect(h.logs).toContainEqual(expect.stringContaining('a second question to the visitor this round'));
    h.conversation.close();
  });

  it('lets a colleague correct the plan although it overlaps the earlier line', async () => {
    const h = harness(scenario, 0, undefined, { silencePromptMs: 5, silenceNudgeLeadMs: 0, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    await h.say('We are closing the counter early on Monday.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That works for me. Josh, can you cover the deliveries?');
    first.end();
    await h.flush();
    await finishPlaying(h);

    for (let i = 0; i < 200 && h.calls.length < 2; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    const checkIn = await waitForCall(h, 1);
    checkIn.push('Ada: Josh, are you still with me? We are closing the counter early on Monday then.');
    checkIn.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Ada', 'We are closing the counter early on Monday then.']);

    for (let i = 0; i < 200 && h.calls.length < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(5);
      await finishPlaying(h);
    }
    // Bao's correction shares the check-in's words but flips their meaning, so it is not a repeat.
    const colleague = await waitForCall(h, 2);
    colleague.push('Bao: We are not closing the counter early on Monday without more staff, Josh.');
    colleague.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Bao', 'We are not closing the counter early on Monday without more staff, Josh.']);
    h.conversation.close();
  });

  it('briefs the item before asking the guest even with only two AI attendees', async () => {
    const twoAis = {
      ...scenario,
      roles: [...scenario.roles, { id: 'host', label: 'Host' }],
      attendees: [...scenario.attendees, { name: 'Sam', role: 'host', displayName: 'Sam (Host)' }],
      npcs: [
        { attendee: 'Sam', voice: 'v0', role: 'host' as const, personality: 'Calm', agenda: 'Keep time', concerns: [] },
        { attendee: 'Bao', voice: 'v2', personality: 'Chatty cashier', agenda: 'Fix queues', concerns: ['Lines'] },
      ],
      agenda: [{
        title: 'Prep',
        minutes: 5,
        canWait: false,
        deadline: 'before service',
        ownerRole: 'chef',
        decision: 'how do we cover prep?',
        briefing: [
          { text: 'The till needs a new login before opening.', knownBy: [{ attendee: 'Bao', why: 'you run the tills' }] },
        ],
      }],
    };
    const h = harness(twoAis, 0);
    h.conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(2000);
    const first = await waitForCall(h, 0);
    const request = String(first.messages.map((message) => message.content).join('\n'));
    expect(request).toContain('You are Bao');
    expect(request).toContain('Tell only this');
    first.push('Bao: The till needs a new login before opening.');
    first.end();
    await h.flush();
    await finishPlaying(h);
    expect(h.transcript).toContainEqual(['Bao', 'The till needs a new login before opening.']);
    h.conversation.close();
  });
});
