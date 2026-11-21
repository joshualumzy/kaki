/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { resolveArtifactUrl } from './artifactUrl';

describe('resolveArtifactUrl', () => {
  it('sends a Mattermost post through the Mattermost opener', () => {
    const resolved = resolveArtifactUrl(
      'http://localhost:8083/kopitiam/pl/post-1',
      'mattermost_post',
    );
    expect(resolved).toContain('/api/mattermost/open?url=');
    expect(resolved).toContain(encodeURIComponent('http://localhost:8083/kopitiam/pl/post-1'));
  });

  it('never sends a Gitea issue to the Mattermost opener because its path names the kopitiam repo', () => {
    const issue = 'http://localhost:8083/nanyang-kopitiam/kopitiam-pos/issues/7';
    expect(resolveArtifactUrl(issue, 'gitea_issue')).not.toContain('/api/mattermost/open');
    expect(resolveArtifactUrl(issue, 'gitea_issue')).toBe(issue);
  });

  it('leaves a Mattermost-looking URL alone when its kind is not a Mattermost post', () => {
    const wiki = 'http://localhost:8083/kopitiam/channels/launch';
    expect(resolveArtifactUrl(wiki, 'wiki_page')).toBe(wiki);
    expect(resolveArtifactUrl(wiki)).toBe(wiki);
  });
});
