import { describe, expect, it, vi } from 'vitest';
import { logMissingActionConfig, missingActionEnv } from '../../src/action';

describe('action tool configuration', () => {
  it('lists the environment variables missing for every action kind', () => {
    expect(missingActionEnv({})).toEqual({
      gitea_issue: ['GITEA_URL', 'GITEA_TOKEN', 'GITEA_ORG', 'GITEA_REPO'],
      mattermost_post: ['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM', 'MATTERMOST_CHANNEL'],
      email: ['MAILPIT_SMTP_HOST', 'MAILPIT_SMTP_PORT', 'MAILPIT_URL', 'EMAIL_FROM'],
      wiki_page: ['WIKI_URL', 'WIKI_ADMIN_EMAIL', 'WIKI_ADMIN_PASSWORD'],
      calendar_event: ['CALDAV_URL'],
    });
  });

  it('logs one loud error naming each unconfigured kind and only its variable names', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      logMissingActionConfig({ GITEA_TOKEN: 'super-secret-token' });

      expect(error).toHaveBeenCalledTimes(1);
      const message = String(error.mock.calls[0]?.[0]);
      for (const kind of ['gitea_issue', 'mattermost_post', 'email', 'wiki_page', 'calendar_event']) {
        expect(message).toContain(kind);
      }
      expect(message).toContain('GITEA_URL');
      expect(message).not.toContain('super-secret-token');
    } finally {
      error.mockRestore();
    }
  });

  it('stays quiet when every action tool is configured', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      logMissingActionConfig({
        GITEA_URL: 'https://gitea.test',
        GITEA_TOKEN: 'token',
        GITEA_ORG: 'org',
        GITEA_REPO: 'repo',
        MATTERMOST_URL: 'https://mattermost.test',
        MATTERMOST_TOKEN: 'token',
        MATTERMOST_TEAM: 'team',
        MATTERMOST_CHANNEL: 'channel',
        MAILPIT_SMTP_HOST: '127.0.0.1',
        MAILPIT_SMTP_PORT: '1025',
        MAILPIT_URL: 'https://mailpit.test',
        EMAIL_FROM: 'kaki@example.test',
        WIKI_URL: 'https://wiki.test',
        WIKI_ADMIN_EMAIL: 'admin@example.test',
        WIKI_ADMIN_PASSWORD: 'password',
        CALDAV_URL: 'https://caldav.test',
      });

      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
