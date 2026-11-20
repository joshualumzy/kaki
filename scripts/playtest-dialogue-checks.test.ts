import { describe, expect, it } from 'vitest';
import type { AgendaItem } from '@kaki/shared';
import {
  checkTranscriptQuality,
  checkWingmanOutput,
  isVisitorTradeOff,
  type UtteranceRecord,
} from './playtest-dialogue-checks';

const item: AgendaItem = {
  title: 'Delivery app commission squeeze',
  minutes: 5,
  canWait: false,
  deadline: 'before the lunch rush',
  ownerRole: 'marketing_lead',
  decision: 'Do we keep single sets or push the office platter?',
  discussion: {
    openingViews: [{ attendee: 'Arjun', angle: 'The POS fees are eating the margin.' }],
    tradeOffs: [
      {
        attendee: 'Mei', role: 'menu_store_lead', idea: 'drop the single sets',
        tradeOff: 'Margin first: dropping single sets protects every tray', question: 'Which orders do we keep?',
      },
      {
        attendee: 'Wei Ling', role: 'operations_director', idea: 'keep single sets',
        tradeOff: 'Regulars first: the lunchtime regulars still want single sets', question: 'How do we keep them?',
      },
    ],
  },
};

const visitor = { name: 'Foo', role: 'operations_director', seat: 'Wei Ling' };

describe('dialogue turn checks', () => {
  const good: UtteranceRecord[] = [
    { speaker: 'Sam', text: 'Delivery app commission squeeze is next.' },
    { speaker: 'Arjun', text: 'The commission is eating the margin on every single set.' },
    { speaker: 'Mei', text: 'The commission kills the margin, so should we push the platter, Foo?' },
  ];

  it('passes a briefing with the host and two colleagues', () => {
    expect(checkTranscriptQuality(item, good, visitor)).toEqual([]);
  });

  it('fails when the host never opened the item', () => {
    const failures = checkTranscriptQuality(item, good.slice(1), visitor);
    expect(failures.join(' | ')).toMatch(/Host.*never opened/);
  });

  it('fails when the second colleague never spoke', () => {
    const failures = checkTranscriptQuality(item, [good[0]!, good[1]!], visitor);
    expect(failures.join(' | ')).toMatch(/Speaker 2 never spoke/);
  });
});

describe('Wingman output checks', () => {
  it('treats the visitor seat and role as their own seat', () => {
    expect(isVisitorTradeOff({ attendee: 'Wei Ling', role: 'operations_director' }, visitor)).toBe(true);
    expect(isVisitorTradeOff({ attendee: 'Foo', role: 'marketing_lead' }, visitor)).toBe(true);
    expect(isVisitorTradeOff({ attendee: 'Mei', role: 'menu_store_lead' }, visitor)).toBe(false);
  });

  it('passes a raised catch and live tip for other seats on this topic', () => {
    expect(checkWingmanOutput(item, 4, visitor, [
      { tip: 'The platter makes money; single sets do not.', title: item.title, agendaIndex: 4 },
    ], [
      { speaker: 'Mei', text: 'Dropping single sets protects every tray.', catchId: '4:catch:0' },
    ])).toEqual([]);
  });

  it('fails loudly when no Wingman output was emitted', () => {
    const failures = checkWingmanOutput(item, 4, visitor, [], []);
    expect(failures.join(' | ')).toMatch(/No Wingman output was emitted.*seat exclusion was not exercised/);
  });

  it('fails when an emitted catch exposes the visitor own seat', () => {
    const failures = checkWingmanOutput(item, 4, visitor, [], [
      { speaker: 'Wei Ling', text: 'The regulars still want single sets.', catchId: '4:catch:1' },
    ]);
    expect(failures.join(' | ')).toMatch(/exposed the visitor's own seat \(Wei Ling\)/);
  });

  it('fails a catch for another topic or a trade-off that does not exist', () => {
    const failures = checkWingmanOutput(item, 4, visitor, [], [
      { speaker: 'Mei', text: 'A delivery catch.', catchId: '2:catch:0' },
      { speaker: 'Mei', text: 'A missing catch.', catchId: '4:catch:9' },
      { speaker: 'Mei', text: 'A broken catch.', catchId: 'not-a-catch' },
    ]);
    expect(failures.join(' | ')).toMatch(/belongs to item 3/);
    expect(failures.join(' | ')).toMatch(/does not exist/);
    expect(failures.join(' | ')).toMatch(/unusable catch id/);
  });

  it('fails a live tip that belongs to another topic', () => {
    const failures = checkWingmanOutput(item, 4, visitor, [
      { tip: 'A tip.', title: 'Food safety complaint', agendaIndex: 1 },
    ], []);
    expect(failures.join(' | ')).toMatch(/not "Delivery app commission squeeze"/);
  });
});
