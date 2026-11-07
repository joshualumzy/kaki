import { describe, expect, it } from 'vitest';
import type { AgendaItem, Scenario } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import {
  assessProposal,
  evidenceMatchesVisitor,
  isSubstantiveProposal,
  type ProposalAssessment,
} from '../../src/npc/proposal';
import { testScenario } from '../fixtures/scenario';

const item: AgendaItem = {
  title: 'Prep',
  minutes: 5,
  ownerRole: 'chef',
  decision: 'how do we speed up prep without making the till slower?',
  discussion: {
    openingViews: [
      { attendee: 'Ada', view: 'We need the queue to move.' },
      { attendee: 'Bao', view: 'The till screen is already full.' },
    ],
    tradeOffs: [
      {
        attendee: 'Ada',
        role: 'chef',
        tradeOff: 'The morning queue is backing out of the door.',
        question: 'How do we serve the queue faster?',
      },
      {
        attendee: 'Bao',
        role: 'cashier',
        tradeOff: 'The till screen only fits twelve buttons.',
        question: 'What do we remove to make room?',
      },
    ],
  },
};

const scenario: Scenario = { ...testScenario, agenda: [item] };

function streamReply(reply: string, seen?: ChatMessage[][]): (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string> {
  return async function* (messages) {
    seen?.push(messages);
    yield reply;
  };
}

describe('isSubstantiveProposal', () => {
  it('accepts a concrete proposal', () => {
    expect(isSubstantiveProposal('Let us move the cash box by the door.')).toBe(true);
    expect(isSubstantiveProposal('What if we put the butter on the side?')).toBe(true);
  });

  it('rejects questions, side requests and filler', () => {
    expect(isSubstantiveProposal('How do we handle cash?')).toBe(false);
    expect(isSubstantiveProposal('Can you do that?')).toBe(false);
    expect(isSubstantiveProposal('Could you send me the budget breakdown after this?')).toBe(false);
    expect(isSubstantiveProposal("I'll email the supplier after this.")).toBe(false);
    expect(isSubstantiveProposal('Hi team.')).toBe(false);
    expect(isSubstantiveProposal('Um, okay.')).toBe(false);
  });
});

describe('assessProposal', () => {
  it('accepts a genuinely complete first proposal when every trade-off is resolved with spoken evidence', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'complete',
      resolved: [
        { tradeOffId: 'T1', evidence: 'we will open a second prep station before the rush' },
        { tradeOffId: 'T2', evidence: 'remove the two slow items from the till screen' },
      ],
      unresolved: [],
    });
    const seen: ChatMessage[][] = [];
    const result = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station before the rush and remove the two slow items from the till screen.',
      stream: streamReply(reply, seen),
    });
    expect(result).toMatchObject({ isProposal: true, readiness: 'complete', unresolved: [] });
    expect(result?.resolved).toHaveLength(2);
    expect(seen[0]?.some((message) => message.content.includes('[KAKI_PROPOSAL_ASSESSMENT]'))).toBe(true);
  });

  it('accepts resolved evidence the visitor said in an earlier substantive line on the same item', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'complete',
      resolved: [
        { tradeOffId: 'T1', evidence: 'we will open a second prep station before the rush' },
        { tradeOffId: 'T2', evidence: 'remove the two slow items from the till screen' },
      ],
      unresolved: [],
    });
    const seen: ChatMessage[][] = [];
    const result = await assessProposal({
      scenario,
      item,
      visitorContext: ['We will open a second prep station before the rush.'],
      visitorText: 'Also remove the two slow items from the till screen.',
      stream: streamReply(reply, seen),
    });
    expect(result).toMatchObject({ isProposal: true, readiness: 'complete', unresolved: [] });
    expect(result?.resolved.map((entry) => entry.tradeOff)).toEqual([
      'The morning queue is backing out of the door.',
      'The till screen only fits twelve buttons.',
    ]);
    const prompt = String(seen[0]?.[0]?.content ?? '');
    expect(prompt).toContain('We will open a second prep station before the rush.');
    expect(prompt).toContain('Also remove the two slow items from the till screen.');
  });

  it('carries resolved trade-offs forward when the latest line only adds the missing settlement', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'complete',
      resolved: [{ tradeOffId: 'T2', evidence: 'remove the two slow items from the till screen' }],
      unresolved: [],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorContext: ['We will open a second prep station before the rush.'],
      visitorText: 'Also remove the two slow items from the till screen.',
      resolvedSoFar: [
        {
          tradeOff: 'The morning queue is backing out of the door.',
          evidence: 'we will open a second prep station before the rush',
        },
      ],
      stream: streamReply(reply),
    });
    expect(result).toMatchObject({ isProposal: true, readiness: 'complete', unresolved: [] });
    expect(result?.resolved.map((entry) => entry.tradeOff)).toEqual([
      'The till screen only fits twelve buttons.',
      'The morning queue is backing out of the door.',
    ]);
  });

  it('keeps a shallow first proposal open with the unresolved trade-off', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'open',
      resolved: [{ tradeOffId: 'T1', evidence: 'we will open a second prep station' }],
      unresolved: [{ tradeOffId: 'T2', question: 'What do we remove from the till screen?' }],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station before the rush.',
      stream: streamReply(reply),
    });
    expect(result?.readiness).toBe('open');
    expect(result?.unresolved).toEqual([
      { tradeOff: 'The till screen only fits twelve buttons.', question: 'What do we remove from the till screen?' },
    ]);
  });

  it('drops resolved evidence the visitor did not say and refuses to call the item complete', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'complete',
      resolved: [
        { tradeOffId: 'T1', evidence: 'we will open a second prep station' },
        { tradeOffId: 'T2', evidence: 'we will buy a second till' },
      ],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station before the rush.',
      stream: streamReply(reply),
    });
    expect(result?.readiness).toBe('open');
    expect(result?.resolved.map((entry) => entry.tradeOff)).toEqual(['The morning queue is backing out of the door.']);
    expect(result?.unresolved.map((entry) => entry.tradeOff)).toContain('The till screen only fits twelve buttons.');
  });

  it('returns undefined for a malformed reply, a failed stream or a timeout', async () => {
    const malformed = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station.',
      stream: streamReply('Sure, that sounds good!'),
    });
    expect(malformed).toBeUndefined();

    const failed = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station.',
      stream: async function* () {
        throw new Error('gateway down');
      },
    });
    expect(failed).toBeUndefined();

    const timedOut = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station.',
      timeoutMs: 5,
      stream: async function* (_messages, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield '';
      },
    });
    expect(timedOut).toBeUndefined();
  });

  it('does not treat a side request as a proposal', async () => {
    const result: ProposalAssessment | undefined = await assessProposal({
      scenario,
      item,
      visitorText: 'Could you send me the budget breakdown after this?',
      stream: streamReply(JSON.stringify({ isProposal: false, readiness: 'open', resolved: [], unresolved: [] })),
    });
    expect(result).toEqual({ isProposal: false, readiness: 'open', resolved: [], unresolved: [] });
  });

  it('matches evidence after normalising punctuation and spacing', () => {
    expect(evidenceMatchesVisitor('second prep station', 'We will open a second prep-station.')).toBe(true);
    expect(evidenceMatchesVisitor('buy a second till', 'We will open a second prep station.')).toBe(false);
  });
});
