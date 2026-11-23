import { describe, expect, it } from 'vitest';
import {
  calendarEventApiPath,
  mattermostOpenApiPath,
  PRACTICE_CALENDAR_EVENT_ID,
  toolLink,
} from '@kaki/shared';
import { publicToolUrls } from '../../src/action/publicToolUrls';
import { accessProblem, matchRoute } from '../../src/http/access';
import { buildMeetingRouteTable } from '../../src/http/meetingRoutes';

const meetingId = 'practice-1';
const site = 'https://kaki.example.com';

const toolUrls = publicToolUrls(
  {
    KAKI_PUBLIC_URL: site,
    WIKI_URL: 'http://127.0.0.1:8081',
    GITEA_URL: 'http://127.0.0.1:8082',
    MATTERMOST_URL: 'http://127.0.0.1:8443',
    MAILPIT_URL: 'http://127.0.0.1:8084',
    WIKI_PUBLIC_URL: 'https://kaki.example.com:8081',
    GITEA_PUBLIC_URL: 'https://kaki.example.com:8082',
    MAILPIT_PUBLIC_URL: 'https://kaki.example.com:8084',
    PORT: '3001',
  },
  undefined,
);

/** The same five links the practice join form builds. */
const links = {
  wiki: toolLink(toolUrls.wiki, '/en/home'),
  gitea: toolLink(toolUrls.gitea, '/kopitiam/kopitiam-pos/issues'),
  mattermost: toolLink(
    site,
    mattermostOpenApiPath(
      meetingId,
      toolLink(toolUrls.mattermost, '/kopitiam/channels/kopitiam-launch'),
    ),
  ),
  email: toolUrls.email,
  calendar: toolLink(
    toolUrls.calendar,
    calendarEventApiPath(meetingId, PRACTICE_CALENDAR_EVENT_ID),
  ),
};

/**
 * The server's own rule for turning a browser path under one meeting into the canonical path its
 * route table answers: a rest that does not start with `/api` gains it.
 */
function canonicalMeetingPath(pathname: string): string {
  const match = /^\/api\/meetings\/([^/]+)\/(.+)$/.exec(pathname);
  if (match === null) throw new Error(`${pathname} is not under a meeting`);
  const rest = match[2] ?? '';
  return rest.startsWith('/')
    ? rest
    : rest.startsWith('dev/')
      ? `/${rest}`
      : `/api/${rest}`;
}

describe('practice company-system links', () => {
  const routes = buildMeetingRouteTable({ devRoutes: false });

  it('points every external tool at its own public address', () => {
    expect(links.wiki).toBe('https://kaki.example.com:8081/en/home');
    expect(links.gitea).toBe('https://kaki.example.com:8082/kopitiam/kopitiam-pos/issues');
    expect(links.email).toBe('https://kaki.example.com:8084');
  });

  it('keeps the Kaki-owned links under this practice meeting', () => {
    expect(new URL(links.mattermost).pathname).toBe(
      `/api/meetings/${meetingId}/mattermost/open`,
    );
    expect(new URL(links.calendar).pathname).toBe(
      `/api/meetings/${meetingId}/calendar/${PRACTICE_CALENDAR_EVENT_ID}`,
    );
    expect(links.mattermost).not.toContain('/api/api/');
    expect(links.calendar).not.toContain('/api/api/');
  });

  it('matches each Kaki-owned link to a real route in the meeting table', () => {
    const mattermost = matchRoute(
      routes,
      'GET',
      canonicalMeetingPath(new URL(links.mattermost).pathname),
    );
    expect(mattermost?.route.path).toBe('/api/mattermost/open');

    const calendar = matchRoute(
      routes,
      'GET',
      canonicalMeetingPath(new URL(links.calendar).pathname),
    );
    expect(calendar?.route.path).toBe('/api/calendar/:id');
  });

  it('lets a practice visitor open the sample Mattermost opener', () => {
    const mattermost = matchRoute(routes, 'GET', '/api/mattermost/open');
    expect(mattermost).toBeDefined();
    const context = {
      authEnabled: true,
      devRoutes: false,
      serviceTokenConfigured: false,
      loopback: false,
      proxied: false,
      rawPath: links.mattermost,
    };
    expect(accessProblem(mattermost!.route, { kind: 'practice' }, context)).toBeUndefined();
    expect(accessProblem(mattermost!.route, { kind: 'anonymous' }, context)?.status).toBe(401);
  });
});
