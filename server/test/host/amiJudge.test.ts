import { describe, expect, it } from 'vitest';
import { judgeAmi, validateJudgeReply } from '../../src/host/eval/judgeAmi';
import type { LlmClient } from '../../src/services/llm';

const input = {
  meeting: 'ES2008a',
  foundTasks: ['Email the slides', 'Type the minutes'],
  foundQuestions: ['Which devices will the remote support?'],
  goldActions: ['Email the slides to the team', 'Write up the meeting minutes'],
  goldProblems: ['Whether the remote controls one device or many'],
  goldDecisions: ['The remote will be sold for 25 Euro.'],
};

const matches = (...entries: Array<[number | null, string]>) =>
  JSON.stringify({ matches: entries.map(([found, reason], index) => ({ gold: index + 1, found, reason })) });

describe('AMI judge validation', () => {
  it('pairs gold items with found items and derives the unmatched lists', () => {
    expect(validateJudgeReply(matches([2, 'Both write the minutes.'], [null, 'Nothing sends slides.']), 3, 2)).toEqual({
      pairs: [{ found: 2, gold: 1, reason: 'Both write the minutes.' }],
      unmatchedFound: [1, 3],
      unmatchedGold: [2],
    });
  });

  it('lets one found item cover several gold items', () => {
    const verdict = validateJudgeReply(matches([1, 'minutes'], [1, 'slides']), 1, 2);

    expect(verdict.pairs).toHaveLength(2);
    expect(verdict.unmatchedFound).toEqual([]);
  });

  it('rejects a reply without exactly one entry per gold item, in order', () => {
    expect(() => validateJudgeReply(matches([1, 'same']), 1, 2)).toThrow(/1 matches for 2 gold items/);
    const outOfOrder = JSON.stringify({
      matches: [
        { gold: 2, found: 1, reason: 'same' },
        { gold: 1, found: null, reason: 'none' },
      ],
    });
    expect(() => validateJudgeReply(outOfOrder, 1, 2)).toThrow(/matches\[0\]\.gold must be 1/);
  });

  it('rejects out-of-range and non-integer found numbers and missing reasons', () => {
    expect(() => validateJudgeReply(matches([2, 'same']), 1, 1)).toThrow(/1 to 1/);
    expect(() => validateJudgeReply(matches([1.5, 'same']), 2, 1)).toThrow(/1 to 2/);
    expect(() => validateJudgeReply(matches([1, ' ']), 1, 1)).toThrow(/reason/);
  });
});

describe('AMI judge retry', () => {
  it('retries a malformed reply once and then succeeds', async () => {
    const reply = matches([1, 'same'], [2, 'same']);
    const questionReply = matches([1, 'same']);
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) return 'not json';
        if (calls === 2) return reply;
        if (calls === 3) return '{"matches":[]}';
        return questionReply;
      },
    };

    const verdict = await judgeAmi(llm, input);

    expect(calls).toBe(4);
    expect(verdict.tasks.pairs).toHaveLength(2);
    expect(verdict.questions.pairs).toHaveLength(1);
  });

  it('fails loudly after two malformed replies', async () => {
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls += 1;
        return 'not json';
      },
    };

    await expect(judgeAmi(llm, input)).rejects.toThrow(/unusable reply twice/);
    expect(calls).toBe(2);
  });
});
