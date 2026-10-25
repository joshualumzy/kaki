import { describe, expect, it } from 'vitest';
import {
  budgetChunk,
  giteaChunk,
  mailChunk,
  mattermostThreadChunk,
  parseIssueOpenedAt,
  parseMailDate,
  parseMattermostSentAt,
  parseWikiUpdatedAt,
  quitStatChunk,
  wikiChunks,
  wishlistChunk,
} from '../src/wingman/knowledge/indexer';

describe('knowledge chunk dates and headers', () => {
  it('reads a wiki page date and puts it in every section header', () => {
    const chunks = wikiChunks({
      path: 'hawker-heroes/publisher-contract',
      title: 'Starfruit Publishing - Contract Summary',
      content: `# Contract\n\nLast updated: 10 November 2026\n\n## Milestones\n\nFinal build 20 November.\n\n## Notes\n\nCheck email.`,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.text.startsWith('[Wiki: Starfruit Publishing - Contract Summary, updated 10 Nov 2026]'))).toBe(true);
    expect(chunks.every((chunk) => chunk.publishedAt === '2026-11-10')).toBe(true);
    expect(chunks.map((chunk) => chunk.ref)).toEqual([
      'hawker-heroes/publisher-contract#1-overview',
      'hawker-heroes/publisher-contract#2-milestones',
      'hawker-heroes/publisher-contract#3-notes',
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
      'hawker-heroes',
    );
    expect(chunk.text.startsWith('[Gitea: hawker-heroes #5 "Level 5 difficulty needs a decision", opened 10 Nov 2026]')).toBe(true);
    expect(chunk.publishedAt).toBe('2026-11-10');
    expect(chunk.ref).toBe('#5');
  });

  it('reads Mattermost props.sent_at and groups replies into one thread chunk', () => {
    const props = { sent_at: '2026-11-10T09:05:00+08:00' };
    expect(parseMattermostSentAt(props)).toBe('2026-11-10');
    expect(() => parseMattermostSentAt({})).toThrow(/props.sent_at/);

    const chunk = mattermostThreadChunk(
      'playtest-feedback',
      { id: 'root', user_id: 'u1', message: 'Level 5 spike', props, create_at: 1 },
      [
        {
          id: 'reply',
          root_id: 'root',
          user_id: 'u2',
          message: 'That is the point',
          props: { sent_at: '2026-11-10T09:15:00+08:00' },
          create_at: 2,
        },
      ],
      new Map([
        ['u1', 'mei'],
        ['u2', 'arjun'],
      ]),
    );
    expect(chunk.text.startsWith('[Mattermost: #playtest-feedback thread, 10 Nov 2026]')).toBe(true);
    expect(chunk.text).toContain('mei: Level 5 spike');
    expect(chunk.text).toContain('arjun: That is the point');
    expect(chunk.ref).toBe('#playtest-feedback/root');
  });

  it('reads the Mailpit Date header', () => {
    expect(parseMailDate('2026-11-16T01:12:00Z')).toBe('2026-11-16');
    expect(() => parseMailDate('not a date')).toThrow(/invalid Date header/);

    const chunk = mailChunk({
      messageId: '<starfruit@example>',
      subject: 'Final build date moved up',
      from: 'Priya <priya@starfruit.example>',
      fromAddress: 'priya@starfruit.example',
      date: '2026-11-16T09:12:00+08:00',
      text: 'Deliver by 17 November.',
    });
    expect(chunk.text.startsWith('[Mail from Starfruit: Final build date moved up, 16 Nov 2026]')).toBe(true);
    expect(chunk.publishedAt).toBe('2026-11-16');
  });

  it('puts Postgres dates in the quit, wishlist and budget headers', () => {
    const quit = quitStatChunk({
      level: 5,
      players_started: 29,
      players_quit: 19,
      quit_rate: '65.52',
      notes: 'Boss order',
      updated_on: '2026-11-10',
    });
    expect(quit.text.startsWith('[Postgres: playtest quit stats, level 5, updated 10 Nov 2026]')).toBe(true);
    expect(quit.text).toContain('65.52%');

    const wishlist = wishlistChunk([
      { captured_on: '2026-10-19', wishlists: 1840 },
      { captured_on: '2026-11-09', wishlists: 3120 },
    ]);
    expect(wishlist.text.startsWith('[Postgres: wishlist counts, updated 9 Nov 2026]')).toBe(true);

    const budget = budgetChunk({
      item: 'Launch trailer',
      planned_sgd: '300.00',
      spent_sgd: '0.00',
      notes: null,
      updated_on: '2026-11-11',
    });
    expect(budget.text.startsWith('[Postgres: launch budget - Launch trailer, updated 11 Nov 2026]')).toBe(true);
  });
});
