import { describe, expect, it } from 'vitest';
import {
  giteaChunk,
  mailChunk,
  mattermostThreadChunk,
  parseIssueOpenedAt,
  postgresRowChunk,
  parseMailDate,
  parseMattermostSentAt,
  parseWikiUpdatedAt,
  wikiChunks,
} from '../../src/wingman/knowledge/indexer';

describe('knowledge chunk dates and headers', () => {
  it('reads a wiki page date and puts it in every section header', () => {
    const chunks = wikiChunks({
      path: 'kopitiam/delivery-pricing',
      title: 'Nanyang Kopi & Toast - Delivery Pricing',
      content: `# Delivery pricing\n\nLast updated: 10 November 2026\n\n## Commission\n\nThe delivery app takes 32% of every order.\n\n## Notes\n\nCheck email.`,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.text.startsWith('[Wiki: Nanyang Kopi & Toast - Delivery Pricing, updated 10 Nov 2026]'))).toBe(true);
    expect(chunks.every((chunk) => chunk.publishedAt === '2026-11-10')).toBe(true);
    expect(chunks.map((chunk) => chunk.ref)).toEqual([
      'kopitiam/delivery-pricing#1-overview',
      'kopitiam/delivery-pricing#2-commission',
      'kopitiam/delivery-pricing#3-notes',
    ]);
  });

  it('accepts "Last reviewed:" and fails loudly when the wiki date is missing', () => {
    expect(parseWikiUpdatedAt('Last reviewed: 28 October 2026')).toBe('2026-10-28');
    expect(() => parseWikiUpdatedAt('No date here')).toThrow(/missing a "Last updated:"/);
  });

  it('reads the final Opened line on Gitea issues', () => {
    expect(parseIssueOpenedAt('Body\n\nOpened: 2026-11-10')).toBe('2026-11-10');
    expect(() => parseIssueOpenedAt('Body without a date')).toThrow(/Opened: YYYY-MM-DD/);

    const chunk = giteaChunk(
      {
        number: 5,
        title: 'Level 5 difficulty needs a decision',
        state: 'open',
        labels: ['playtest', 'design'],
        body: '14 of 20 quit.\n\nOpened: 2026-11-10',
      },
      'kopitiam-pos',
    );
    expect(chunk.text.startsWith('[Gitea: kopitiam-pos #5 "Level 5 difficulty needs a decision", opened 10 Nov 2026]')).toBe(true);
    expect(chunk.publishedAt).toBe('2026-11-10');
    expect(chunk.ref).toBe('#5');
  });

  it('reads Mattermost props.sent_at and groups replies into one thread chunk', () => {
    const props = { sent_at: '2026-11-10T09:05:00+08:00' };
    expect(parseMattermostSentAt(props)).toBe('2026-11-10');
    expect(() => parseMattermostSentAt({})).toThrow(/props.sent_at/);

    const chunk = mattermostThreadChunk(
      'shop-floor',
      { id: 'root', user_id: 'u1', message: 'Trial price notes', props, create_at: 1 },
      [
        {
          id: 'reply',
          root_id: 'root',
          user_id: 'u2',
          message: 'The uncles saw the new price and walked out',
          props: { sent_at: '2026-11-10T09:15:00+08:00' },
          create_at: 2,
        },
      ],
      new Map([
        ['u1', 'mei'],
        ['u2', 'arjun'],
      ]),
    );
    expect(chunk.text.startsWith('[Mattermost: #shop-floor thread, 10 Nov 2026]')).toBe(true);
    expect(chunk.text).toContain('mei: Trial price notes');
    expect(chunk.text).toContain('arjun: The uncles saw the new price and walked out');
    expect(chunk.ref).toBe('#shop-floor/root');
  });

  it('reads the Mailpit Date header', () => {
    expect(parseMailDate('2026-11-16T01:12:00Z')).toBe('2026-11-16');
    expect(() => parseMailDate('not a date')).toThrow(/invalid Date header/);

    const chunk = mailChunk({
      messageId: '<anchor-price@example>',
      subject: 'Anchor butter price notice',
      from: 'Fonterra <orders@fonterradairy.example>',
      fromAddress: 'orders@fonterradairy.example',
      date: '2026-11-16T09:12:00+08:00',
      text: 'Wholesale butter rose 35%.',
    });
    expect(chunk.text.startsWith('[Mail from Fonterradairy: Anchor butter price notice, 16 Nov 2026]')).toBe(true);
    expect(chunk.publishedAt).toBe('2026-11-16');
  });

  it('puts Postgres dates and column values in a row chunk', () => {
    const chunk = postgresRowChunk(
      'regulars_pricing',
      {
        id: 1,
        effective_on: '2026-11-10',
        old_kopi_price_sgd: '1.30',
        new_kopi_price_sgd: '2.40',
        cost_per_cup_sgd: '1.60',
        regulars_most_mornings: 40,
        notes: 'Old shop kopi price and cost per cup',
        updated_on: '2026-11-10',
      },
      'updated_on',
    );
    expect(chunk.text.startsWith('[Postgres: regulars_pricing, updated 10 Nov 2026]')).toBe(true);
    expect(chunk.text).toContain('old_kopi_price_sgd: 1.30');
    expect(chunk.text).toContain('cost_per_cup_sgd: 1.60');
    expect(chunk.ref).toBe('regulars_pricing/1');
    expect(chunk.publishedAt).toBe('2026-11-10');
  });
});
