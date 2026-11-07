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
      path: 'kopitiam/mall-promo-rules',
      title: 'Raffles Place Flagship - Kaya Butter Toast Costing & Launch Budget',
      content: `# Butter costing\n\nLast updated: 10 November 2026\n\n## Butter cost\n\nDoubling butter to 20g costs SGD 1,100/month.\n\n## Notes\n\nCheck email.`,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.text.startsWith('[Wiki: Raffles Place Flagship - Kaya Butter Toast Costing & Launch Budget, updated 10 Nov 2026]'))).toBe(true);
    expect(chunks.every((chunk) => chunk.publishedAt === '2026-11-10')).toBe(true);
    expect(chunks.map((chunk) => chunk.ref)).toEqual([
      'kopitiam/mall-promo-rules#1-overview',
      'kopitiam/mall-promo-rules#2-butter-cost',
      'kopitiam/mall-promo-rules#3-notes',
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
      'kiosk-trials',
      { id: 'root', user_id: 'u1', message: 'Kiosk trial spike', props, create_at: 1 },
      [
        {
          id: 'reply',
          root_id: 'root',
          user_id: 'u2',
          message: 'That is the point, the toggle is too small',
          props: { sent_at: '2026-11-10T09:15:00+08:00' },
          create_at: 2,
        },
      ],
      new Map([
        ['u1', 'mei'],
        ['u2', 'arjun'],
      ]),
    );
    expect(chunk.text.startsWith('[Mattermost: #kiosk-trials thread, 10 Nov 2026]')).toBe(true);
    expect(chunk.text).toContain('mei: Kiosk trial spike');
    expect(chunk.text).toContain('arjun: That is the point, the toggle is too small');
    expect(chunk.ref).toBe('#kiosk-trials/root');
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
      'kiosk_trial_stats',
      {
        id: 1,
        trial_date: '2026-11-10',
        first_time_users: 28,
        froze_at_kopi_o_kosong: 19,
        missed_language_toggle_pct: '72.00',
        notes: 'First-time users froze on Step 2',
        updated_on: '2026-11-10',
      },
      'updated_on',
    );
    expect(chunk.text.startsWith('[Postgres: kiosk_trial_stats, updated 10 Nov 2026]')).toBe(true);
    expect(chunk.text).toContain('first_time_users: 28');
    expect(chunk.text).toContain('missed_language_toggle_pct: 72.00');
    expect(chunk.ref).toBe('kiosk_trial_stats/1');
    expect(chunk.publishedAt).toBe('2026-11-10');
  });
});
