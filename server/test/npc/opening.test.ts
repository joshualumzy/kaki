import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiCast, humanRoles, type Scenario } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import { NpcConversation, type NpcPorts } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { gateSpeakerMessages, parseGateReply, parsePlannedReply, replySpeakerMessages } from '../../src/npc/openingWriter';
import { loadScenario } from '../../src/loadScenario';

interface LlmCall {
  messages: ChatMessage[];
  signal: AbortSignal;
  push(chunk: string): void;
  end(): void;
}

interface Playing {
  speaker: string;
  text: string;
  signal: AbortSignal;
  finish(): void;
  finished: boolean;
}

interface ExpectedStep {
  speaker: string;
  facts: string[];
  invite?: boolean;
}

function harness(scenarioUsed: Scenario, role: string, options: {
  responseDelayMs?: number;
  bargeInMs?: number;
  silencePromptMs?: number;
  silenceNudgeLeadMs?: number;
  failPlaybackFor?: string;
} = {}) {
  const calls: LlmCall[] = [];
  const playing: Playing[] = [];
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
      return new Promise<void>((resolve, reject) => {
        if (options.failPlaybackFor !== undefined && clip.text.includes(options.failPlaybackFor)) {
          reject(new Error('playback failed'));
          return;
        }
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
    emitState: () => undefined,
    log: (message) => logs.push(message),
    settleTopic: () => undefined,
  };
  const conversation = new NpcConversation<Utterance>(ports, {
    scenario: scenarioUsed,
    responseDelayMs: options.responseDelayMs ?? 0,
    speakerGapMs: 0,
    sentenceGapMs: 0,
    observeDelayMs: 0,
    bargeInMs: options.bargeInMs ?? 0,
    resumeMs: 0,
    briefFirstChunkMs: 5_000,
    ...(options.silencePromptMs === undefined ? {} : { silencePromptMs: options.silencePromptMs }),
    ...(options.silenceNudgeLeadMs === undefined ? {} : { silenceNudgeLeadMs: options.silenceNudgeLeadMs }),
    readGuestLine: async () => ({
      kind: 'agree',
      answersOpenQuestion: false,
      relevantFactIds: [],
      relevantCatchIds: [],
      readiness: {
        action: { covered: false },
        catchAddressed: { covered: false },
        practical: { covered: false },
      },
    }),
    gateStream: (request) => (async function* () {
      const lower = request.call.length === 0 ? request.call : `${request.call[0]!.toLowerCase()}${request.call.slice(1)}`;
      yield request.purpose === 'readback'
        ? `${request.speaker}: So it's ${lower}. That's the call?`
        : `${request.speaker}: How about we ${lower}?`;
    })(),
  });
  conversation.setHuman({ name: 'Josh', role });
  return { conversation, ports, calls, playing, transcript, logs };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

async function waitCall(calls: LlmCall[], index: number): Promise<LlmCall> {
  for (let i = 0; i < 60 && calls.length <= index; i += 1) await flush();
  if (calls.length <= index) throw new Error(`expected call ${index}, got ${calls.length}`);
  return calls[index]!;
}

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

function requestText(call: LlmCall): string {
  return call.messages.map((message) => message.content).join('\n');
}

function itemFor(scenario: Scenario, title: string) {
  return scenario.agenda.find((candidate) => candidate.title === title)!;
}

function expectedSteps(scenario: Scenario, title: string, seat: string): ExpectedStep[] {
  const item = itemFor(scenario, title);
  const present = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
  const host = (scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
  const groups: ExpectedStep[] = [];
  for (const fact of item.briefing ?? []) {
    const teller = fact.knownBy.find((knower) =>
      present.has(knower.attendee) && knower.attendee !== seat && knower.attendee !== host)?.attendee;
    if (teller === undefined) continue;
    const last = groups.at(-1);
    if (last !== undefined && last.speaker === teller) last.facts.push(fact.text);
    else groups.push({ speaker: teller, facts: [fact.text] });
  }
  groups.push({ speaker: host!, facts: [], invite: true });
  return groups;
}

function firstTeller(scenario: Scenario, title: string, seat: string): { speaker: string; why: string } {
  const item = itemFor(scenario, title);
  const present = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
  const host = (scenario.npcs ?? []).find((npc) => npc.role === 'host')?.attendee;
  for (const fact of item.briefing ?? []) {
    const knower = fact.knownBy.find((candidate) =>
      present.has(candidate.attendee) && candidate.attendee !== seat && candidate.attendee !== host);
    if (knower !== undefined) return { speaker: knower.attendee, why: knower.why };
  }
  throw new Error('no teller');
}

function handoverLine(scenario: Scenario, title: string, seat: string): string {
  const teller = firstTeller(scenario, title, seat);
  return `First up, ${title}. ${teller.speaker}, what happened?`;
}

const TOPICS = [
  'One counter staff short for the opening rush',
  'Old regulars and the new kopi prices',
];

const KOPITIAM = await loadScenario('kopitiam');

describe('one-speaker topic opening', () => {
  let kopitiam: Scenario;
  beforeEach(() => {
    vi.useFakeTimers();
    kopitiam = KOPITIAM;
  });
  afterEach(() => vi.useRealTimers());

  it.each(humanRoles(KOPITIAM).flatMap((role) => TOPICS.map((title) => [role.label, role.id, title] as const)))(
    'opens %s seat on "%s" with the right knower, one line per call, then one question',
    async (_label, roleId, title) => {
      const seat = kopitiam.attendees.find((attendee) => attendee.role === roleId)!.name;
      const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
      const h = harness(scenario, roleId);
      const steps = expectedSteps(scenario, title, seat);

      h.conversation.agendaMoved(title);
      h.conversation.announce('Sam', handoverLine(scenario, title, seat));
      await flush();
      // The first speaker's line is written while the host is still handing over, so it is ready when he finishes.
      expect(h.playing.every((entry) => !entry.finished)).toBe(true);
      const first = await waitCall(h.calls, 0);
      await playOut(h.playing);
      expect(h.calls).toHaveLength(1);
      expect(requestText(first)).toContain(`You are ${steps[0]!.speaker},`);
      expect(requestText(first)).toContain('Tell only this');
      expect(requestText(first)).toContain('what happened?');
      expect(steps[0]!.speaker).not.toBe(seat);
      expect(steps[0]!.speaker).not.toBe('Sam');

      let previous = handoverLine(scenario, title, seat);
      for (let index = 0; index < steps.length; index += 1) {
        const call = await waitCall(h.calls, index);
        const request = requestText(call);
        expect(request).toContain(`You are ${steps[index]!.speaker}`);
        expect(request).toContain('One or two short spoken sentences');
        if (index > 0) expect(request).toContain(previous);
        for (const tradeOff of itemFor(scenario, title).discussion?.tradeOffs ?? []) {
          expect(request).not.toContain(tradeOff.tradeOff);
        }
        const reply = steps[index]!.invite
          ? `Josh, ${itemFor(scenario, title).decision}`
          : steps[index]!.facts.join(' ');
        call.push(`${steps[index]!.speaker}: ${reply}`);
        call.end();
        await flush();
        await playOut(h.playing);
        previous = reply;
      }

      await flush();
      expect(h.calls).toHaveLength(steps.length);
      const questions = h.transcript.filter(([speaker, text]) =>
        speaker === 'Sam' && text.includes('Josh') && text.trim().endsWith('?'));
      expect(questions).toHaveLength(1);
      expect(h.transcript.at(-1)?.[0]).toBe('Sam');
      expect(h.transcript.at(-1)?.[1]).toBe(`Josh, ${itemFor(scenario, title).decision}`);

      const spoken = h.transcript.map(([, text]) => text);
      for (const step of steps.filter((entry) => !entry.invite)) {
        for (const fact of step.facts) expect(spoken.filter((text) => text === fact)).toHaveLength(1);
      }
      expect(spoken.every((text) => !/^(?:i'm|i am)\s+[A-Z]/i.test(text))).toBe(true);
      h.conversation.close();
    },
  );

  it('speaks the host announcement before the opening when the room was busy as it was queued', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[1]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const h = harness(scenario, roleId);

    h.conversation.humanSpeech(true);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', `Next up: ${title}.`);
    h.conversation.humanSpeech(false);
    await flush();
    expect(h.logs).not.toContainEqual(expect.stringContaining('[opening] starting'));

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(h.transcript).toContainEqual(['Sam', `Next up: ${title}.`]);
    expect(h.playing.map((entry) => entry.speaker)).toEqual(['Sam']);

    await playOut(h.playing);
    expect(h.logs).toContainEqual(expect.stringContaining(`[opening] starting "${title}"`));
    h.conversation.close();
  });

  it('drops a stale next-topic announcement after the topic has already opened', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[1]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const h = harness(scenario, roleId);

    h.conversation.agendaMoved(title);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.logs).toContainEqual(expect.stringContaining(`[opening] starting "${title}"`));

    h.conversation.announceNextTopic('Sam', title, `Next up: ${title}.`);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.transcript).not.toContainEqual(['Sam', `Next up: ${title}.`]);
    expect(h.logs).toContainEqual(expect.stringContaining('dropped a stale announcement'));
    h.conversation.close();
  });

  it('rejects a reply with another speaker or no speech whole, retries once, then skips to the host question', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    expect(requestText(first)).toContain('You are Mei');
    first.push('Mei: The seats were full. Sam: Josh, what do you think?');
    first.end();
    await flush();

    const retry = await waitCall(h.calls, 1);
    expect(requestText(retry)).toContain('You are Mei');
    retry.push('Mei: ');
    retry.end();
    await flush();

    const invite = await waitCall(h.calls, 2);
    expect(requestText(invite)).toContain('You are Sam');
    invite.push(`Sam: Josh, ${itemFor(scenario, title).decision}`);
    invite.end();
    await flush();
    await playOut(h.playing);

    expect(h.calls).toHaveLength(3);
    expect(h.transcript.filter(([speaker]) => speaker === 'Mei')).toHaveLength(0);
    expect(h.transcript.at(-1)).toEqual(['Sam', `Josh, ${itemFor(scenario, title).decision}`]);
    expect(h.logs).toContainEqual(expect.stringContaining('[opening] Mei (brief) rejected: another speaker'));
    expect(h.logs).toContainEqual(expect.stringContaining('[opening] Mei (brief) rejected: no speakable line'));
    expect(h.logs).toContainEqual(expect.stringContaining('skipping to the host\'s question'));
    h.conversation.close();
  });

  it('cancels the rest of the opening, including the prefetched line, when the guest speaks', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId, { responseDelayMs: 1_000 });
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);
    const prefetched = await waitCall(h.calls, 1);

    h.conversation.humanTyped('Use the storeroom stools.');
    await flush();

    expect(prefetched.signal.aborted).toBe(true);
    expect(h.logs).toContainEqual(expect.stringContaining('[opening] cancelled'));
    expect(h.playing.at(-1)?.signal.aborted).toBe(true);
    expect(h.calls).toHaveLength(2);
    h.conversation.close();
  });

  it('keeps the opening going through a sound-only cut-in', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);
    const prefetched = await waitCall(h.calls, 1);

    h.conversation.humanSpeech(true);
    await flush();
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(500);
    await playOut(h.playing);

    expect(h.logs).not.toContainEqual(expect.stringContaining('[opening] cancelled'));
    expect(prefetched.signal.aborted).toBe(false);
    for (let index = 1; index < steps.length; index += 1) {
      const call = await waitCall(h.calls, index);
      const reply = steps[index]!.invite
        ? `Josh, ${itemFor(scenario, title).decision}`
        : steps[index]!.facts.join(' ');
      call.push(`${steps[index]!.speaker}: ${reply}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }
    expect(h.transcript).toContainEqual([steps[0]!.speaker, steps[0]!.facts[0]!]);
    expect(h.transcript.at(-1)?.[0]).toBe('Sam');
    h.conversation.close();
  });

  it('keeps the old multi-speaker opening selectable with KAKI_OPENING=legacy', async () => {
    vi.stubEnv('KAKI_OPENING', 'legacy');
    try {
      const seat = 'Wei Ling';
      const title = TOPICS[0]!;
      const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
      const h = harness(scenario, 'producer');
      h.conversation.agendaMoved(title);
      h.conversation.announce('Sam', handoverLine(scenario, title, seat));
      await flush();
      await playOut(h.playing);
      const first = await waitCall(h.calls, 0);
      expect(requestText(first)).toContain(`[We just started "${title}"`);
      h.conversation.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fetches only the next topic\'s first one-speaker call while the host winds down', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const nextTitle = TOPICS[1]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId, { responseDelayMs: 1_000 });
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);
    for (let index = 0; index < steps.length; index += 1) {
      const call = await waitCall(h.calls, index);
      const reply = steps[index]!.invite
        ? `Josh, ${itemFor(scenario, title).decision}`
        : steps[index]!.facts.join(' ');
      call.push(`${steps[index]!.speaker}: ${reply}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }

    const before = h.calls.length;
    h.conversation.humanTyped('Use the window bar.');
    h.conversation.lockDecision(undefined, { confirmed: true });
    await flush();
    const next = await waitCall(h.calls, before);
    const expectedTeller = firstTeller(scenario, nextTitle, seat).speaker;
    expect(requestText(next)).toContain(`You are ${expectedTeller}`);
    expect(requestText(next)).toContain(nextTitle);
    expect(requestText(next)).toContain('Tell only this');
    expect(h.calls).toHaveLength(before + 1);
    h.conversation.close();
  });

  it('tells a briefing colleague to link truthfully to the previous line, never to say it caused their news', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    await playOut(h.playing);

    const second = await waitCall(h.calls, 1);
    const request = requestText(second);
    expect(request).toContain('Start by linking to that point in a way that is true from what you know');
    expect(request).toContain('Never claim their news caused or changed yours');
    h.conversation.close();
  });

  it('strips a self-introduction before anything is played', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: I'm ${steps[0]!.speaker}, the menu lead. ${steps[0]!.facts[0]}`);
    first.end();
    await flush();
    await playOut(h.playing);

    expect(h.transcript).toContainEqual([steps[0]!.speaker, steps[0]!.facts[0]!]);
    expect(h.transcript.some(([, text]) => /^i'm\s/i.test(text))).toBe(false);
    h.conversation.close();
  });

  it('arms the silence check-in after the host\'s question is heard', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId, { silencePromptMs: 1_000, silenceNudgeLeadMs: 0 });
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    for (let index = 0; index < steps.length; index += 1) {
      const call = await waitCall(h.calls, index);
      const reply = steps[index]!.invite
        ? `Josh, ${itemFor(scenario, title).decision}`
        : steps[index]!.facts.join(' ');
      call.push(`${steps[index]!.speaker}: ${reply}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }
    await flush();
    expect(h.calls).toHaveLength(steps.length);

    await vi.advanceTimersByTimeAsync(1_000);
    const checkIn = await waitCall(h.calls, steps.length);
    expect(requestText(checkIn)).toContain('is taking a moment to think');
    expect(requestText(checkIn)).toContain('checks in with Josh');
    h.conversation.close();
  });

  it('asks the fallback question when the host\'s invite cannot be heard after its retry', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const inviteIndex = steps.length - 1;
    const h = harness(scenario, roleId, { silencePromptMs: 1_000, silenceNudgeLeadMs: 0 });
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    for (let index = 0; index < inviteIndex; index += 1) {
      const call = await waitCall(h.calls, index);
      call.push(`${steps[index]!.speaker}: ${steps[index]!.facts.join(' ')}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }

    const firstInvite = await waitCall(h.calls, inviteIndex);
    firstInvite.push('Sam: Not actually a question.');
    firstInvite.end();
    await flush();
    const retryInvite = await waitCall(h.calls, inviteIndex + 1);
    retryInvite.push('Sam: Still not a question.');
    retryInvite.end();
    await flush();

    expect(h.logs).toContainEqual(expect.stringContaining('[opening] the host\'s question could not be heard'));
    await playOut(h.playing);
    expect(h.transcript.at(-1)).toEqual(['Sam', `Josh, ${itemFor(scenario, title).decision}`]);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitCall(h.calls, inviteIndex + 2);
    h.conversation.close();
  });

  it('abandons an opening line that sends a sentence and then never finishes', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);

    const retry = await waitCall(h.calls, 1);
    expect(requestText(retry)).toContain(`You are ${steps[0]!.speaker}`);
    expect(first.signal.aborted).toBe(true);
    expect(h.logs.some((line) => line.includes('did not finish within 20000 ms'))).toBe(true);
    retry.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    retry.end();
    await flush();
    await playOut(h.playing);
    h.conversation.close();
  });

  it('abandons a fresh opening stream that sends a sentence and then never finishes', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    await flush();

    const first = await waitCall(h.calls, 0);
    expect(requestText(first)).toContain(`You are ${steps[0]!.speaker}`);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);

    const retry = await waitCall(h.calls, 1);
    expect(requestText(retry)).toContain(`You are ${steps[0]!.speaker}`);
    expect(first.signal.aborted).toBe(true);
    expect(h.logs.some((line) => line.includes('did not finish within 20000 ms'))).toBe(true);
    h.conversation.close();
  });

  it('abandons a prefetched opening line that sends a sentence and then never finishes', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    const prefetched = await waitCall(h.calls, 1);
    prefetched.push(`${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await playOut(h.playing);

    const fresh = await waitCall(h.calls, 2);
    expect(prefetched.signal.aborted).toBe(true);
    expect(requestText(fresh)).toContain(`You are ${steps[1]!.speaker}`);
    expect(h.logs).toContainEqual(expect.stringContaining('the opening line did not finish within 20000 ms'));
    h.conversation.close();
  });

  it('keeps a wordless cut-in before the next opening line\'s first sound inside the opening run', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    const prefetched = await waitCall(h.calls, 1);
    await playOut(h.playing);

    h.conversation.humanSpeech(true);
    await flush();
    h.conversation.humanSpeech(false);
    h.conversation.humanNothing();
    await vi.advanceTimersByTimeAsync(2_000);

    const retried = await waitCall(h.calls, 2);
    expect(prefetched.signal.aborted).toBe(true);
    expect(requestText(retried)).toContain(`You are ${steps[1]!.speaker}`);
    expect(requestText(retried)).not.toContain('made a sound but said nothing');
    expect(h.logs).not.toContainEqual(expect.stringContaining('the person cut in but said nothing recognisable: carrying on'));
    expect(h.calls).toHaveLength(3);

    retried.push(`${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`);
    retried.end();
    await flush();
    await playOut(h.playing);
    for (let index = 2; index < steps.length; index += 1) {
      const call = await waitCall(h.calls, index + 1);
      const reply = steps[index]!.invite
        ? `Josh, ${itemFor(scenario, title).decision}`
        : steps[index]!.facts.join(' ');
      call.push(`${steps[index]!.speaker}: ${reply}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }
    expect(h.transcript.at(-1)?.[0]).toBe('Sam');
    h.conversation.close();
  });

  it('resumes the opening after Stop from the last line the room fully heard', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    await playOut(h.playing);

    const second = await waitCall(h.calls, 1);
    second.push(`${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`);
    second.end();
    await flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);

    h.conversation.stop();
    await flush();
    const beforeResume = h.calls.length;
    h.conversation.resumeFromPause();
    await flush();

    const resumed = await waitCall(h.calls, beforeResume);
    expect(requestText(resumed)).toContain(`You are ${steps[1]!.speaker}`);
    expect(requestText(resumed)).toContain('Tell only this');
    expect(requestText(resumed)).not.toContain('unpaused the meeting');
    resumed.push(`${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`);
    resumed.end();
    await flush();
    await playOut(h.playing);

    for (let index = 2; index < steps.length; index += 1) {
      const call = await waitCall(h.calls, beforeResume + index - 1);
      const reply = steps[index]!.invite
        ? `Josh, ${itemFor(scenario, title).decision}`
        : steps[index]!.facts.join(' ');
      call.push(`${steps[index]!.speaker}: ${reply}`);
      call.end();
      await flush();
      await playOut(h.playing);
    }
    expect(h.transcript.at(-1)).toEqual(['Sam', `Josh, ${itemFor(scenario, title).decision}`]);
    h.conversation.close();
  });

  it('keeps one transcript entry for a cut sentence and adds no dash marker', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    await playOut(h.playing);

    const line = `${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`;
    const second = await waitCall(h.calls, 1);
    second.push(line);
    second.end();
    await flush();
    expect(h.playing.some((entry) => !entry.finished)).toBe(true);
    const before = h.transcript.filter(([, text]) => text === steps[1]!.facts.join(' ')).length;
    expect(before).toBe(1);

    h.conversation.stop();
    await flush();
    expect(h.transcript.some(([, text]) => text === '—')).toBe(false);
    expect(h.transcript.filter(([, text]) => text === steps[1]!.facts.join(' '))).toHaveLength(1);

    const resumeAt = h.calls.length;
    h.conversation.resumeFromPause();
    await flush();
    const resumed = await waitCall(h.calls, resumeAt);
    resumed.push(line);
    resumed.end();
    await flush();
    await playOut(h.playing);

    expect(h.transcript.some(([, text]) => text === '—')).toBe(false);
    expect(h.transcript.filter(([, text]) => text === steps[1]!.facts.join(' '))).toHaveLength(1);
    h.conversation.close();
  });

  it('rejects a prefetched brief that does not carry its fact before any of it plays', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();
    // The next speaker's line is written early, while the first line still plays.
    const prefetched = await waitCall(h.calls, 1);
    expect(requestText(prefetched)).toContain(`You are ${steps[1]!.speaker}`);
    prefetched.push(`${steps[1]!.speaker}: That's what worries me most.`);
    prefetched.end();
    await flush();
    await playOut(h.playing);

    expect(h.transcript.some(([, text]) => text === "That's what worries me most.")).toBe(false);
    expect(h.logs).toContainEqual(expect.stringContaining('did not carry the fact'));
    const retry = await waitCall(h.calls, 2);
    expect(requestText(retry)).toContain(`You are ${steps[1]!.speaker}`);
    expect(requestText(retry)).toContain('Tell only this');
    retry.push(`${steps[1]!.speaker}: ${steps[1]!.facts.join(' ')}`);
    retry.end();
    await flush();
    await playOut(h.playing);

    expect(h.transcript).toContainEqual([steps[1]!.speaker, steps[1]!.facts.join(' ')]);
    h.conversation.close();
  });

  it('rejects a brief reply that does not carry its fact, retries once, then skips to the host', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: Our counter staff texted with a fever, so we're short for the rush.`);
    first.end();
    await flush();
    const retry = await waitCall(h.calls, 1);
    retry.push(`${steps[0]!.speaker}: That's tricky.`);
    retry.end();
    await flush();

    const invite = await waitCall(h.calls, 2);
    expect(requestText(invite)).toContain('You are Sam');
    expect(h.logs).toContainEqual(expect.stringContaining('did not carry the fact'));
    expect(h.logs.filter((line) => line.includes('did not carry the fact'))).toHaveLength(2);
    invite.push(`Sam: Josh, ${itemFor(scenario, title).decision}`);
    invite.end();
    await flush();
    await playOut(h.playing);
    expect(h.transcript.some(([, text]) => text === "That's tricky.")).toBe(false);
    expect(h.transcript.some(([, text]) => text.includes('texted with a fever'))).toBe(false);
    expect(h.transcript.at(-1)?.[0]).toBe('Sam');
    h.conversation.close();
  });

  it('accepts a brief paraphrase that keeps the fact\'s numbers and content', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId);
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    const paraphrase = 'Our counter staff texted at 6:45 with a fever, so we are short one for the 8 o\'clock rush.';
    first.push(`${steps[0]!.speaker}: ${paraphrase}`);
    first.end();
    await flush();
    await playOut(h.playing);

    expect(h.transcript).toContainEqual([steps[0]!.speaker, paraphrase]);
    expect(h.logs).not.toContainEqual(expect.stringContaining('did not carry the fact'));
    h.conversation.close();
  });

  it('shows an opening line as text when its playback fails, and still counts it heard', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = TOPICS[0]!;
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const steps = expectedSteps(scenario, title, seat);
    const h = harness(scenario, roleId, { failPlaybackFor: steps[0]!.facts[0]! });
    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', handoverLine(scenario, title, seat));
    await flush();
    await playOut(h.playing);

    const first = await waitCall(h.calls, 0);
    first.push(`${steps[0]!.speaker}: ${steps[0]!.facts.join(' ')}`);
    first.end();
    await flush();

    expect(h.logs).toContainEqual(expect.stringContaining('playback failed; showing as text'));
    expect(h.transcript).toContainEqual([steps[0]!.speaker, steps[0]!.facts.join(' ')]);
    await vi.advanceTimersByTimeAsync(6_000);
    const next = await waitCall(h.calls, 1);
    expect(requestText(next)).toContain(`You are ${steps[1]!.speaker}`);
    h.conversation.close();
  });

  it('counts a brief sentence the room heard before a cut-off, so the same fact is not told again', async () => {
    const roleId = 'producer';
    const seat = 'Wei Ling';
    const title = 'Laptop campers and the breakfast seat crunch';
    const scenario = { ...kopitiam, npcs: aiCast(kopitiam, seat) };
    const facts = itemFor(scenario, title).briefing!.map((fact) => fact.text);
    const h = harness(scenario, roleId);

    h.conversation.agendaMoved(title);
    h.conversation.announce('Sam', 'Mei, you were on the floor at the trial, what happened?');
    await flush();
    await playOut(h.playing);

    const brief = await waitCall(h.calls, 0);
    brief.push(`Mei: ${facts.join(' ')}`);
    brief.end();
    await flush();
    // The first fact has been heard; the second sentence is still playing when the guest cuts in.
    h.playing.find((entry) => entry.speaker === 'Mei' && !entry.finished)!.finish();
    await flush();
    expect(h.playing.some((entry) => entry.speaker === 'Mei' && !entry.finished)).toBe(true);
    h.conversation.humanTyped('Did laptop users really hold half our seats on just one kopi?');
    await flush();

    const reply = await waitCall(h.calls, 1);
    expect(requestText(reply)).not.toContain(`You may tell only this: "${facts[0]}"`);
    expect(h.logs).not.toContainEqual(expect.stringContaining('Speak Mei (answer) because Mei was asked'));
    h.conversation.close();
  });

  it('rejects pointing at the follow-up card or the player\'s screen, but not a plain table or loyalty card', () => {
    const names = (KOPITIAM.npcs ?? []).map((npc) => npc.attendee);
    const parse = (speaker: string, text: string) => parsePlannedReply(`${speaker}: ${text}`, {
      expectedSpeaker: speaker,
      names,
      guestName: 'Josh',
      purpose: 'answer',
    });

    for (const text of [
      'A 60-minute breakfast card on every table, with one friendly mention at the till.',
      'Cardholders get one friendly mention at the till, and nobody has to police it.',
    ]) {
      expect(parse('Arjun', text)).toMatchObject({ ok: true });
    }
    for (const text of [
      'The follow-up card is on your screen.',
      'You can see it on your phone.',
      'I put the panel in front of you.',
    ]) {
      expect(parse('Arjun', text)).toEqual({ ok: false, reason: 'pointed at the card or screen' });
    }
  });

  it('asks the writer for a direct answer with no question back, and only a real gap for clarify', () => {
    const messages = (purpose: 'answer' | 'clarify') => replySpeakerMessages({
      scenario: KOPITIAM,
      speaker: 'Arjun',
      topicTitle: TOPICS[0]!,
      purpose,
      transcript: [],
      respondsTo: { speaker: 'Josh', text: 'Would a small table sign actually move people, or just get ignored?' },
    }).map((message) => message.content).join('\n');

    const answer = messages('answer');
    expect(answer).toContain('Answer the point directly');
    expect(answer).toContain('Do not ask the guest a question back');
    expect(answer).not.toContain('ask at most one short question to understand what they want');

    const clarify = messages('clarify');
    expect(clarify).toContain("what their point means for your own work");
    expect(clarify).toContain('otherwise end with no question');
    expect(clarify).not.toContain('ask at most one short question to understand what they want');
  });

  it('accepts a plain read-back and rejects quotation marks or a menu', () => {
    const parse = (text: string) => parseGateReply(`Sam: ${text}`, { speaker: 'Sam', guestName: 'Josh' });

    expect(parse("So it's signs only this morning, and we leave the sockets alone. That's the call?"))
      .toMatchObject({ ok: true, text: "So it's signs only this morning, and we leave the sockets alone. That's the call?" });
    expect(parse('So your call is "signs only". Is that right?')).toEqual({ ok: false, reason: 'used quotation marks' });
    expect(parse('Shall we do the signs? Or the sockets?')).toEqual({ ok: false, reason: 'did not end with exactly one short question' });
    expect(parse('The signs only, then. Is that the call?')).toMatchObject({ ok: true });
  });

  it('asks the gate writer for one plain line with no quotes and no new details', () => {
    const readback = gateSpeakerMessages({
      scenario: KOPITIAM,
      speaker: 'Sam',
      human: { name: 'Josh', role: 'Producer' },
      topicTitle: TOPICS[0]!,
      purpose: 'readback',
      guestLines: ['Signs only this morning, then.'],
      call: 'Signs only this morning',
    }).map((message) => message.content).join('\n');
    expect(readback).toContain('Say that call back in your own plain words');
    expect(readback).toContain('Do not quote them or use quotation marks');
    expect(readback).toContain('Add no new step, no new owner, no number and no time');

    const offer = gateSpeakerMessages({
      scenario: KOPITIAM,
      speaker: 'Sam',
      human: { name: 'Josh', role: 'Producer' },
      topicTitle: TOPICS[0]!,
      purpose: 'offer',
      guestLines: [],
      call: 'Ask Auntie Mary to come in',
    }).map((message) => message.content).join('\n');
    expect(offer).toContain('Propose exactly one concrete call');
    expect(offer).toContain('do not offer an either/or choice');
  });

  it('lets a reply control line carry reopen, reactions and wingman tips, not only settle or park', () => {
    const messages = replySpeakerMessages({
      scenario: KOPITIAM,
      speaker: 'Sam',
      topicTitle: TOPICS[0]!,
      purpose: 'clarify',
      transcript: [],
      respondsTo: { speaker: 'Josh', text: 'Let us go back to the earlier plan.' },
      asksControl: true,
    });
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toContain('"reactions"');
    expect(text).toContain('"wingmanTip"');
    expect(text).toContain('"reopen"');
    expect(text).toContain('Use "open" when the guest reopens an earlier item');
  });
});
