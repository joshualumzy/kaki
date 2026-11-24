import { describe, expect, it } from 'vitest';
import type { Fact } from '@kaki/shared';
import { parseCatchupReply, type WingmanLine } from '../../src/wingman/prompts';

const line: WingmanLine = {
  speaker: 'Ada',
  text: 'We need to settle the budget.',
  timestamp: '2026-11-22T10:00:00.000Z',
};

const fact: Fact = {
  text: 'We need to settle the budget.',
  source: 'Wiki: Budget',
  date: '2026-11-01',
};

function reply(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    suggestion: '',
    basis: 'none',
    evidence: '',
    source: '',
    ...overrides,
  });
}

describe('catch-up reply grounding', () => {
  it('drops a meeting suggestion that adds a fact absent from its evidence', () => {
    const raw = reply({
      suggestion: 'The approved budget is $5000000.',
      basis: 'meeting',
      evidence: line.text,
    });
    expect(parseCatchupReply(raw, [line], [])).toBeUndefined();
  });

  it('keeps a meeting suggestion made only from its evidence words', () => {
    const raw = reply({
      suggestion: 'Ask whether we need to settle the budget.',
      basis: 'meeting',
      evidence: line.text,
    });
    expect(parseCatchupReply(raw, [line], [])).toEqual({
      suggestion: 'Ask whether we need to settle the budget.',
      source: 'Ada · 2026-11-22T10:00:00.000Z',
    });
  });

  it('drops a workspace suggestion that adds a fact absent from its evidence', () => {
    const raw = reply({
      suggestion: 'The approved budget is $5000000.',
      basis: 'workspace',
      evidence: fact.text,
      source: fact.source,
    });
    expect(parseCatchupReply(raw, [], [fact])).toBeUndefined();
  });

  it('keeps a workspace suggestion made only from its evidence words', () => {
    const raw = reply({
      suggestion: 'Ask about the budget.',
      basis: 'workspace',
      evidence: fact.text,
      source: fact.source,
    });
    expect(parseCatchupReply(raw, [], [fact])).toEqual({
      suggestion: 'Ask about the budget.',
      source: 'Wiki: Budget (2026-11-01)',
      fact,
    });
  });
});
