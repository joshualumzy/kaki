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

describe('AMI judge validation', () => {
  it('accepts a one-to-one matching that accounts for every item', () => {
    const reply = JSON.stringify({
      pairs: [
        { found: 1, gold: 1, reason: 'Both send the slides to the team.' },
        { found: 2, gold: 2, reason: 'Writing minutes is the same task.' },
      ],
      unmatchedFound: [],
      unmatchedGold: [],
    });

    expect(validateJudgeReply(reply, 2, 2)).toEqual({
      pairs: [
        { found: 1, gold: 1, reason: 'Both send the slides to the team.' },
        { found: 2, gold: 2, reason: 'Writing minutes is the same task.' },
      ],
      unmatchedFound: [],
      unmatchedGold: [],
    });
  });

  it('rejects an item used in both a pair and an unmatched list', () => {
    const reply = JSON.stringify({
      pairs: [{ found: 1, gold: 1, reason: 'same' }],
      unmatchedFound: [1],
      unmatchedGold: [],
    });

    expect(() => validateJudgeReply(reply, 1, 1)).toThrow(/more than once/);
  });

  it('lets one found item cover several gold items but matches each gold item once', () => {
    const covering = JSON.stringify({
      pairs: [
        { found: 1, gold: 1, reason: 'minutes' },
        { found: 1, gold: 2, reason: 'slides' },
      ],
      unmatchedFound: [],
      unmatchedGold: [],
    });
    const goldTwice = JSON.stringify({
      pairs: [
        { found: 1, gold: 1, reason: 'same' },
        { found: 2, gold: 1, reason: 'same again' },
      ],
      unmatchedFound: [],
      unmatchedGold: [],
    });

    expect(validateJudgeReply(covering, 1, 2).pairs).toHaveLength(2);
    expect(() => validateJudgeReply(goldTwice, 2, 1)).toThrow(/gold index 1 appears more than once/);
  });

  it('rejects a reply that leaves an item unaccounted for', () => {
    const reply = JSON.stringify({ pairs: [], unmatchedFound: [], unmatchedGold: [] });

    expect(() => validateJudgeReply(reply, 1, 1)).toThrow(/accounts for/);
  });

  it('rejects out-of-range and non-integer indices', () => {
    const outOfRange = JSON.stringify({
      pairs: [{ found: 2, gold: 1, reason: 'same' }],
      unmatchedFound: [],
      unmatchedGold: [],
    });
    const nonInteger = JSON.stringify({
      pairs: [{ found: 1.5, gold: 1, reason: 'same' }],
      unmatchedFound: [],
      unmatchedGold: [],
    });

    expect(() => validateJudgeReply(outOfRange, 1, 1)).toThrow(/1 to 1/);
    expect(() => validateJudgeReply(nonInteger, 2, 1)).toThrow(/1 to 2/);
  });
});

describe('AMI judge retry', () => {
  it('retries a malformed reply once and then succeeds', async () => {
    const reply = JSON.stringify({
      pairs: [
        { found: 1, gold: 1, reason: 'same' },
        { found: 2, gold: 2, reason: 'same' },
      ],
      unmatchedFound: [],
      unmatchedGold: [],
    });
    const questionReply = JSON.stringify({
      pairs: [{ found: 1, gold: 1, reason: 'same' }],
      unmatchedFound: [],
      unmatchedGold: [],
    });
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls += 1;
        if (calls === 1) return 'not json';
        if (calls === 2) return reply;
        if (calls === 3) return '{"pairs":[]}';
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
