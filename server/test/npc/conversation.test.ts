import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiCast } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import { visitorDispatchLine } from '../../src/npc/cardPointer';
import { NpcConversation, type ConversationOptions, type NpcPorts, type NpcUiState } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { loadScenario } from '../../src/loadScenario';
import { readGuestLine, type GuestReaderInput, type GuestReading } from '../../src/npc/guestReader';
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
  assessment?: (messages: ChatMessage[], call: number) => string,
  replies: 'one-speaker' | 'legacy' = 'legacy',
  reader: (input: GuestReaderInput) => GuestReading | Promise<GuestReading> = fakeReading,
  optionOverrides: Partial<ConversationOptions> = {},
) {
  const calls: LlmCall[] = [];
  const assessments: ChatMessage[][] = [];
  const playing: Playing[] = [];
  const states: NpcUiState[] = [];
  const transcript: Array<[string, string]> = [];
  const transcriptOptions: Array<[string, string, { textOnly?: boolean; catchId?: string } | undefined]> = [];
  const logs: string[] = [];

  const ports: NpcPorts<Utterance> = {
      stream(messages, signal) {
        if (messages.some((message) => message.content.includes('[KAKI_PROPOSAL_ASSESSMENT]'))) {
          const call = assessments.length;
          assessments.push(messages);
          const reply =
            assessment?.(messages, call) ??
            JSON.stringify({ isProposal: true, readiness: 'complete', resolved: [], unresolved: [] });
          return (async function* () {
            yield reply;
          })();
        }
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
      emitState: (state) => states.push(state),
      log: (message) => logs.push(message),
  };
  const conversation = new NpcConversation<Utterance>(ports, { scenario: scenarioUsed, bargeInMs, responseDelayMs: 900, speakerGapMs: 0, sentenceGapMs: 0, replies,
    readGuestLine: async (input) => reader(input),
    gateStream: (request) => (async function* () {
      const lower = request.call.length === 0 ? request.call : `${request.call[0]!.toLowerCase()}${request.call.slice(1)}`;
      yield request.purpose === 'readback'
        ? `${request.speaker}: So it's ${lower}. That's the call?`
        : `${request.speaker}: How about we ${lower}?`;
    })(),
    ...optionOverrides });
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
  return { conversation, ports, calls, assessments, playing, states, transcript, transcriptOptions, logs, flush, say };
}

describe('NpcConversation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('limits a solo reply to one speaker and two sentences, then requests a reaction', async () => {
    const withThree = { ...scenario, npcs: [...scenario.npcs,
      { attendee: 'Cai', voice: 'v3', personality: 'Quiet', agenda: 'Open on time', concerns: [] }],
      attendees: [...scenario.attendees, { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai' }] };
    const h = harness(withThree);
    await h.say('What happened?');
    expect(h.calls.at(-1)?.messages.at(-1)?.content).toContain('ONE colleague answers in at most two short sentences');
    h.calls.at(-1)?.push('Ada: We are short today. The till is ready. Bao: I have more to add.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await vi.advanceTimersByTimeAsync(400);
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.transcript.filter(([speaker]) => speaker === 'Ada').map(([, text]) => text)).toEqual([
      'We are short today.', 'The till is ready.',
    ]);
    expect(h.logs).toContainEqual(expect.stringContaining('[shape] dropped extra line from Bao'));
    await h.say('And the queue?');
    expect(h.calls.at(-1)?.messages.at(-1)?.content).toContain('single short sentence reacting');
    h.conversation.close();
  });

  it('blocks another lock-in ask within a minute and suppresses an immediate overtime cue', async () => {
    const h = harness(hostedScenario());
    await h.say('What if we keep the prep plan?');
    h.calls.at(-1)?.push('Ada: Shall we lock in the prep plan?');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.shouldSkipOvertimeCue()).toBe(true);
    await h.say('Could we wait?');
    h.calls.at(-1)?.push('Ada: Shall I lock in what you said?');
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.logs).toContainEqual(expect.stringContaining('skipped a repeated lock-in ask'));
    vi.setSystemTime(Date.now() + 15_001);
    expect(h.conversation.shouldSkipOvertimeCue()).toBe(false);
    h.conversation.close();
  });

  it('reopens one earlier meeting item, replaces its decision, and returns to the current item', async () => {
    const twoItems = { ...scenario, agenda: [scenario.agenda[0]!,
      { title: 'Service', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' }] };
    const h = harness(twoItems);
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    await h.say('Use the first plan.');
    h.calls.at(-1)?.push('Ada: I hear you.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    h.conversation.lockDecision();
    await h.flush();
    expect(h.conversation.memorySnapshot()).toContainEqual({ kind: 'decision', item: 'Prep', text: 'Use the first plan.' });
    h.conversation.agendaMoved('Service');
    await h.say('Actually, change the Prep plan.');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reopen":"Prep"}\nAda: Changing that means extra setup.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.onCurrentAgenda('Prep')).toBe(true);
    h.conversation.humanTyped('Use the revised plan.');
    h.conversation.lockDecision();
    await h.flush();
    expect(settleTopic).toHaveBeenLastCalledWith(expect.objectContaining({ agendaItemTitle: 'Prep' }), true);
    expect(h.conversation.memorySnapshot().filter((entry) => entry.kind === 'decision')).toEqual([
      { kind: 'decision', item: 'Prep', text: 'Actually, change the Prep plan. Use the revised plan.' },
    ]);
    expect(h.conversation.onCurrentAgenda('Service')).toBe(true);
    await h.say('Actually, change Prep again.');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reopen":"Prep"}\nAda: I will change it again.');
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.logs).toContainEqual(expect.stringContaining('[control] dropped reopen: Prep was already reopened'));
    expect(h.playing.at(-1)?.text).toBe("Let's keep going with Service.");
    expect(h.conversation.onCurrentAgenda('Service')).toBe(true);
    h.conversation.close();
  });

  it('does not settle on the first idea, tells the room to raise its catch, and settles on the second idea', async () => {
    const h = harness(hostedScenario());
    h.conversation.setHuman({ name: 'Josh', role: 'producer' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    await h.say('Use the window bar.');
    const first = h.calls.at(-1)!;
    expect(String(first.messages.at(-1)?.content)).toContain('first idea on "Prep"');
    expect(String(first.messages.at(-1)?.content)).toContain('raise that catch');
    first.push('KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: The window bar works, but who covers the counter?');
    first.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(settleTopic).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.stringContaining('[settle] ignored settled'));

    await h.say('Mei covers the counter from nine.');
    const second = h.calls.at(-1)!;
    expect(String(second.messages.at(-1)?.content)).not.toContain('first idea on "Prep"');
    second.push('KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: That works.');
    second.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(settleTopic).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('settles after the first idea when the visitor only agrees ("Yes.") instead of giving a new idea', async () => {
    const h = harness(hostedScenario());
    h.conversation.setHuman({ name: 'Josh', role: 'producer' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    await h.say('Use the window bar.');
    const first = h.calls.at(-1)!;
    first.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false}\nAda: The window bar works, but who covers the counter? Shall we lock it in?');
    first.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();

    await h.say('Yes.');
    const second = h.calls.at(-1)!;
    expect(String(second.messages.at(-1)?.content)).not.toContain('first idea on "Prep"');
    second.push('KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: Locked in.');
    second.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(settleTopic).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('still parks a topic on the first line', async () => {
    const h = harness(hostedScenario());
    h.conversation.setHuman({ name: 'Josh', role: 'producer' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    await h.say('Park it for now.');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"deferred","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: Fair enough, we can come back to it.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.logs.some((line) => line.includes('[settle] ignored settled'))).toBe(false);
    expect(settleTopic).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('varies the card pointer wording by topic so two topics never repeat it', () => {
    const first = visitorDispatchLine('Josh', 1, 0);
    const second = visitorDispatchLine('Josh', 1, 1);
    expect(first).toBe("Josh, the follow-up's on your screen whenever you want to send it.");
    expect(second).not.toBe(first);
    expect(second).toContain("the follow-up's on your screen");
    expect(visitorDispatchLine('Josh', 2, 1)).not.toContain("whenever you're ready.");
  });

  it('records invented and spoken facts but drops a playful reaction on a sensitive item', async () => {
    const sensitive = { ...scenario, agenda: [{ ...scenario.agenda[0]!, sensitive: true }] };
    const h = harness(sensitive);
    const reaction = vi.fn();
    h.ports.onReaction = reaction;
    await h.say('Can we get help?');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"newFacts":["Help takes 12 minutes."],"reactions":[{"who":"Ada","emoji":"🙌"},{"who":"Bao","emoji":"😬"}]}\nAda: It will cost $37.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.memorySnapshot()).toContainEqual({ kind: 'invented', item: 'Prep', text: 'Help takes 12 minutes.' });
    expect(h.conversation.memorySnapshot()).toContainEqual({ kind: 'saidAloud', item: 'Prep', text: 'said aloud: It will cost $37.' });
    expect(reaction).toHaveBeenCalledTimes(1);
    expect(reaction).toHaveBeenCalledWith('Bao', '😬');
    expect(h.logs).toContainEqual(expect.stringContaining('[control] dropped reaction'));
    h.conversation.close();
  });

  it('sends a reaction as the reply starts, once, before it finishes playing', async () => {
    const h = harness();
    const reaction = vi.fn();
    h.ports.onReaction = reaction;
    await h.say('Can we get help?');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reactions":[{"who":"Ada","emoji":"🙌"}]}\nAda: It will cost $37.');
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.playing).toHaveLength(1);
    expect(h.playing[0]?.finished).toBe(false);
    expect(reaction).toHaveBeenCalledTimes(1);
    expect(reaction).toHaveBeenCalledWith('Ada', '🙌');
    h.playing[0]?.finish();
    await h.flush();
    expect(reaction).toHaveBeenCalledTimes(1);
    h.conversation.close();
  });

  it('shows the Director what the room already said on this topic', async () => {
    const h = harness();
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: Anyone new on the till needs a login, and that is about fifteen minutes before opening.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await h.say('Tell me more.');
    const prompt = String(h.calls.at(-1)?.messages[0]?.content);
    expect(prompt).toContain('Already said on this topic');
    expect(prompt).toContain('Anyone new on the till needs a login');
    h.conversation.close();
  });

  it('keeps a line said more than a minute earlier in the prompt for the same topic', async () => {
    const h = harness();
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: The till needs a login about fifteen minutes before opening.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(61_000);
    for (const entry of h.playing) if (!entry.finished) entry.finish();
    await h.flush();
    await h.say('Go on.');
    const prompt = String(h.calls.at(-1)?.messages[0]?.content);
    expect(prompt).toContain('Already said on this topic');
    expect(prompt).toContain('The till needs a login about fifteen minutes before opening.');
    h.conversation.close();
  });

  it('starts a new topic with an empty record', async () => {
    const twoItems = { ...scenario, agenda: [scenario.agenda[0]!,
      { title: 'Service', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' }] };
    const h = harness(twoItems);
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: Thirty trays only cover thirty platters.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    h.conversation.agendaMoved('Service');
    await h.say('Hello again.');
    const prompt = String(h.calls.at(-1)?.messages[0]?.content);
    expect(prompt).not.toContain('Already said on this topic');
    expect(prompt).not.toContain('Thirty trays only cover thirty platters');
    h.conversation.close();
  });

  it('clears the open question once the visitor answers it', async () => {
    const h = harness();
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: Josh, who covers the counter?');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.openQuestionOnCurrentTopic()).toEqual({
      from: 'Ada', to: 'Josh', text: 'Josh, who covers the counter?',
    });
    await h.say('Mei covers it.');
    h.calls.at(-1)?.push('NONE');
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.conversation.openQuestionOnCurrentTopic()).toBeUndefined();
    h.conversation.close();
  });

  it('carries a substantive colleague question onto the follow-up card', async () => {
    const h = harness();
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    const settleTopic = vi.fn().mockResolvedValue(undefined);
    h.ports.settleTopic = settleTopic;
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: What do we do for the regulars?');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await h.say('Keep the price and explain it at the counter.');
    h.calls.at(-1)?.push('NONE');
    h.calls.at(-1)?.end();
    await h.flush();
    h.conversation.lockDecision();
    await h.flush();
    expect(settleTopic).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.stringContaining(
        'Open question to carry into the follow-up: What do we do for the regulars?'),
    }), false);
    h.conversation.close();
  });

  it('knows when a colleague volunteered to handle the follow-up in their own recent line', async () => {
    const h = harness();
    await h.say('Can you handle this?');
    h.calls.at(-1)?.push("Ada: Leave it with me, I'll handle that follow-up.");
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.volunteeredOnTopic('Ada')).toBe(true);
    expect(h.conversation.volunteeredOnTopic('Bao')).toBe(false);
    h.conversation.close();
  });

  it('remembers a colleague offer in everyday words for the rest of the topic', async () => {
    const h = harness();
    await h.say('Can someone get the cards printed?');
    h.calls.at(-1)?.push('Ada: Yes, I can get those printed before eight.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.conversation.volunteeredOnTopic('Ada')).toBe(true);
    h.conversation.close();
  });

  it.each([
    'That depends on it.',
    "I'll get shouted at by the regulars.",
    'I can do the till login, but I need the password first.',
  ])('does not count "%s" as volunteering', async (line) => {
    const h = harness();
    await h.say('Can you handle this?');
    h.calls.at(-1)?.push(`Ada: ${line}`);
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.volunteeredOnTopic('Ada')).toBe(false);
    h.conversation.close();
  });

  it.each([
    'Leave it with me.',
    "I'll handle the supplier call.",
    'I can draft that.',
    'On it.',
  ])('counts "%s" as volunteering', async (line) => {
    const h = harness();
    await h.say('Can you handle this?');
    h.calls.at(-1)?.push(`Ada: ${line}`);
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.conversation.volunteeredOnTopic('Ada')).toBe(true);
    h.conversation.close();
  });

  it('knows when the visitor already gave the follow-up to a colleague', async () => {
    const h = harness();
    await h.say('Daniel, can you call the supplier?');
    expect(h.conversation.askedByGuestOnTopic('Daniel')).toBe(true);
    expect(h.conversation.askedByGuestOnTopic('Ada')).toBe(false);
    h.conversation.close();
  });

  it('does not treat a question or an earlier topic as an assignment', async () => {
    const twoItems = { ...scenario, agenda: [scenario.agenda[0]!,
      { title: 'Service', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' }] };
    const h = harness(twoItems);
    h.conversation.humanTyped('Daniel, what do you think?');
    expect(h.conversation.askedByGuestOnTopic('Daniel')).toBe(false);
    h.conversation.humanTyped('Daniel, can you call the supplier?');
    expect(h.conversation.askedByGuestOnTopic('Daniel')).toBe(true);
    h.conversation.agendaMoved('Service');
    expect(h.conversation.askedByGuestOnTopic('Daniel')).toBe(false);
    h.conversation.close();
  });

  it('still knows about an assignment minutes later on the same topic, when the task is handed out', async () => {
    const h = harness();
    h.conversation.humanTyped('Daniel, can you call the supplier?');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.conversation.askedByGuestOnTopic('Daniel')).toBe(true);
    h.conversation.close();
  });

  it('skips the card nudge and its move-on sentence once the host already pointed at the card', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.announce('Ada', 'Josh, the card is waiting for you.');
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.logs).toContainEqual(expect.stringContaining('skipped the card nudge on "Prep"'));
    expect(h.playing.some((entry) => /the (?:follow-up|invite)'s on your screen/i.test(entry.text))).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe("Let's leave Prep there.");
    conversation.close();
  });

  it('drops the move-on card sentence when the dispatch points at the card after the topic settles', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    conversation.announce('Ada', "Josh, the follow-up's still on your screen whenever you're ready.");
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.logs).toContainEqual(expect.stringContaining('skipped the card nudge on "Prep"'));
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe("Let's leave Prep there.");
    conversation.close();
  });

  it('nudges the card once, then warns without pointing at it again', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.playing.at(-1)?.text).toContain("the follow-up's on your screen whenever you want to send it");
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe("Let's leave Prep there.");
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).not.toContain("The follow-up's on your card whenever you're ready.");
    conversation.close();
  });

  it('uses the plain dispatch pointer for the card nudge and counts it as the topic pointer', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.playing.at(-1)?.text).toBe(visitorDispatchLine('Josh', 1));
    expect(conversation.cardPointedOnCurrentTopic()).toBe(true);
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe("Let's leave Prep there.");
    conversation.close();
  });

  it('holds the card pointer while a question is open and points once it is answered', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    // A colleague asks the visitor something after the call: the pointer must wait for the answer.
    conversation.announce('Bao', 'Josh, who covers the counter?');
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.logs).toContainEqual(expect.stringContaining('[card] waited: open question "Josh, who covers the counter?"'));
    expect(h.playing.some((entry) => /the follow-up's on your screen/i.test(entry.text))).toBe(false);
    expect(conversation.cardPointedOnCurrentTopic()).toBe(false);
    // The visitor answers: the pointer goes ahead, once.
    conversation.humanTyped('Mei covers the counter from nine.');
    await h.flush();
    h.calls.at(-1)?.push('NONE');
    h.calls.at(-1)?.end();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe(visitorDispatchLine('Josh', 1));
    expect(conversation.cardPointedOnCurrentTopic()).toBe(true);
    conversation.close();
  });

  it('drops a host sentence that tells the visitor to send the follow-up, and logs it', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 60_000, reviewWindowMs: 60_000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0,
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    await h.say('Ship it.');
    h.conversation.lockDecision();
    await h.flush();
    const settled = `KAKI_CONTROL ${JSON.stringify({ state: 'settled',
      followUp: { kind: 'mattermost_post', title: 'Send the card rules' }, wingmanNeeded: false })}`;
    const send = 'Send the card rules round to the team in a short note before you head off.';
    h.calls.at(-1)?.push(`${settled}\nAda: ${send}`);
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).not.toContain(send);
    expect(h.logs).toContain(`[card] dropped host send-instruction: ${send}`);
    conversation.close();
  });

  it('drops a host sentence that points the visitor at the staff channel without a send verb', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 60_000, reviewWindowMs: 60_000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0,
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    await h.say('Ship it.');
    h.conversation.lockDecision();
    await h.flush();
    const settled = `KAKI_CONTROL ${JSON.stringify({ state: 'settled',
      followUp: { kind: 'mattermost_post', title: 'Share the decision' }, wingmanNeeded: false })}`;
    const send = 'Worth putting that on the staff channel before doors open.';
    h.calls.at(-1)?.push(`${settled}\nAda: Good call. ${send}`);
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).toContain('Good call.');
    expect(h.playing.map((entry) => entry.text)).not.toContain(send);
    expect(h.logs).toContain(`[card] dropped host send-instruction: ${send}`);
    conversation.close();
  });

  it('keeps a colleague line and a host task handed to a named colleague', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 60_000, reviewWindowMs: 60_000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0,
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    await h.say('Ship it.');
    const settled = `KAKI_CONTROL ${JSON.stringify({ state: 'settled',
      followUp: { kind: 'mattermost_post', title: 'Send the card rules' }, wingmanNeeded: false })}`;
    const colleague = 'Send the card rules round to the team in a short note.';
    const toColleague = 'Bao, send the card rules round to the team in a short note.';
    h.calls.at(-1)?.push(`${settled}\nBao: ${colleague}\nAda: ${toColleague}`);
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).toContain(colleague);
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).toContain(toColleague);
    conversation.close();
  });

  it('keeps a host confirmation of what the team will do, while dropping an instruction to the visitor', async () => {
    const h = harness(hostedScenario());
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: hostedScenario(), reviewNudgeMs: 60_000, reviewWindowMs: 60_000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0,
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    await h.say('Ship it.');
    h.conversation.lockDecision();
    await h.flush();
    const settled = `KAKI_CONTROL ${JSON.stringify({ state: 'settled',
      followUp: { kind: 'mattermost_post', title: 'Send the card rules' }, wingmanNeeded: false })}`;
    const confirm = 'Got it, we hold the price and post a note at the counter.';
    const thanks = 'Thanks for sending that update.';
    const instruct = 'Josh, you can post that to the team.';
    h.calls.at(-1)?.push(`${settled}\nAda: ${confirm}\nAda: ${thanks}\nAda: ${instruct}`);
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 6 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain(confirm);
    expect(said).toContain(thanks);
    expect(said).not.toContain(instruct);
    expect(h.logs).toContain(`[card] dropped host send-instruction: ${instruct}`);
    conversation.close();
  });

  it('keeps lines that are not actually sharing the visitor\'s decision', async () => {
    const h = harness();
    await h.say('Go with the price freeze.');
    h.calls.at(-1)?.push(
      'Ada: Let me put it this way, the decision is yours. ' +
        'Ada: I can put the regulars price button on the till once you make the decision. ' +
        "Ada: I'll put Mei on the counter and announce the change to the staff.",
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 6 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain('Let me put it this way, the decision is yours.');
    expect(said).toContain('I can put the regulars price button on the till once you make the decision.');
    expect(said).toContain("I'll put Mei on the counter and announce the change to the staff.");
    expect(h.logs.some((text) => text.startsWith('[owner]'))).toBe(false);
    h.conversation.close();
  });

  it('still drops a colleague promising to share the decision with the team', async () => {
    const h = harness();
    await h.say('Go with the price freeze.');
    h.calls.at(-1)?.push(
      "Ada: I'll post the update to the team. " +
        'Ada: Let me send the decision in the group chat.',
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 6 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said.some((text) => /post the update|send the decision/i.test(text))).toBe(false);
    expect(h.logs.filter((text) => text.startsWith('[owner]'))).toHaveLength(2);
    h.conversation.close();
  });

  it('keeps payment talk that mentions a card without pointing at the visitor\'s card', async () => {
    const h = harness();
    await h.say('How should we take payment?');
    h.calls.at(-1)?.push(
      'Ada: The kiosk takes your card or PayNow. ' +
        'Ada: Seniors show your card at the counter.',
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 6 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain('The kiosk takes your card or PayNow.');
    expect(said).toContain('Seniors show your card at the counter.');
    expect(h.logs.some((text) => text.startsWith('[card] Ada:'))).toBe(false);
    h.conversation.close();
  });

  it('still drops a line that points the visitor at their card or screen', async () => {
    const h = harness();
    await h.say('Where is it?');
    h.calls.at(-1)?.push(
      "Ada: It's on your card on the right. " +
        "Ada: It's on your card when you're ready. " +
        'Ada: Check your screen. ' +
        'Ada: your panel has the draft.',
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 6 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said.some((text) => /your card on the right|your card when|check your screen|your panel has the draft/i.test(text))).toBe(false);
    expect(h.logs.filter((text) => text.startsWith('[card] Ada:'))).toHaveLength(4);
    h.conversation.close();
  });

  it('uses the short spoken name in the move-on warning', async () => {
    const spokenScenario = {
      ...hostedScenario(),
      agenda: hostedScenario().agenda.map((item, index) => (index === 0 ? { ...item, spoken: 'the prep job' } : item)),
    };
    const h = harness(spokenScenario);
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: spokenScenario, reviewNudgeMs: 1000, reviewWindowMs: 3000, responseDelayMs: 0,
      speakerGapMs: 0, sentenceGapMs: 0, replies: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'Producer' });
    conversation.humanSpeech(true);
    conversation.humanText('Ship it.');
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(0);
    h.calls.at(-1)?.push('Ada: Understood.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();
    await vi.advanceTimersByTimeAsync(1000);
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await h.flush();
    expect(h.playing.at(-1)?.text).toBe("Let's leave the prep job there.");
    conversation.close();
  });

  it.each([
    "Josh, the follow-up's on your screen whenever you want to send it.",
    "Josh, the follow-up's still on your screen whenever you're ready.",
  ])('still cancels a pending dispatch that points at the screen: %s', async (line) => {
    const h = harness();
    h.conversation.announce('Ada', line);
    await h.flush();
    expect(h.playing).toHaveLength(1);
    h.conversation.cancelPendingDispatch();
    await h.flush();
    expect(h.playing[0]?.signal.aborted).toBe(true);
    h.conversation.close();
  });

  it('restarts a cut sentence without transcribing or counting it twice', async () => {
    const h = harness();
    const line = 'Anyone new on the till needs a login, and that is about fifteen minutes before opening.';
    await h.say('Tell me about the till.');
    h.calls.at(-1)?.push(`Ada: ${line}`);
    h.calls.at(-1)?.end();
    await h.flush();
    expect(h.playing).toHaveLength(1);
    h.conversation.humanSpeech(true);
    await h.flush();
    expect(h.playing[0]?.signal.aborted).toBe(true);
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.playing.map((p) => p.text)).toEqual([line, line]);
    expect(h.transcript.filter(([, text]) => text === line)).toHaveLength(1);
    expect(h.logs).not.toContainEqual(expect.stringContaining('[repeat] Ada:'));
    h.conversation.close();
  });

  it('drops a model sentence that points at the card or screen, keeps the rest, and logs it', async () => {
    const h = harness();
    await h.say('Go with the price freeze.');
    h.calls.at(-1)?.push("Ada: Right, the price stays. It's on your card there, ready to send. The card machine still works.");
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain('Right, the price stays.');
    expect(said).toContain('The card machine still works.');
    expect(said.some((text) => /your card/i.test(text))).toBe(false);
    expect(h.logs.some((text) => text.startsWith('[card] Ada:'))).toBe(true);
    h.conversation.close();
  });

  it('drops a colleague taking over the visitor\'s follow-up, and logs it', async () => {
    const h = harness();
    await h.say('Go with the price freeze.');
    h.calls.at(-1)?.push(
      'Ada: Right, the price stays. ' +
        "Bao: I'll put the same line in the chat. " +
        'Ada: Bao, can you send that through in the chat? ' +
        "Bao: I’ll post the update to the team.",
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain('Right, the price stays.');
    expect(said.some((text) => /same line in the chat|send that through|post the update/i.test(text))).toBe(false);
    expect(h.logs.filter((text) => text.startsWith('[owner]'))).toHaveLength(3);
    h.conversation.close();
  });

  it('keeps a colleague talking about their own task, not the visitor\'s follow-up', async () => {
    const h = harness();
    await h.say('Anything else for today?');
    h.calls.at(-1)?.push(
      "Ada: I'll print the new price cards. " +
        "Ada: I'll call the supplier. " +
        "Bao: I'll email the supplier about the fridge. " +
        "Bao: I'll check the till login. " +
        "Ada: I'll put a note on the fridge. " +
        "Bao: I can send a message to the supplier.",
    );
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 12 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain("I'll print the new price cards.");
    expect(said).toContain("I'll call the supplier.");
    expect(said).toContain("I'll email the supplier about the fridge.");
    expect(said).toContain("I'll check the till login.");
    expect(said).toContain("I'll put a note on the fridge.");
    expect(said).toContain('I can send a message to the supplier.');
    expect(h.logs.some((text) => text.startsWith('[owner]'))).toBe(false);
    h.conversation.close();
  });

  it('keeps a colleague\'s share when the visitor gave them that job on this topic', async () => {
    const h = harness();
    await h.say('Bao, can you post it in the chat?');
    h.calls.at(-1)?.push("Bao: Right. I'll post it in the chat now.");
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.transcript.map(([, text]) => text)).toContain("I'll post it in the chat now.");
    expect(h.logs.some((text) => text.startsWith('[owner]'))).toBe(false);
    h.conversation.close();
  });

  it('turns a bare-name handover into a spoken handover, and logs it', async () => {
    const h = harness();
    await h.say('What happened overnight?');
    h.calls.at(-1)?.push('Ada: The fridge was off for three hours. Bao.');
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    const said = h.transcript.map(([, text]) => text);
    expect(said).toContain('Bao, over to you.');
    expect(said).not.toContain('Bao.');
    expect(h.logs.some((text) => text.startsWith('[handover] Ada:'))).toBe(true);
    h.conversation.close();
  });

  it('sends no reaction when the turn is aborted before any line plays', async () => {
    const h = harness();
    const reaction = vi.fn();
    h.ports.onReaction = reaction;
    await h.say('Can we get help?');
    h.calls.at(-1)?.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reactions":[{"who":"Ada","emoji":"🙌"}]}\n');
    await h.flush();
    h.conversation.humanText('Never mind.');
    await h.flush();
    expect(h.playing).toHaveLength(0);
    expect(reaction).not.toHaveBeenCalled();
    h.conversation.close();
  });

  it('asks for the brief as a short exchange that starts with the first fact speaker and ends with the host\'s one question', async () => {
    const withThree = {
      ...scenario,
      agenda: [{
        ...scenario.agenda[0]!,
        contested: true,
        briefing: [{
          text: 'The stock arrived late.',
          knownBy: [
            { attendee: 'Bao', why: 'you checked the delivery' },
            { attendee: 'Cai', why: 'you saw it arrive' },
          ],
        }],
        decision: 'how do we cover prep?',
      }],
      npcs: [
        { ...scenario.npcs[0]!, role: 'host' as const },
        scenario.npcs[1]!,
        { attendee: 'Cai', voice: 'v3', personality: 'Practical', agenda: 'Open on time', concerns: ['Supplies'] },
      ],
      attendees: [...scenario.attendees, { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai (Cashier)' }],
    };
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    const cue = String(h.calls[0]?.messages.at(-1)?.content);
    expect(cue).toContain('Begin with "Bao:"');
    expect(cue).toContain('Only Bao speaks before Ada.');
    expect(cue).toContain('two or three short spoken sentences');
    expect(cue).toContain('tells what happened as they saw it');
    expect(cue).toContain('The stock arrived late.');
    expect(cue).toContain('Last, Ada asks Visitor one question from this decision: "how do we cover prep?"');
    expect(cue).toContain('Ask it by name, ask only one question, and let Ada close the turn.');
    expect(cue).toContain('Every line reacts to the line before it');
    expect(cue).toContain('with at most one number');
    expect(cue).toContain('Hold back at least one catch');
    expect(cue).toContain('no stock invitation');
    h.calls[0]?.push('Bao: The stock arrived late. We may delay. Ada: Visitor, how do we cover prep?');
    h.calls[0]?.end();
    await h.flush();
    for (let index = 0; index < 4 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.transcript).toEqual([
      ['Bao', 'The stock arrived late.'],
      ['Bao', 'We may delay.'],
      ['Ada', 'Visitor, how do we cover prep?'],
    ]);
    conversation.close();
  });

  it('lets the host ask the visitor in his own words after the fact speaker', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(1);
    h.calls[0]?.push('Bao: The stock arrived late. We may delay. Ada: Visitor, where would you start?');
    h.calls[0]?.end();
    await h.flush();
    for (let index = 0; index < 4 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.transcript).toEqual([
      ['Bao', 'The stock arrived late.'],
      ['Bao', 'We may delay.'],
      ['Ada', 'Visitor, where would you start?'],
    ]);
    conversation.close();
  });

  it('starts the brief with the first fact speaker and lets the named colleagues react from their angles', async () => {
    const factScenario = {
      ...scenario,
      roles: [...scenario.roles, { id: 'host', label: 'Host', facilitator: true }],
      attendees: [
        ...scenario.attendees,
        { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai (Cashier)' },
        { name: 'Sam', role: 'host', zoomDisplayName: 'Sam (Host)' },
      ],
      agenda: [
        { title: 'Warm-up', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef' as const },
        {
          ...scenario.agenda[0]!,
          title: 'Seats',
          briefing: [{
            text: 'Laptop users took half the seats at the trial.',
            knownBy: [{ attendee: 'Bao', why: 'your crew got shouted at' }],
          }],
          decision: 'how do we keep seats turning?',
          discussion: {
            openingViews: [
              { attendee: 'Ada', angle: 'the floor team' },
              { attendee: 'Cai', angle: 'the breakfast trays' },
            ],
            tradeOffs: [],
          },
        },
      ],
      npcs: [
        scenario.npcs[0]!,
        scenario.npcs[1]!,
        { attendee: 'Cai', voice: 'v3', personality: 'Practical', agenda: 'Open on time', concerns: [] },
        { attendee: 'Sam', role: 'host' as const, voice: 'v4', personality: 'Calm', agenda: 'Keep time', concerns: [] },
      ],
    };
    const h = harness(factScenario);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: factScenario, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'chef' });
    conversation.agendaMoved('Seats');
    await vi.advanceTimersByTimeAsync(1);
    const cue = String(h.calls[0]?.messages.at(-1)?.content);
    expect(cue).toContain('Begin with "Bao:"');
    expect(cue).toContain('Cai answers Bao in one short sentence');
    expect(cue).toContain('"the breakfast trays"');
    expect(cue).toContain('Last, Sam asks Visitor one question from this decision: "how do we keep seats turning?"');
    expect(cue).toContain('Ask it by name, ask only one question, and let Sam close the turn.');
    expect(cue).toContain('Hold back at least one catch');
    expect(cue).not.toContain('Ada answers');
    conversation.close();
  });

  it('gives the food-safety fridge fact to Mei when the guest takes Wei Ling\'s seat', async () => {
    const kopitiam = await loadScenario('kopitiam');
    const scenarioWithGuest = { ...kopitiam, npcs: aiCast(kopitiam, 'Wei Ling') };
    const h = harness();
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: scenarioWithGuest, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Josh', role: 'producer', transcriptName: 'Josh (Operations Director)' });
    conversation.agendaMoved('Food safety complaint before the 9 AM inspection');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    const cue = String(h.calls[0]?.messages.at(-1)?.content);
    expect(cue).toContain('Begin with "Mei:"');
    expect(cue).toContain('Mei tells what happened as they saw it, from "The fridge was off three hours last night');
    expect(cue).toContain('Daniel answers Mei');
    expect(cue).toContain('"A customer who ate here yesterday, before the fridge went off, emailed to say she got sick and had to see a doctor."');
    expect(cue).not.toContain('Daniel tells');
    conversation.close();
  });

  it('logs a brief whose first speaker is not the expected one but does not drop the turn', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(1);
    h.calls[0]?.push('Cai: Supplies are low. Bao: The stock arrived late.');
    h.calls[0]?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.logs).toContainEqual(expect.stringContaining('[brief] first speaker was Cai, expected speaker Bao'));
    expect(h.transcript).toContainEqual(['Cai', 'Supplies are low.']);
    expect(h.transcript).toContainEqual(['Bao', 'The stock arrived late.']);
    conversation.close();
  });

  it('turns a spoken semicolon into two sentences before it is played', async () => {
    const h = harness();
    await h.say('Hello.');
    h.calls.at(-1)?.push('Ada: The till is down; we can still take cash.');
    h.calls.at(-1)?.end();
    await h.flush();
    for (let index = 0; index < 4 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.transcript).toContainEqual(['Ada', 'The till is down. We can still take cash.']);
    expect(h.transcript.every(([, text]) => !text.includes(';'))).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining('[speech] Ada: split a semicolon'));
    h.conversation.close();
  });

  it('uses the pushing colleague alone when no briefing facts are given', async () => {
    const withOwner = {
      ...scenario,
      agenda: [{ ...scenario.agenda[0]!, contested: true, discussion: {
        openingViews: [{ attendee: 'Bao', angle: 'One concern' }, { attendee: 'Cai', angle: 'Another concern' }],
        tradeOffs: [],
      } }],
      attendees: [
        ...scenario.attendees,
        { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai (Cashier)' },
        { name: 'Hal', role: 'host', zoomDisplayName: 'Hal (Host)' },
      ],
      roles: [...scenario.roles, { id: 'host', label: 'Host' }],
      npcs: [
        { attendee: 'Hal', role: 'host' as const, voice: 'v0', personality: 'Calm', agenda: 'Keep time', concerns: [] },
        ...scenario.npcs,
        { attendee: 'Cai', voice: 'v3', personality: 'Practical', agenda: 'Open on time', concerns: [] },
      ],
    };
    const h = harness(withOwner);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withOwner, observeDelayMs: 1, responseDelayMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.messages[0]?.content).toContain('Ada presses the issue hardest');
    const cue = h.calls[0]?.messages.at(-1)?.content;
    expect(cue).toContain('Begin with "Ada:"');
    expect(cue).toContain('Only Ada speaks');
    expect(cue).not.toContain('Bao answers');
  });

  const briefingScenario = () => ({
    ...scenario,
    agenda: [...scenario.agenda, { title: 'Service', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' as const }],
    npcs: [
      { ...scenario.npcs[0]!, role: 'host' as const },
      scenario.npcs[1]!,
      { attendee: 'Cai', voice: 'v3', personality: 'Practical', agenda: 'Open on time', concerns: ['Supplies'] },
    ],
    attendees: [...scenario.attendees, { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai (Cashier)' }],
  });

  it('does not replay a scripted sentence after a wordless cut-in near its end', async () => {
    const h = harness();
    h.ports.clipDurationMs = () => 1_500;
    h.conversation.announce('Ada', 'First, the laptop campers.');
    await h.flush();
    await vi.advanceTimersByTimeAsync(1_400);
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.playing.map((entry) => entry.text)).toEqual(['First, the laptop campers.']);
    expect(h.logs).toContainEqual(expect.stringContaining('scripted cue had finished'));
    h.conversation.close();
  });

  it('resumes only the unspoken words of an interrupted scripted sentence', async () => {
    const h = harness();
    const line = 'Breakfast customers are waiting for a seat at the window.';
    h.conversation.announce('Ada', line);
    await h.flush();
    await vi.advanceTimersByTimeAsync(700);
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.playing).toHaveLength(2);
    expect(h.playing[1]?.text).not.toBe(line);
    expect(h.playing[1]?.text).toContain('Customers are waiting');
    h.conversation.close();
  });

  it('drops a prefetched sentence already spoken by another person before playback', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Service');
    conversation.announce('Ada', 'The stock arrived late at the shop.');
    await h.flush();
    h.calls[0]?.push('Bao: The stock arrived late at the shop. We may need a smaller menu.');
    h.calls[0]?.end();
    await h.flush();
    h.playing[0]?.finish();
    await vi.advanceTimersByTimeAsync(1);
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).toContain('We may need a smaller menu.');
    expect(h.playing.filter((entry) => entry.text === 'The stock arrived late at the shop.')).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('already said by Ada'));
    conversation.close();
  });

  it('aborts an early brief without a spoken sentence and starts a fresh request', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
      briefFirstChunkMs: 100,
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Service');
    conversation.announce('Ada', 'Here is the next issue.');
    await h.flush();
    h.calls[0]?.push('KAKI_CONTROL {"state":"open"}\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls[0]?.signal.aborted).toBe(true);
    h.playing[0]?.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    h.calls[1]?.push('Bao: We need to sort the stock.');
    h.calls[1]?.end();
    await h.flush();
    expect(h.playing.map((entry) => entry.text)).toContain('We need to sort the stock.');
    conversation.close();
  });

  it('lets the pending colleague brief go first and asks the visitor once', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, silencePromptMs: 5, responseDelayMs: 0,
      opening: 'legacy',
      speakerGapMs: 0, sentenceGapMs: 0,
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Service');
    conversation.announce('Ada', 'Let me set the scene.');
    await vi.advanceTimersByTimeAsync(20);
    expect(h.calls).toHaveLength(1);
    h.playing[0]?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toHaveLength(1);
    expect(h.playing.filter((entry) => entry.speaker === 'Ada')).toHaveLength(1);
    h.calls[0]?.push('Bao: The stock arrived late. Visitor, where would you start? Visitor, what would you do?');
    h.calls[0]?.end();
    await h.flush();
    for (let index = 0; index < 4; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.playing.map((entry) => entry.text)).toContain('Visitor, where would you start?');
    expect(h.playing.map((entry) => entry.text)).not.toContain('Visitor, what would you do?');
    expect(h.playing.filter((entry) => entry.text.endsWith('?'))).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('dropped a second question'));
    conversation.close();
  });

  it('reports an upcoming colleague brief so the host does not invite the visitor first', () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0,
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Service');
    expect(conversation.briefsOnTopic('Service')).toBe(true);
    conversation.close();
  });

  it('starts the brief request while the host is still speaking, then plays it after the host', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'Guest' });
    conversation.agendaMoved('Service');
    conversation.announce('Ada', "Right, let's move on to Service.");
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.playing.at(-1)).toMatchObject({ speaker: 'Ada' });
    h.calls[0]?.push('Bao: The stock arrived late. We may delay.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.transcript.filter(([speaker]) => speaker === 'Bao')).toEqual([]);
    h.playing.at(-1)?.finish();
    await vi.advanceTimersByTimeAsync(1);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    for (let index = 0; index < 4 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.transcript).toEqual([
      ['Ada', "Right, let's move on to Service."],
      ['Bao', 'The stock arrived late.'],
      ['Bao', 'We may delay.'],
      ['Ada', 'How would you handle that, Visitor?'],
    ]);
    conversation.close();
  });

  it('starts fetching the next topic brief while the current topic winds down', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy', replies: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'chef' });

    // Topic 1 briefs and is settled by the visitor.
    conversation.agendaMoved('Prep');
    await vi.advanceTimersByTimeAsync(1);
    h.calls[0]?.push('Bao: The stock arrived late. We may delay.');
    h.calls[0]?.end();
    await h.flush();
    for (let index = 0; index < 5 && h.playing.at(-1) !== undefined; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    conversation.humanTyped('Use the window bar.');
    await vi.advanceTimersByTimeAsync(900);
    h.calls.at(-1)?.push('Bao: Agreed.');
    h.calls.at(-1)?.end();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    conversation.lockDecision();
    await h.flush();

    // The Service brief request is already running before the host says a word about moving on.
    const serviceBrief = h.calls.find((call) =>
      String(call.messages.at(-1)?.content).includes('We just started "Service"'));
    expect(serviceBrief).toBeDefined();
    expect(h.playing.some((entry) => entry.text.includes('Service'))).toBe(false);

    // Sam moves on; the brief streams early and is ready the moment his line ends.
    conversation.agendaMoved('Service');
    conversation.announce('Ada', "Right, let's move on to Service.");
    await h.flush();
    serviceBrief!.push('Bao: The regulars walked out over the new price.\n');
    await h.flush();
    expect(h.transcript).not.toContainEqual(['Bao', 'The regulars walked out over the new price.']);
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.transcript).toContainEqual(['Bao', 'The regulars walked out over the new price.']);
    conversation.close();
  });

  it('never repeats a canned guest invitation across two topics', async () => {
    const withThree = briefingScenario();
    const h = harness(withThree);
    const conversation = new NpcConversation<Utterance>(h.ports, {
      scenario: withThree, observeDelayMs: 1, responseDelayMs: 0, speakerGapMs: 0, sentenceGapMs: 0,
      opening: 'legacy',
    });
    conversation.setHuman({ name: 'Visitor', role: 'chef' });
    const invitations: string[] = [];
    for (const [title, line] of [['Prep', 'Bao: First problem.'], ['Service', 'Bao: Second problem.']] as const) {
      conversation.agendaMoved(title);
      await vi.advanceTimersByTimeAsync(1);
      const call = h.calls.at(-1)!;
      call.push(line);
      call.end();
      await h.flush();
      for (let index = 0; index < 4 && h.playing.at(-1) !== undefined; index += 1) {
        h.playing.at(-1)?.finish();
        await h.flush();
      }
      const invitation = h.transcript.at(-1);
      expect(invitation?.[1].endsWith('?')).toBe(true);
      invitations.push(invitation![1]);
    }
    expect(invitations).toHaveLength(2);
    expect(invitations[0]).not.toBe(invitations[1]);
    conversation.close();
  });

  it('does not cut the room off for a short burst of noise, but does for a person who keeps talking', async () => {
    const { conversation, calls, playing, flush, say } = harness(scenario, 900);
    await say('Hello.');
    calls.at(-1)?.push('Ada: Morning.');
    calls.at(-1)?.end();
    await flush();
    expect(playing).toHaveLength(1);

    // A burst well under the threshold, and recognition hears nothing: the room carries on.
    conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(500);
    conversation.humanSpeech(false);
    conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(3000);
    expect(playing[0]?.signal.aborted).toBe(false);
    expect(calls).toHaveLength(1);

    // The person keeps talking: now it stops.
    conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(playing[0]?.signal.aborted).toBe(true);
  });

  it('holds a short burst whose words are recognised instead of cutting the room off', async () => {
    const { conversation, calls, playing, flush, say } = harness(scenario, 900);
    await say('Hello.');
    calls.at(-1)?.push('Ada: Morning.');
    calls.at(-1)?.end();
    await flush();
    const before = calls.length;
    conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(400);
    conversation.humanSpeech(false);
    conversation.humanText('Wait, hold on.');
    await flush();
    // Words alone never cut a line off; only the voice-timing barge-in does. The line is held, not dropped.
    expect(playing[0]?.signal.aborted).toBe(false);
    expect(calls).toHaveLength(before);

    playing[0]?.finish();
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    await flush();
    expect(calls).toHaveLength(before + 1);
    conversation.close();
  });

  const hostedScenario = () => ({
    ...scenario,
    roles: [
      ...scenario.roles,
      { id: 'producer', label: 'Producer', card: { youAre: 'You are Josh.', facts: ['A fact.'], responsibility: 'You decide what ships.' } },
    ],
    agenda: scenario.agenda.map((item, index) => (index === 0 ? { ...item, decision: 'do we ship it or hold it?', contested: true } : item)),
    npcs: [{ ...scenario.npcs[0]!, role: 'host' as const }, scenario.npcs[1]!],
  });

  it('has an AI host ask the person for their call when the agenda moves on, in its own words, once', async () => {
    const { conversation, calls, playing, transcript, say, flush } = harness(hostedScenario());
    for (const line of ['One.', 'Two.', 'Three.', 'Four.', 'Five.']) {
      await say(line);
      calls.at(-1)?.push('NONE');
      calls.at(-1)?.end();
    }
    // Five lines is not a reason to ask: nothing has moved on.
    expect(playing.some((entry) => entry.text.includes('do we ship it or hold it'))).toBe(false);
    conversation.agendaMoved(scenario.agenda[0]!.title);
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(playing.at(-1)).toMatchObject({ speaker: 'Ada', text: 'Josh, do we ship it or hold it?' });
    expect(transcript.at(-1)).toEqual(['Ada', 'Josh, do we ship it or hold it?']);
    // The model is never told to say it: nothing in its messages mentions the question.
    expect(JSON.stringify(calls.map((call) => call.messages))).not.toContain('Josh, do we ship it or hold it?');
    // Asked once: moving on again does not ask again.
    const count = playing.length;
    conversation.agendaMoved('Publisher milestone');
    await vi.advanceTimersByTimeAsync(5000);
    expect(playing.length).toBe(count);
  });


  it('tells the model which agenda item the meeting is on', async () => {
    const { conversation, calls, say } = harness(hostedScenario());
    conversation.agendaMoved('Level 5 difficulty');
    await say('Hello.');
    expect(String(calls.at(-1)?.messages.at(0)?.content)).toContain('agenda item "Level 5 difficulty"');
  });

  it('asks as a backstop after many lines even if the agenda never moves', async () => {
    const { calls, playing, say, flush } = harness(hostedScenario());
    for (let n = 1; n <= 7; n += 1) {
      await say(`Line ${n}.`);
      calls.at(-1)?.push('NONE');
      calls.at(-1)?.end();
    }
    expect(playing.some((entry) => entry.text.includes('do we ship it or hold it'))).toBe(false);
    await say('Line 8.');
    calls.at(-1)?.push('NONE');
    calls.at(-1)?.end();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(playing.some((entry) => entry.text === 'Josh, do we ship it or hold it?')).toBe(true);
  });

  it('answers once the person has stopped talking, speaking each sentence in order', async () => {
    const { conversation, calls, playing, states, transcript, flush, say } = harness();

    await say('Hello team.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages.at(0)?.content).toContain('Calm chef');
    expect(calls[0]?.messages.at(0)?.content).toContain('Josh, the Producer');
    expect(calls[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Hello team.' });
    expect(states.at(-1)).toEqual({ kind: 'thinking', canLock: true });

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
    expect(states.map((s) => s.kind)).toEqual(['idle', 'thinking', 'speaking', 'speaking', 'speaking', 'idle']);
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
    await say('Give me the status.');
    calls[0]?.push('Ada: The build is red. We have a crash.\nBao: I can help with that.');
    calls[0]?.end();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['The build is red.']);

    // The person starts talking while the first sentence is still playing.
    conversation.humanSpeech(true);
    expect(playing[0]?.signal.aborted).toBe(true);
    // Sound alone does not cancel the model: the turn is held in case no words follow.
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });
    await flush();
    expect(playing).toHaveLength(1); // nothing else started

    conversation.humanText('Hold on, the crash is only on Android.');
    expect(calls[0]?.signal.aborted).toBe(true);
    conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(900);

    const messages = calls[1]?.messages ?? [];
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: expect.stringContaining('Give me the status.') },
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
    expect(states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });

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

    expect(calls[1]?.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('okay can we end the meeting now') });
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
    expect(states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });

    await say('Okay, real question now.');
    await flush();
    expect(calls[1]?.messages.slice(1).map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('retries a failed model call once, keeping the visitor request, then recovers when the retry answers', async () => {
    const { conversation, calls, playing, states, flush, say, logs } = harness();
    await say('Can we move the launch to Friday?');
    calls[0]?.fail(new Error('LLM request failed: timed out after 20000 ms'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(states.some((state) => state.kind === 'error')).toBe(false);
    expect(conversation.busy).toBe(true);
    // The retry answers the same request: it is in the history once, and nothing new was invented.
    const requestLines = calls[1]?.messages.filter((message) => message.role === 'user') ?? [];
    expect(requestLines.map((message) => message.content)).toEqual(['Can we move the launch to Friday?']);
    expect(logs.some((line) => line.includes('retrying the same request'))).toBe(true);

    calls[1]?.push('Bao: Sorry about that. Friday works.');
    calls[1]?.end();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['Sorry about that.']);
    playing[0]?.finish();
    await flush();
    expect(playing.map((p) => p.text)).toEqual(['Sorry about that.', 'Friday works.']);
  });

  it('speaks a natural recovery cue when the retry fails too, then keeps the room moving without repeating it', async () => {
    const { conversation, calls, playing, states, transcript, flush, say } = harness();
    conversation.setHuman({ name: 'Josh', role: 'chef' });
    await say('Can we move the launch to Friday?');
    calls[0]?.fail(new Error('LLM request failed: timed out after 20000 ms'));
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.fail(new Error('LLM request failed: timed out after 20000 ms'));
    await flush();

    // No raw error and no endless retry: the host asks the visitor to repeat their request.
    expect(calls).toHaveLength(2);
    expect(states.some((state) => state.kind === 'error')).toBe(false);
    expect(playing).toHaveLength(1);
    expect(playing[0]?.speaker).toBe('Ada');
    expect(playing[0]?.text).toContain('say that again');
    expect(transcript.at(-1)?.[1]).toContain('say that again');
    playing[0]?.finish();
    await conversation.settled();

    // The cue re-arms the silence prompt instead of leaving the room quiet for good.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThan(2);

    // Models still down: the host line is not repeated on every failed turn.
    calls.at(-1)?.fail(new Error('still down'));
    await flush();
    calls.at(-1)?.fail(new Error('still down'));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(playing.filter((entry) => entry.text.includes('say that again'))).toHaveLength(1);

    // Their original request is still in the history, so repeating it is answered with both lines in context.
    const before = calls.length;
    await say('Can we move the launch to Friday?');
    expect(calls).toHaveLength(before + 1);
    const last = calls.at(-1)!;
    const userLines = last.messages.filter((message) => message.role === 'user').map((message) => message.content);
    expect(userLines.filter((line) => line === 'Can we move the launch to Friday?')).toHaveLength(2);
    expect(last.messages.some((message) => message.role === 'assistant' && message.content.includes('say that again'))).toBe(
      true,
    );
  });

  it('drops the failed-request recovery when the person says something new during the retry', async () => {
    const { conversation, calls, playing, flush, say } = harness();
    await say('Can we move the launch to Friday?');
    calls[0]?.fail(new Error('LLM request failed: timed out after 20000 ms'));
    await flush();
    expect(calls).toHaveLength(2);

    conversation.humanTyped('Actually, second question.');
    expect(calls[1]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('Actually, second question.') });
    expect(playing.some((entry) => entry.text.includes('say that again'))).toBe(false);
  });

  it('keeps what was said before a model failure part-way through', async () => {
    const { conversation, calls, playing, states, logs, flush, say } = harness();
    await say('Hello, I am here.');
    calls[0]?.push('Ada: First part. Seco');
    await flush();
    calls[0]?.fail(new Error('boom'));
    await flush();
    playing[0]?.finish();
    await conversation.settled();
    // Something was heard, so it must not be repeated and no recovery cue is added.
    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });
    expect(playing.map((p) => p.text)).toEqual(['First part.']);
    expect(logs).toContainEqual(expect.stringMatching(/^\[stream-cut\] Ada: reply stopped after 1 sentences: boom$/));
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
      replies: 'legacy',
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

  it('carries on a held answer after a wordless cut-in, and answers new words instead when they arrive', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: Morning Josh. Ready when you are.');
    h.calls[0]?.end();
    await h.flush();
    // Something was said aloud, then the person talks over it and says nothing recognisable.
    h.conversation.humanSpeech(true);
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.calls).toHaveLength(1); // the held lines carry on with no new model call
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(1);

    const second = harness();
    await second.say('First question.');
    second.conversation.humanSpeech(true);
    second.conversation.humanText('Actually, never mind.');
    second.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(second.calls).toHaveLength(2);
  });

  it('carries on held lines when the person cuts in but says nothing, and answers words instead', async () => {
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
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('cut-in had no words: carrying on held lines'))).toBe(true);
    expect(h.playing.map((p) => p.text)).toEqual(['Morning Josh.', 'Morning Josh.']);
    h.playing.at(-1)?.finish();
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    await h.conversation.settled();

    // This time they say something: that is answered with a new model call, with no "carry on" note.
    await h.say('Actually, wait.');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('Actually, wait.') });
    expect(h.calls[1]?.messages.at(-1)?.content).not.toContain('made a sound');
  });

  it('carries on held lines quickly when recognition says a cut-in held no words', async () => {
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
    expect(h.calls).toHaveLength(1);
    expect(h.playing.map((p) => p.text)).toEqual(['Morning Josh.', 'Morning Josh.']);
    // Nothing to carry on from when no answer was cut off.
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(1);
  });

  it('pauses a model turn cut by sound and plays its unsaid lines without asking the model again', async () => {
    const h = harness();
    await h.say('Give me the status.');
    h.calls[0]?.push('Ada: The build is red. We have a crash.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.']);

    h.conversation.humanSpeech(true);
    expect(h.playing[0]?.signal.aborted).toBe(true);
    expect(h.calls[0]?.signal.aborted).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('held 2 unsaid lines'));

    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.stringContaining('cut-in had no words: carrying on held lines'));
    expect(h.playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual([
      'Ada: The build is red.', 'Ada: The build is red.',
    ]);

    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.', 'The build is red.', 'We have a crash.']);
    h.playing.at(-1)?.finish();
    await h.flush();
    await h.conversation.settled();
    expect(h.calls).toHaveLength(1);

    await h.say('Thanks.');
    expect(h.calls).toHaveLength(2);
    const history = h.calls[1]!.messages.slice(1);
    expect(history).toContainEqual({ role: 'assistant', content: 'Ada: The build is red.\nAda: We have a crash.' });
    expect(JSON.stringify(history)).not.toContain('[cut off]');
    h.conversation.close();
  });

  it('logs the microphone and echo levels when sound alone cuts a turn', async () => {
    const h = harness();
    h.ports.describeMic = () =>
      'mic peak 0.184 in the last 3 s, bar to count as talking 0.040, AI level 0.120, its echo in the mic 0.070';
    await h.say('Give me the status.');
    h.calls[0]?.push('Ada: The build is red.');
    h.calls[0]?.end();
    await h.flush();
    h.conversation.humanSpeech(true);
    expect(h.logs).toContainEqual(expect.stringContaining('mic peak 0.184'));
    expect(h.logs).toContainEqual(expect.stringContaining('its echo in the mic 0.070'));
    h.conversation.close();
  });

  it('drops the held lines when real words arrive after a sound-only cut', async () => {
    const h = harness();
    await h.say('Give me the status.');
    h.calls[0]?.push('Ada: The build is red. We have a crash.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.']);

    h.conversation.humanSpeech(true);
    expect(h.calls[0]?.signal.aborted).toBe(false);
    h.conversation.humanSpeech(false);
    h.conversation.humanText('Hold on, only on Android.');
    expect(h.calls[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(900);

    expect(h.calls).toHaveLength(2);
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.']);
    const history = h.calls[1]!.messages.slice(1);
    expect(history[1]).toEqual({
      role: 'assistant',
      content: 'Ada: The build is red. [cut off]\n[Josh interrupted here; nothing after this was said aloud.]',
    });
    expect(history.at(-1)).toEqual({ role: 'user', content: 'Hold on, only on Android.' });
    expect(h.logs.join('\n')).not.toContain('cut-in had no words');
    h.conversation.close();
  });

  it('keeps and plays lines the model writes while a sound-only cut holds the turn', async () => {
    const h = harness();
    await h.say('Give me the status.');
    h.calls[0]?.push('Ada: The build is red.\n');
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.']);

    h.conversation.humanSpeech(true);
    expect(h.playing[0]?.signal.aborted).toBe(true);
    // The model is still writing while the turn is held: those later lines must be kept.
    h.calls[0]?.push('Bao: I can help with that.\n');
    h.calls[0]?.push('Ada: We should ship the fix today.\n');
    await h.flush();

    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.', 'The build is red.']);

    for (let index = 0; index < 5; index += 1) {
      h.playing.at(-1)?.finish();
      await h.flush();
    }
    expect(h.playing.map((p) => p.text)).toEqual([
      'The build is red.', 'The build is red.', 'I can help with that.', 'We should ship the fix today.',
    ]);
    h.calls[0]?.end();
    await h.flush();
    await h.conversation.settled();
    expect(h.calls).toHaveLength(1);
    h.conversation.close();
  });

  it('does not go silent when the model stream fails while a turn is held', async () => {
    const h = harness();
    await h.say('Give me the status.');
    h.calls[0]?.push('Ada: The build is red.\n');
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['The build is red.']);

    h.conversation.humanSpeech(true);
    expect(h.playing[0]?.signal.aborted).toBe(true);
    h.calls[0]?.fail(new Error('model died'));
    await h.flush();

    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(400);
    // The held stream is gone: the room asks the model to carry on instead of waiting forever.
    expect(h.calls).toHaveLength(2);

    h.calls[1]?.push('Ada: The build is red, and we have a crash.');
    h.calls[1]?.end();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toContain('The build is red, and we have a crash.');
    h.conversation.close();
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

  it('goes quiet on Stop and stays quiet: no carrying on, no retry, and resumes when asked', async () => {
    const h = harness();
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: One.\nBao: Two.');
    h.calls[0]?.end();
    await h.flush();
    // Ada finishes her sentence; Bao starts speaking and gets cut off by Stop.
    h.playing[0]?.finish();
    await vi.advanceTimersByTimeAsync(1500);
    await h.flush();
    expect(h.playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual(['Ada: One.', 'Bao: Two.']);
    h.conversation.stop();
    expect(h.playing[1]?.signal.aborted).toBe(true);
    // While paused, any speech from the microphone is completely ignored until Resume is pressed.
    h.conversation.humanSpeech(true);
    h.conversation.humanText('Talking to someone at the booth while paused.');
    h.conversation.humanSpeech(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
    expect(h.states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });
    // Resuming replays the exact unfinished sentence from the interrupted speaker (Bao) without jumping speakers.
    h.conversation.resumeFromPause();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.playing.map((p) => `${p.speaker}: ${p.text}`)).toEqual(['Ada: One.', 'Bao: Two.', 'Bao: Two.']);
    h.playing[2]?.finish();
    await h.conversation.settled();
    // And it still answers the next thing said.
    await h.say('Thanks.');
    expect(h.calls).toHaveLength(2);
  });

  it('carries on held lines when bargeInMs cuts off a speaker and recognition hears no words, without letting an announcement jump in first', async () => {
    const h = harness(scenario, 900);
    await h.say('Hello team.');
    h.calls[0]?.push('Ada: The build has a crash issue when serving 10 customers.');
    h.calls[0]?.end();
    await h.flush();
    expect(h.playing).toHaveLength(1);

    // A noise lasts past bargeInMs, then stops with no recognised words; meanwhile a host announcement is queued.
    h.conversation.humanSpeech(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.playing[0]?.signal.aborted).toBe(true);
    h.conversation.announce('Ada', 'Can you take that ticket?');
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(500);
    // The held speaker resumes first; the announcement waits until the turn finishes.
    expect(h.calls).toHaveLength(1);
    expect(h.playing.map((p) => p.text)).toEqual([
      'The build has a crash issue when serving 10 customers.',
      'The build has a crash issue when serving 10 customers.',
    ]);
    h.playing.at(-1)?.finish();
    await h.flush();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.playing.map((p) => p.text)).toContain('Can you take that ticket?');
  });

  it('resumes the remaining sentences of a scripted cue after Stop and Resume', async () => {
    const h = harness();
    let finished = false;
    h.conversation.announce('Ada', 'First sentence. Second sentence.', undefined, () => {
      finished = true;
    });
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['First sentence.']);
    h.playing[0]?.finish();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['First sentence.', 'Second sentence.']);
    // Stop while the second sentence is playing.
    h.conversation.stop();
    expect(h.playing[1]?.signal.aborted).toBe(true);
    expect(finished).toBe(false);
    // Resume replays the unfinished second sentence and then calls onDone.
    h.conversation.resumeFromPause();
    await h.flush();
    expect(h.playing.map((p) => p.text)).toEqual(['First sentence.', 'Second sentence.', 'Second sentence.']);
    h.playing[2]?.finish();
    await h.conversation.settled();
    expect(finished).toBe(true);
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



    it('freezes the conversation after announceClosing so trailing speech cannot restart it', async () => {
      const h = harness();
      h.conversation.announceClosing('Ada', 'That concludes our meeting.');
      await h.flush();
      h.playing[0]?.finish();
      await h.conversation.settled();
      await h.say('Hello, anyone still here?');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.calls).toHaveLength(0);
    });



    it('clears cutOff when real speech arrives after a barge-in so humanNothing cannot trigger a stale resume', async () => {
      const h = harness();
      await h.say('What is the plan?');
      h.calls[0]?.push('Ada: Here is the first sentence. Here is the second sentence.');
      h.calls[0]?.end();
      await h.flush();
      expect(h.playing).toHaveLength(1);
      // Barge in while Ada is speaking sentence 1.
      h.conversation.humanSpeech(true);
      await vi.advanceTimersByTimeAsync(1500);
      h.conversation.humanSpeech(false);
      // Real speech arrives right after stopping talking:
      h.conversation.humanText('Hold on, let us check the cost.');
      // A trailing humanNothing from a throat clear must NOT trigger a "[made a sound]" resume:
      h.conversation.humanNothing();
      await vi.advanceTimersByTimeAsync(2000);
      const lastCallMessages = JSON.stringify(h.calls.at(-1)?.messages ?? []);
      expect(lastCallMessages).toContain('Hold on, let us check the cost.');
      expect(lastCallMessages).not.toContain('made a sound');
    });

    it('logs a shadow planner decision after heard guest and room lines without acting on it', async () => {
      const h = harness();
      await h.say('Ada, what happened?');
      expect(h.logs.some((line) => line.startsWith('[planner] '))).toBe(true);

      h.calls[0]?.push('Ada: We are short today.');
      h.calls[0]?.end();
      await h.flush();
      h.playing[0]?.finish();
      await h.flush();

      const planner = h.logs.filter((line) => line.startsWith('[planner] '));
      expect(planner.length).toBeGreaterThanOrEqual(2);
      expect(planner.every((line) => /^\[planner\] .+ because .+$/.test(line))).toBe(true);
      expect(h.transcript.filter(([speaker]) => speaker === 'Ada').map(([, text]) => text)).toEqual(['We are short today.']);
    });

  });

});

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
    attendees: [...base.attendees, { name: 'Sam', role: 'host', zoomDisplayName: 'Sam (Host)' }],
    npcs: [
      ...base.npcs,
      { attendee: 'Sam', voice: 'v0', role: 'host' as const, personality: 'Calm', agenda: 'Keep time', concerns: [] },
    ],
  });

  it('answers a substantive guest line with one planned speaker, then waits for the guest', async () => {
    const h = harness(withColleagueHost(scenario), 0, undefined, 'one-speaker');
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
    const h = harness(scenario, 0, undefined, 'one-speaker');
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
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
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
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
    await h.say('Ada, let us call Auntie Mary in.');
    await waitForCall(h, 0);
    await reply(h, 'Ada: That could work.');
    await waitForCall(h, 1);
    await reply(h, 'Bao: Calling her in means double pay for her rest day.');

    expect(h.transcriptOptions).toContainEqual([
      'Bao',
      'Calling her in means double pay for her rest day.',
      { catchId: '0:catch:0' },
    ]);
    h.conversation.close();
  });

  it('answers a terse yes instead of treating it as filler', async () => {
    const h = harness(withColleagueHost(scenario), 0, undefined, 'one-speaker', () => ({
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
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
    await h.say('Ada, let us call Auntie Mary in.');
    const first = await waitForCall(h, 0);
    first.push('Ada: That could work.');
    first.end();
    await h.flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);
    const prefetched = await waitForCall(h, 1);

    h.conversation.humanTyped('Wait, what about the till?');
    await h.flush();
    expect(prefetched.signal.aborted).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining('[reply] cancelled: the guest typed'));
    expect(h.transcript.some(([speaker]) => speaker === 'Bao')).toBe(false);
    h.conversation.close();
  });

  it('rejects a prefetched reply whole before any of it plays, then retries fresh', async () => {
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
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
    const h = harness(scenario, 0, undefined, 'one-speaker', () => ({
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
    await reply(h, 'KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: Fine, we will pay the double pay.');

    expect(settleTopic).not.toHaveBeenCalled();
    expect(h.logs).toContainEqual(expect.stringContaining('[control] ignored model settle; readiness decides'));
    expect(h.transcript).toContainEqual(['Ada', 'Fine, we will pay the double pay.']);
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
    const h = harness(factScenario, 0, undefined, 'one-speaker');
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
    const h = harness(factScenario, 0, undefined, 'one-speaker', () => ({
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
    const h = harness(scenario, 0, undefined, 'one-speaker');
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
    const h = harness(catchScenario, 0, undefined, 'one-speaker');
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
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
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
    const h = harness(withColleagueHost(catchScenario), 0, undefined, 'one-speaker');
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
      attendees: [...scenario.attendees, { name: 'Cai', role: 'cashier', zoomDisplayName: 'Cai' }],
    };
    const h = harness(withCai, 0, undefined, 'one-speaker');
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
    const h = harness(catchScenario, 0, undefined, 'one-speaker');
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
    const h = harness(catchScenario, 0, undefined, 'one-speaker');
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
    const h = harness(scenario, 0, undefined, 'one-speaker',
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
    const h = harness(factScenario, 0, undefined, 'one-speaker', () => readyQuestion,
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
    const h = harness(factScenario, 0, undefined, 'one-speaker', () => readyQuestion,
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
    const h = harness(scenario, 0, undefined, 'one-speaker', () => readyFor('Old price only on the small cup'), {
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
    h.conversation.humanTyped('No, signs only this morning.');
    await h.flush();
    releaseGate?.();
    await h.flush();

    expect(h.playing.some((entry) => entry.text === 'Josh, is that your call?')).toBe(false);
    expect(h.transcript.some(([, text]) => text === 'Josh, is that your call?')).toBe(false);
    expect(h.logs).not.toContainEqual('[confirm] read-back: Josh, is that your call?');
    h.conversation.close();
  });

  it('keeps the open question when settling fails, so the room does not treat it as answered', async () => {
    const readerInputs: GuestReaderInput[] = [];
    const h = harness(scenario, 0, undefined, 'one-speaker', (input) => {
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

    h.conversation.humanTyped('Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    expect(settleTopic).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(expect.stringContaining('could not create follow-up'));

    h.conversation.humanTyped('Yes, old price still.');
    await h.flush();
    expect(readerInputs.at(-1)?.openQuestion?.text).toBe('Josh, who covers the counter?');
    h.conversation.close();
  });

  it('clears a stale open question on settle so the card nudge is not blocked', async () => {
    const h = harness(scenario, 0, undefined, 'one-speaker', () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    h.conversation.announce('Bao', 'Josh, who covers the counter?');
    await h.flush();
    h.playing.at(-1)?.finish();
    await h.flush();
    expect(h.transcript).toContainEqual(['Bao', 'Josh, who covers the counter?']);

    h.conversation.humanTyped('Old price only on the small cup.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    h.conversation.taskStatus('task-1', scenario.agenda[0]!.title, 'DISPATCHED', true);

    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(h.logs).not.toContainEqual(expect.stringContaining('skipped the review nudge while a question to the guest is open'));
    expect(h.transcript.some(([, text]) => /the follow-up's on your screen/i.test(text))).toBe(true);
    h.conversation.close();
  });

  it('moves on without a pointer when no TASK_UPDATED card arrives', async () => {
    const h = harness(scenario, 0, undefined, 'one-speaker', () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    h.conversation.humanTyped('Old price only on the small cup.');
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

  it('points at a card that arrives while the no-card wrap-up is still queued', async () => {
    const h = harness(scenario, 0, undefined, 'one-speaker', () => readyFor('Old price only on the small cup'),
      { reviewNudgeMs: 1000, reviewWindowMs: 3000, silencePromptMs: 600_000, topicTimeBudgetMs: 600_000 });
    h.conversation.setHuman({ name: 'Josh', role: 'chef' });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);
    const advanceAgenda = vi.fn();
    h.ports.advanceAgenda = advanceAgenda;

    h.conversation.humanTyped('Old price only on the small cup.');
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

    expect(h.transcript.some(([, text]) => /the follow-up's on your screen/i.test(text))).toBe(true);
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
    const h = harness(scenario, 0, undefined, 'one-speaker',
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
    const h = harness(scenario, 0, undefined, 'one-speaker',
      (input) => (input.line.toLowerCase().includes('old price') ? ready : vague),
      { topicTimeBudgetMs: 600_000 });
    h.ports.settleTopic = vi.fn().mockResolvedValue(undefined);

    await h.say('We should do something.');
    await reply(h, 'KAKI_CONTROL {"state":"settled","followUp":{"kind":"mattermost_post","title":"Share the plan"},"wingmanNeeded":false}\nAda: Let us look at the counter first.');
    await h.say('Old price only on the small cup.');
    await finishPlaying(h);

    const confirmations = h.transcript.filter(([speaker, text]) => speaker === 'Ada' && text.includes("That's the call?"));
    expect(confirmations).toHaveLength(1);
    expect(h.transcript.some(([, text]) => text.toLowerCase().includes('shall we lock in'))).toBe(false);
    h.conversation.close();
  });

  it('reads the guest call back in plain words, with no quotes and no extra direction', async () => {
    const written = "So it's signs only this morning, and we leave the sockets alone. That's the call?";
    const h = harness(withDirections(['Raise the app price.']), 0, undefined, 'one-speaker',
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
    const h = harness(withDirections(['Raise the app price.']), 0, undefined, 'one-speaker',
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
      0, undefined, 'one-speaker',
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
    const h = harness(withDirections([]), 0, undefined, 'one-speaker',
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
    const h = harness(withDirections(['Ask Auntie Mary to come in.']), 0, undefined, 'one-speaker',
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
    const h = harness(catchScenario, 0, undefined, 'one-speaker', (input) => {
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
    const h = harness(scenario, 60_000, undefined, 'one-speaker', (input) =>
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
      attendees: [...scenario.attendees, { name: 'Sam', role: 'host', zoomDisplayName: 'Sam (Host)' }],
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
    const h = harness(samHosted, 0, undefined, 'one-speaker', async (input) => {
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
    const h = harness(withColleagueHost(twoItems), 0, undefined, 'one-speaker', () => ready);
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
    await reply(h, 'KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reopen":"Prep"}\nAda: Changing that means extra setup.');
    expect(h.conversation.onCurrentAgenda('Prep')).toBe(true);

    h.conversation.humanTyped('Use the revised plan.');
    await h.flush();
    h.conversation.lockDecision(undefined, { confirmed: true });
    await h.flush();
    expect(h.conversation.onCurrentAgenda('Service')).toBe(true);

    const beforeAgain = h.calls.length;
    await h.say('Actually, change Prep again.');
    const reopenedAgain = await waitForCall(h, beforeAgain);
    const callsAfterAgain = h.calls.length;
    reopenedAgain.push('KAKI_CONTROL {"state":"open","wingmanNeeded":false,"reopen":"Prep"}\nAda: I will change it again.');
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
