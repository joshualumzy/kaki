import { describe, expect, it } from 'vitest';
import { couldBeReplyControlLine, isReplyControlLine, parseReplyControl } from '../../src/npc/replyControl';

const base = { state: 'open' };
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

describe('reply control header spelling', () => {
  it.each([
    'KAKI_CONTROL {"state":"open"}',
    'KAKI CONTROL {"state":"open"}',
    'KAKI\tCONTROL {"state":"open"}',
    'KAKI-CONTROL {"state":"open"}',
    '  KAKI  CONTROL {"state":"open"}',
  ])('treats %j as a hidden control line', (line) => {
    expect(isReplyControlLine(line)).toBe(true);
    expect(parseReplyControl(line)).toEqual({ state: 'open' });
  });

  it('treats a partial spelling across chunks as a possible control line', () => {
    for (const partial of ['K', 'KAKI', 'KAKI ', 'KAKI C', 'KAKI CON', 'KAKI_CONT', 'KAKI-CON']) {
      expect(couldBeReplyControlLine(partial)).toBe(true);
    }
    expect(couldBeReplyControlLine('Kaki, can you hear me?')).toBe(false);
  });
});
