import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, Scenario } from '@kaki/shared';
import type { ChatMessage } from '../../src/llm';
import {
  assessProposal,
  DEFAULT_ASSESSMENT_TIMEOUT_MS,
  evidenceMatchesVisitor,
  isSideRequest,
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

  it('accepts terse action imperatives as proposals', () => {
    expect(isSubstantiveProposal('Ban laptops during breakfast')).toBe(true);
    expect(isSubstantiveProposal('Put a cash drawer back at the toast counter')).toBe(true);
  });

  it('rejects an imperative follow-up request, but not a decision that mentions a draft', () => {
    expect(isSubstantiveProposal('Please draft the cash desk handover for the team channel')).toBe(false);
    expect(isSubstantiveProposal('Draft the cash desk handover for the team channel.')).toBe(false);
    expect(isSubstantiveProposal('Post the decision in the team channel today.')).toBe(false);
    expect(isSubstantiveProposal('Put the cash drawer back and draft a handover note for the team channel.')).toBe(true);
  });

  it('rejects questions, side requests and filler', () => {
    expect(isSubstantiveProposal('How do we handle cash?')).toBe(false);
    expect(isSubstantiveProposal('Can you do that?')).toBe(false);
    expect(isSubstantiveProposal('Could you send me the budget breakdown after this?')).toBe(false);
    expect(isSubstantiveProposal("I'll email the supplier after this.")).toBe(false);
    expect(isSubstantiveProposal('Hi team.')).toBe(false);
    expect(isSubstantiveProposal('Um, okay.')).toBe(false);
  });

  it('rejects a first-person follow-up promise with a bounded comma-delimited name', () => {
    const line =
      'Confirmed, that is my decision. I, Booth Playtest, will post the agreed plan in the team channel today. Please assign that Mattermost handover to me so I can review the draft.';
    expect(isSubstantiveProposal(line)).toBe(false);
    expect(isSubstantiveProposal('I, Booth Playtest, will email the supplier after this.')).toBe(false);
  });

  it('still assesses a changed decision that also carries a named post promise', () => {
    expect(
      isSubstantiveProposal(
        'Changed my mind: I, Booth Playtest, will move the cash drawer back and post the handover note after.',
      ),
    ).toBe(true);
  });

  it('still assesses a real decision that precedes a named post promise', () => {
    expect(
      isSubstantiveProposal(
        'Changed my mind: use 20g for everyone. I, Booth Playtest, will post the updated decision in the team channel.',
      ),
    ).toBe(true);
    expect(
      isSubstantiveProposal(
        'Changed my mind: scrap the offer. I, Booth Playtest, will post the cancellation.',
      ),
    ).toBe(true);
    expect(
      isSubstantiveProposal(
        'Use 20g for everyone. I, Booth Playtest, will post the updated decision in the team channel.',
      ),
    ).toBe(true);
  });

  it('still assesses a real decision that follows a named post promise', () => {
    expect(
      isSubstantiveProposal(
        'I, Booth Playtest, will post the updated decision in the team channel. Use 20g for everyone.',
      ),
    ).toBe(true);
  });

  it('still assesses a substantive plan that ends with an ordinary first-person promise', () => {
    expect(
      isSubstantiveProposal(
        'Remove NO CASH signs and put CASH WELCOME at the entrance. Cash accepted, change given, no app or prepayment. I will post the handover in Mattermost.',
      ),
    ).toBe(true);
    expect(
      isSubstantiveProposal(
        "Remove NO CASH signs and put CASH WELCOME at the entrance. Cash accepted, change given, no app or prepayment. I'll post the handover in Mattermost.",
      ),
    ).toBe(true);
  });

  it('still assesses a substantive plan that follows an ordinary first-person promise', () => {
    expect(
      isSubstantiveProposal(
        'I will post the handover in Mattermost. Remove NO CASH signs and put CASH WELCOME at the entrance.',
      ),
    ).toBe(true);
  });

  it('rejects a pure ordinary first-person promise', () => {
    expect(isSubstantiveProposal('I will post the handover in Mattermost.')).toBe(false);
    expect(isSubstantiveProposal("I'll post the handover in Mattermost.")).toBe(false);
  });

  it('rejects a pure request even when it asks for the same follow-up', () => {
    expect(isSubstantiveProposal('Please post the handover in Mattermost.')).toBe(false);
  });
});

