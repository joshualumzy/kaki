import { describe, expect, it } from 'vitest';
import { planPosts } from './mattermost';
import type { MmPost } from './mattermost';
import type { MattermostPostSeed } from './scenario';

const authorIds = new Map([
  ['weiling', 'user-weiling'],
  ['daniel', 'user-daniel'],
]);

function post(id: string, message: string, userId: string, rootId = ''): MmPost {
  return { id, message, user_id: userId, root_id: rootId };
}

function seed(
  text: string,
  author: string,
  extra: Partial<MattermostPostSeed> = {},
): MattermostPostSeed {
  return { channel: 'opening-day', author, at: '2026-11-11T06:50:00+08:00', text, ...extra };
}

function existingByChannel(posts: MmPost[]): Map<string, MmPost[]> {
  return new Map([['opening-day', posts]]);
}

describe('planPosts', () => {
  it('recreates a changed root and its reply, deleting the old thread', () => {
    const rootText = 'Siti texted: she is out for a family emergency.';
    const replyText = 'The flyers went to about 200 offices.';
    const plan = planPosts(
      existingByChannel([
        post('old-root', 'Old opening text.', 'user-weiling'),
        post('old-reply', replyText, 'user-daniel', 'old-root'),
      ]),
      [
        seed(rootText, 'weiling', { key: 'trial1' }),
        seed(replyText, 'daniel', { replyToKey: 'trial1' }),
      ],
      authorIds,
    );

    expect(plan.entries[0]?.existing).toBeUndefined();
    expect(plan.entries[1]?.existing).toBeUndefined();
    expect(plan.deleteIds).toEqual(expect.arrayContaining(['old-root', 'old-reply']));
    expect(plan.deleteIds).toHaveLength(2);
  });

  it('reuses everything when nothing changed and deletes nothing', () => {
    const rootText = 'Siti texted: she is out for a family emergency.';
    const replyText = 'The flyers went to about 200 offices.';
    const plan = planPosts(
      existingByChannel([
        post('root', rootText, 'user-weiling'),
        post('reply', replyText, 'user-daniel', 'root'),
      ]),
      [
        seed(rootText, 'weiling', { key: 'trial1' }),
        seed(replyText, 'daniel', { replyToKey: 'trial1' }),
      ],
      authorIds,
    );

    expect(plan.entries[0]?.existing?.id).toBe('root');
    expect(plan.entries[1]?.existing?.id).toBe('reply');
    expect(plan.deleteIds).toEqual([]);
  });

  it('does not reuse the same text written by a different author', () => {
    const text = 'The flyers went to about 200 offices.';
    const plan = planPosts(
      existingByChannel([post('other-author', text, 'user-mei')]),
      [seed(text, 'daniel')],
      authorIds,
    );

    expect(plan.entries[0]?.existing).toBeUndefined();
    expect(plan.deleteIds).toEqual(['other-author']);
  });

  it('reuses a reply when its root is unchanged', () => {
    const rootText = 'Siti texted: she is out for a family emergency.';
    const replyText = 'The flyers went to about 200 offices.';
    const plan = planPosts(
      existingByChannel([
        post('root', rootText, 'user-weiling'),
        post('reply', replyText, 'user-daniel', 'root'),
        post('stale', 'An old post nobody needs.', 'user-weiling'),
      ]),
      [
        seed(rootText, 'weiling', { key: 'trial1' }),
        seed(replyText, 'daniel', { replyToKey: 'trial1' }),
      ],
      authorIds,
    );

    expect(plan.entries[0]?.existing?.id).toBe('root');
    expect(plan.entries[1]?.existing?.id).toBe('reply');
    expect(plan.deleteIds).toEqual(['stale']);
  });

  it('reuses each existing post at most once', () => {
    const text = 'The flyers went to about 200 offices.';
    const plan = planPosts(
      existingByChannel([
        post('first', text, 'user-daniel'),
        post('second', text, 'user-daniel'),
      ]),
      [seed(text, 'daniel')],
      authorIds,
    );

    expect(plan.entries[0]?.existing?.id).toBe('first');
    expect(plan.deleteIds).toEqual(['second']);
  });
});
