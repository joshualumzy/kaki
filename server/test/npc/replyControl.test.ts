import { describe, expect, it } from 'vitest';
import { parseReplyControl } from '../../src/npc/replyControl';

const base = { state: 'open', wingmanNeeded: false };
const parse = (fields: Record<string, unknown>, logs: string[]) =>
  parseReplyControl(`KAKI_CONTROL ${JSON.stringify({ ...base, ...fields })}`, (line) => logs.push(line));

describe('reply control optional fields', () => {
  it('keeps two short new facts, two AI reactions, and an earlier title', () => {
    const logs: string[] = [];
    expect(parse({ newFacts: ['A small cost applies.', 'The supplier can deliver.'],
      reactions: [{ who: 'Ada', emoji: '👍' }, { who: 'Bao', emoji: '⏰' }], reopen: 'Prep' }, logs))
      .toMatchObject({ newFacts: ['A small cost applies.', 'The supplier can deliver.'],
        reactions: [{ who: 'Ada', emoji: '👍' }, { who: 'Bao', emoji: '⏰' }], reopen: 'Prep' });
    expect(logs).toEqual([]);
  });

  it('drops a bad optional field while retaining the other fields and state', () => {
    const logs: string[] = [];
    expect(parse({ state: 'settled', newFacts: ['A detail.'], reactions: [{ who: 'Ada', emoji: '🔥' }] }, logs))
      .toMatchObject({ state: 'settled', newFacts: ['A detail.'] });
    expect(logs).toEqual([expect.stringContaining('[control] dropped reactions')]);
  });

  it('drops malformed and oversized optional fields loudly', () => {
    const logs: string[] = [];
    const control = parse({ newFacts: ['one', 'two', 'three'], reactions: '👍', reopen: 42 }, logs);
    expect(control).toEqual(base);
    expect(logs).toHaveLength(3);
    expect(logs.every((line) => line.startsWith('[control]'))).toBe(true);
  });
});