describe('isSideRequest', () => {
  it('recognises an explicit request to prepare or send a follow-up deliverable', () => {
    expect(isSideRequest('Could you draft a ticket for that kiosk trial?')).toBe(true);
    expect(isSideRequest('Can you file a ticket for the label experiment?')).toBe(true);
    expect(isSideRequest('Please send the budget breakdown after this.')).toBe(true);
    expect(isSideRequest('Draft the handover note for the team channel.')).toBe(true);
  });

  it('leaves decisions, questions, greetings and first-person promises alone', () => {
    expect(isSideRequest('Put the cash drawer back and draft a handover note for the team channel.')).toBe(false);
    expect(isSideRequest('How do we handle cash?')).toBe(false);
    expect(isSideRequest('Hi team.')).toBe(false);
    expect(isSideRequest("I'll email the supplier after this.")).toBe(false);
    expect(isSideRequest('After the meeting I checked the numbers.')).toBe(false);
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

  it('names only the latest line when it replaces the earlier proposal', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'open',
      decisionLines: [2],
      resolved: [],
      unresolved: [],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorContext: ['We will open a second prep station before the rush.'],
      visitorText: 'Actually, keep the single prep station and move the till by the door instead.',
      stream: streamReply(reply),
    });
    expect(result?.decisionLines).toEqual(['Actually, keep the single prep station and move the till by the door instead.']);
  });

  it('does not carry a resolved trade-off from a superseded decision line', async () => {
    const result = await assessProposal({
      scenario, item,
      visitorContext: ['We will open a second prep station before the rush.'],
      visitorText: 'Actually, remove the two slow items from the till screen instead.',
      resolvedSoFar: [{ tradeOff: 'The morning queue is backing out of the door.', evidence: 'we will open a second prep station before the rush' }],
      stream: streamReply(JSON.stringify({ isProposal: true, readiness: 'complete', decisionLines: [2],
        resolved: [{ tradeOffId: 'T2', evidence: 'remove the two slow items from the till screen' }], unresolved: [] })),
    });
    expect(result?.readiness).toBe('open');
    expect(result?.resolved.map((entry) => entry.tradeOff)).not.toContain('The morning queue is backing out of the door.');
  });

  it('keeps both lines when the later line only adds a missing detail', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'open',
      decisionLines: [1, 2],
      resolved: [],
      unresolved: [],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorContext: ['We will open a second prep station before the rush.'],
      visitorText: 'Also remove the two slow items from the till screen.',
      stream: streamReply(reply),
    });
    expect(result?.decisionLines).toEqual([
      'We will open a second prep station before the rush.',
      'Also remove the two slow items from the till screen.',
    ]);
  });

  it('ignores decision line numbers that do not name a visitor line', async () => {
    const reply = JSON.stringify({
      isProposal: true,
      readiness: 'open',
      decisionLines: [9],
      resolved: [],
      unresolved: [],
    });
    const result = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station before the rush.',
      stream: streamReply(reply),
    });
    expect(result?.decisionLines).toBeUndefined();
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

  it('keeps a clear action imperative open when the model wrongly calls it a non-proposal', async () => {
    const reply = JSON.stringify({ isProposal: false, readiness: 'open', resolved: [], unresolved: [] });
    for (const visitorText of ['Ban laptops during breakfast.', 'Put a cash drawer back at the toast counter.']) {
      const result = await assessProposal({ scenario, item, visitorText, stream: streamReply(reply) });
      expect(result).toMatchObject({ isProposal: true, readiness: 'open', resolved: [] });
      expect(result?.unresolved.map((entry) => entry.tradeOff)).toEqual([
        'The morning queue is backing out of the door.',
        'The till screen only fits twelve buttons.',
      ]);
    }
  });

  it('still treats a genuine question or filler as a non-proposal', async () => {
    const reply = JSON.stringify({ isProposal: false, readiness: 'open', resolved: [], unresolved: [] });
    for (const visitorText of ['How do we handle cash?', 'Hi team.']) {
      await expect(assessProposal({ scenario, item, visitorText, stream: streamReply(reply) })).resolves.toEqual({
        isProposal: false,
        readiness: 'open',
        resolved: [],
        unresolved: [],
      });
    }
  });

  it('logs a timeout and caller cancellation differently', async () => {
    const timeoutLogs: string[] = [];
    const timedOut = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station.',
      timeoutMs: 5,
      log: (message) => timeoutLogs.push(message),
      stream: async function* (_messages, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield '';
      },
    });
    expect(timedOut).toBeUndefined();
    expect(timeoutLogs).toContain('proposal assessment timed out; keeping the item open');
    expect(timeoutLogs.some((line) => line.includes('cancelled'))).toBe(false);

    const caller = new AbortController();
    const cancelLogs: string[] = [];
    const cancelled = await assessProposal({
      scenario,
      item,
      visitorText: 'We will open a second prep station.',
      signal: caller.signal,
      log: (message) => cancelLogs.push(message),
      stream: async function* (_messages, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          caller.abort();
        });
        yield '';
      },
    });
    expect(cancelled).toBeUndefined();
    expect(cancelLogs).toContain('proposal assessment cancelled by the caller; keeping the item open');
    expect(cancelLogs.some((line) => line.includes('timed out'))).toBe(false);
  });

  it('allows the full default bound before abandoning a slow assessment and still fails closed', async () => {
    expect(DEFAULT_ASSESSMENT_TIMEOUT_MS).toBe(4_500);
    expect(DEFAULT_ASSESSMENT_TIMEOUT_MS).toBeLessThan(20_000);

    vi.useFakeTimers();
    try {
      let finished = false;
      const result = assessProposal({
        scenario,
        item,
        visitorText: 'We will open a second prep station.',
        stream: async function* (_messages, signal) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield '';
        },
      });
      void result.then(() => {
        finished = true;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_ASSESSMENT_TIMEOUT_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches evidence after normalising punctuation and spacing', () => {
    expect(evidenceMatchesVisitor('second prep station', 'We will open a second prep-station.')).toBe(true);
    expect(evidenceMatchesVisitor('buy a second till', 'We will open a second prep station.')).toBe(false);
  });
});
