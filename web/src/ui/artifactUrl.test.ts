/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import type { ToolPublicUrls } from '@kaki/shared';
import { resolveArtifactUrl, toolLink } from './artifactUrl';

const localTools: ToolPublicUrls = {
  wiki: 'http://localhost:8081',
  gitea: 'http://localhost:8082',
  mattermost: 'http://localhost:8083',
  email: 'http://localhost:8084',
  calendar: 'http://localhost:3001',
};

const cloudTools: ToolPublicUrls = {
  wiki: 'http://kaki.example.com:8081',
  gitea: 'http://kaki.example.com:8082',
  mattermost: 'https://kaki.example.com:8443',
  email: 'http://kaki.example.com:8084',
  calendar: 'https://kaki.example.com',
};

describe('resolveArtifactUrl', () => {
  it('sends a sample Mattermost post through the Mattermost opener', () => {
    const resolved = resolveArtifactUrl('http://localhost:8083/kopitiam/pl/post-1', 'mattermost_post', localTools);
    expect(resolved).toContain('/api/mattermost/open?url=');
    expect(resolved).toContain(encodeURIComponent('http://localhost:8083/kopitiam/pl/post-1'));
  });

  it('opens the local Mattermost link on the server address, whatever its PORT is', () => {
    const resolved = resolveArtifactUrl(
      'http://localhost:8083/kopitiam/pl/post-1',
      'mattermost_post',
      { ...localTools, calendar: 'http://localhost:4321' },
    );
    expect(resolved.startsWith('http://localhost:4321/api/mattermost/open?url=')).toBe(true);
  });

  it('leaves a real workspace Mattermost post on its own server, with no demo opener', () => {
    const post = 'https://chat.example.com/kopitiam/pl/post-1';
    expect(resolveArtifactUrl(post, 'mattermost_post')).toBe(post);
  });

  it('never sends a Gitea issue to the Mattermost opener because its kind is not a Mattermost post', () => {
    const issue = 'http://localhost:8083/nanyang-kopitiam/kopitiam-pos/issues/7';
    expect(resolveArtifactUrl(issue, 'gitea_issue')).not.toContain('/api/mattermost/open');
    expect(resolveArtifactUrl(issue, 'gitea_issue')).toBe(issue);
  });

  it('leaves a Mattermost-looking URL alone when its kind is not a Mattermost post', () => {
    const wiki = 'http://localhost:8083/kopitiam/channels/launch';
    expect(resolveArtifactUrl(wiki, 'wiki_page')).toBe(wiki);
    expect(resolveArtifactUrl(wiki)).toBe(wiki);
  });

  it.each([
    ['gitea_issue', 'http://localhost:8082/kopitiam/kopitiam-pos/issues/7', 'http://kaki.example.com:8082/kopitiam/kopitiam-pos/issues/7'],
    ['wiki_page', 'http://localhost:8081/en/meetings/launch', 'http://kaki.example.com:8081/en/meetings/launch'],
    ['email', 'http://localhost:8084/view/message-1', 'http://kaki.example.com:8084/view/message-1'],
    ['calendar_event', 'https://kaki.example.com/api/calendar/abc', 'https://kaki.example.com/api/calendar/abc'],
  ] as const)('puts a %s result link on the server-provided public base', (kind, raw, expected) => {
    expect(resolveArtifactUrl(raw, kind, cloudTools)).toBe(expected);
  });

  it('puts a Mattermost result link on the cloud https port before opening it', () => {
    const resolved = resolveArtifactUrl(
      'http://localhost:8083/kopitiam/pl/post-1',
      'mattermost_post',
      cloudTools,
    );
    expect(resolved).toContain(
      encodeURIComponent('https://kaki.example.com:8443/kopitiam/pl/post-1'),
    );
  });

  it('builds tool links on a base that has a path', () => {
    expect(toolLink('https://kaki.example.com/wiki/', '/en/home')).toBe(
      'https://kaki.example.com/wiki/en/home',
    );
    expect(toolLink('https://kaki.example.com', 'en/home')).toBe(
      'https://kaki.example.com/en/home',
    );
  });
});
