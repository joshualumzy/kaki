import { describe, expect, it } from 'vitest';
import { parseEnvFile, serializeEnv } from './env';
import { parseGiteaSeed, parseMailSeed, parseMattermostSeed, parseWikiManifest } from './scenario';

describe('env files', () => {
  it('parses comments, blank lines and quoted values', () => {
    expect(
      parseEnvFile(`
        # comment
        WIKI_URL="http://127.0.0.1:8081"
        GITEA_TOKEN='abc=def'
        EMPTY=
      `),
    ).toEqual({
      WIKI_URL: 'http://127.0.0.1:8081',
      GITEA_TOKEN: 'abc=def',
      EMPTY: '',
    });
  });

  it('serializes values in a stable order', () => {
    const first = serializeEnv({ WIKI_URL: 'http://wiki', POSTGRES_PORT: '5433' });
    const second = serializeEnv({ POSTGRES_PORT: '5433', WIKI_URL: 'http://wiki' });
    expect(first).toBe(second);
    expect(first).toContain('WIKI_URL=http://wiki');
    expect(first).toContain('POSTGRES_PORT=5433');
  });
});

describe('seed manifests', () => {
  it('rejects wiki pages that escape the seed folder', () => {
    expect(() =>
      parseWikiManifest({
        pages: [{ path: 'ok', title: 'Ok', description: 'Ok', file: '../secret.md' }],
      }),
    ).toThrow(/relative file name/);
  });

  it('accepts a valid wiki manifest', () => {
    expect(
      parseWikiManifest({
        pages: [{ path: 'hawker-heroes/game-design', title: 'Design', description: 'Doc', file: 'design.md' }],
      }).pages,
    ).toHaveLength(1);
  });

  it('rejects Mattermost posts with unknown authors or duplicate keys', () => {
    const base = {
      team: { name: 'pixel-kampung', display_name: 'Pixel Kampung' },
      users: [
        {
          username: 'mei',
          email: 'mei@example.test',
          first_name: 'Mei',
          last_name: '',
        },
      ],
      channels: [{ name: 'playtest-feedback', display_name: 'Playtest', purpose: 'Feedback' }],
      posts: [
        {
          key: 'root',
          channel: 'playtest-feedback',
          author: 'mei',
          at: '2026-11-10T09:05:00+08:00',
          text: 'Level 5',
        },
      ],
    };

    expect(parseMattermostSeed(base).posts).toHaveLength(1);
    expect(() =>
      parseMattermostSeed({ ...base, posts: [...base.posts, { ...base.posts[0], key: 'root', text: 'Again' }] }),
    ).toThrow(/duplicate post key/);
    expect(() => parseMattermostSeed({ ...base, posts: [{ ...base.posts[0], author: 'nobody' }] })).toThrow(
      /is not defined in users/,
    );
  });

  it('parses Gitea issues and requires a state', () => {
    const seed = parseGiteaSeed({
      repository: { name: 'hawker-heroes', description: 'Game', private: false },
      labels: [{ name: 'bug', color: 'd73a4a' }],
      issues: [
        {
          title: 'Save-file corruption',
          state: 'closed',
          labels: ['bug'],
          body: 'Fixed',
          createdAt: '2026-10-18T10:20:00+08:00',
          closedAt: '2026-10-22T17:40:00+08:00',
        },
      ],
    });
    expect(seed.issues[0]?.state).toBe('closed');

    expect(() =>
      parseGiteaSeed({
        repository: { name: 'repo', description: 'Game', private: false },
        labels: [],
        issues: [{ title: 'Broken', state: 'done', labels: [], body: 'x' }],
      }),
    ).toThrow(/state/);
  });

  it('parses emails and rejects an invalid date', () => {
    const email = {
      from: { name: 'Priya', address: 'priya@starfruit.example' },
      to: [{ name: 'Wei Ling', address: 'wei.ling@pixelkampung.example' }],
      subject: 'Build date',
      date: '2026-11-16T09:12:00+08:00',
      messageId: '<one@starfruit.example>',
      text: 'Due on 17 November 2026.',
    };
    expect(parseMailSeed({ emails: [email] })[0]?.subject).toBe('Build date');
    expect(() => parseMailSeed({ emails: [{ ...email, date: 'not a date' }] })).toThrow(/ISO date/);
  });
});
