import { describe, expect, it, vi } from 'vitest';
import type { Fact } from '@kaki/shared';
import { createFakeLlm } from '../../src/services/llm';
import {
  CATCHUP_CHECK_SCHEMA,
  parseCatchupCheckReply,
  parseCatchupReply,
  verifyCatchupSuggestion,
  type WingmanLine,
} from '../../src/wingman/prompts';

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
  it('keeps a meeting suggestion whose quote is a real transcript line', () => {
    const raw = reply({
      suggestion: 'Should we get the figures sorted first?',
      basis: 'meeting',
      evidence: line.text,
    });
    expect(parseCatchupReply(raw, [line], [])).toEqual({
      suggestion: 'Should we get the figures sorted first?',
      evidence: line.text,
      source: 'Ada · 2026-11-22T10:00:00.000Z',
    });
  });

  it('drops a meeting suggestion whose quote is not in the transcript', () => {
    const raw = reply({
      suggestion: 'Should we get the figures sorted first?',
      basis: 'meeting',
      evidence: 'We approved a five million dollar budget.',
    });
    expect(parseCatchupReply(raw, [line], [])).toBeUndefined();
  });

  it('keeps a workspace suggestion whose quote is verbatim from that record', () => {
    const raw = reply({
      suggestion: 'Should we get the figures sorted first?',
      basis: 'workspace',
      evidence: fact.text,
      source: fact.source,
    });
    expect(parseCatchupReply(raw, [], [fact])).toEqual({
      suggestion: 'Should we get the figures sorted first?',
      evidence: fact.text,
      source: 'Wiki: Budget (2026-11-01)',
      fact,
    });
  });

  it('drops a workspace suggestion whose quote is not in the named record', () => {
    const raw = reply({
      suggestion: 'Should we get the figures sorted first?',
      basis: 'workspace',
      evidence: 'The approved budget is five million dollars.',
      source: fact.source,
    });
    expect(parseCatchupReply(raw, [], [fact])).toBeUndefined();
  });
});

describe('catch-up support check', () => {
  it('reads the model judgement instead of matching words', async () => {
    const llm = createFakeLlm(() => JSON.stringify({ supported: true }));
    const log = vi.fn();

    await expect(
      verifyCatchupSuggestion(llm, 'Should we get the figures sorted first?', line.text, log),
    ).resolves.toBe(true);
    expect(llm.callOptions[0]).toMatchObject({ json: true, schema: CATCHUP_CHECK_SCHEMA, temperature: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('returns false when the model says the evidence does not support the suggestion', async () => {
    const llm = createFakeLlm(() => JSON.stringify({ supported: false }));
    await expect(
      verifyCatchupSuggestion(llm, 'The approved budget is $5000000.', line.text, vi.fn()),
    ).resolves.toBe(false);
  });

  it('retries an unreadable judgement once, then throws so the caller drops the suggestion', async () => {
    const llm = createFakeLlm(() => JSON.stringify({ verdict: 'yes' }));
    const log = vi.fn();
    await expect(
      verifyCatchupSuggestion(llm, 'Should we get the figures sorted first?', line.text, log),
    ).rejects.toThrow('the catch-up check could not judge the suggestion after 2 attempts');
    expect(llm.calls).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not read'));
  });

  it('surfaces a clear boolean only', () => {
    expect(parseCatchupCheckReply(JSON.stringify({ supported: true }))).toBe(true);
    expect(parseCatchupCheckReply(JSON.stringify({ supported: false }))).toBe(false);
    expect(parseCatchupCheckReply(JSON.stringify({ supported: 'yes' }))).toBeUndefined();
    expect(parseCatchupCheckReply('not json')).toBeUndefined();
  });
});
