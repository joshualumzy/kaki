import { describe, expect, it } from 'vitest';
import { createSpeechLineOrder, type OrderedSpeechLine } from '../../src/npc/speechOrder';

describe('createSpeechLineOrder', () => {
  it('holds a later speaker until the earlier speaker has settled, then emits in speech order', () => {
    const lines: Array<OrderedSpeechLine<string>> = [];
    const order = createSpeechLineOrder<string>((line) => lines.push(line));

    order.begin({ id: 'alice-1', startedAt: 1000 });
    order.begin({ id: 'ben-1', startedAt: 1500 });
    // Ben's recognition finishes first, but Alice started speaking first.
    order.settle({ id: 'ben-1', startedAt: 1500, endedAt: 2500 }, 'Ben line');
    expect(lines).toEqual([]);

    order.settle({ id: 'alice-1', startedAt: 1000, endedAt: 2200 }, 'Alice line');
    expect(lines.map((line) => line.value)).toEqual(['Alice line', 'Ben line']);
    expect(lines[1]?.overlap).toBe(true);
    expect(lines[0]?.overlap).toBe(false);
  });

  it('does not hold anyone behind a stretch that produced no line', () => {
    const lines: Array<OrderedSpeechLine<string>> = [];
    const order = createSpeechLineOrder<string>((line) => lines.push(line));

    order.begin({ id: 'cough', startedAt: 1000 });
    order.begin({ id: 'words', startedAt: 2000 });
    order.settle({ id: 'words', startedAt: 2000, endedAt: 3000 }, 'The line');
    expect(lines).toEqual([]);

    order.settle({ id: 'cough', startedAt: 1000, endedAt: 1200 });
    expect(lines.map((line) => line.value)).toEqual(['The line']);
    expect(lines[0]?.overlap).toBe(false);
  });

  it('marks overlap only when the next speech began before that line ended', () => {
    const lines: Array<OrderedSpeechLine<string>> = [];
    const order = createSpeechLineOrder<string>((line) => lines.push(line));

    order.begin({ id: 'one', startedAt: 1000 });
    order.settle({ id: 'one', startedAt: 1000, endedAt: 2000 }, 'One');
    order.begin({ id: 'two', startedAt: 2100 });
    order.settle({ id: 'two', startedAt: 2100, endedAt: 3000 }, 'Two');
    order.begin({ id: 'three', startedAt: 2900 });
    order.settle({ id: 'three', startedAt: 2900, endedAt: 4000 }, 'Three');

    expect(lines.map((line) => [line.value, line.overlap])).toEqual([
      ['One', false],
      ['Two', false],
      ['Three', true],
    ]);
  });
});
