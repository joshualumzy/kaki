import { describe, expect, it } from 'vitest';
import type { AgendaItem } from '@kaki/shared';
import {
  checkTranscriptQuality,
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


