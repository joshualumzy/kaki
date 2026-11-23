import { describe, expect, it } from 'vitest';
import { publicToolUrls } from '../../src/action/publicToolUrls';

const localEnv = {
  PORT: '3001',
  WIKI_URL: 'http://127.0.0.1:8081',
  GITEA_URL: 'http://127.0.0.1:8082',
  MATTERMOST_URL: 'http://127.0.0.1:8083',
  MAILPIT_URL: 'http://127.0.0.1:8084',
  CALDAV_URL: 'http://127.0.0.1:5232',
};

describe('publicToolUrls', () => {
  it('follows the host the browser used in a local run', () => {
    expect(publicToolUrls(localEnv, '192.168.1.20')).toEqual({
      wiki: 'http://192.168.1.20:8081',
      gitea: 'http://192.168.1.20:8082',
      mattermost: 'http://192.168.1.20:8083',
      email: 'http://192.168.1.20:8084',
      calendar: 'http://192.168.1.20:3001',
    });
  });

  it('builds the cloud addresses from the site and each tool setting', () => {
    expect(
      publicToolUrls({
        ...localEnv,
        KAKI_PUBLIC_URL: 'https://kaki.example.com',
        MATTERMOST_PUBLIC_URL: 'https://kaki.example.com:8443',
      }),
    ).toEqual({
      wiki: 'http://kaki.example.com:8081',
      gitea: 'http://kaki.example.com:8082',
      mattermost: 'https://kaki.example.com:8443',
      email: 'http://kaki.example.com:8084',
      calendar: 'https://kaki.example.com',
    });
  });

  it('lets an explicit public tool URL win, so a tool can move to https or a path', () => {
    const urls = publicToolUrls({
      ...localEnv,
      KAKI_PUBLIC_URL: 'https://kaki.example.com',
      WIKI_PUBLIC_URL: 'https://docs.example.com/wiki/',
      GITEA_PUBLIC_URL: 'https://code.example.com/',
      MAILPIT_PUBLIC_URL: 'https://mail.example.com/',
      CALENDAR_PUBLIC_URL: 'https://calendar.example.com/',
    });
    expect(urls.wiki).toBe('https://docs.example.com/wiki');
    expect(urls.gitea).toBe('https://code.example.com');
    expect(urls.email).toBe('https://mail.example.com');
    expect(urls.calendar).toBe('https://calendar.example.com');
  });
});
