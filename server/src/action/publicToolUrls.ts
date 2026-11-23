import type { ToolPublicUrls } from '@kaki/shared';

/** The setting that reaches each tool from the server. */
const INTERNAL_ENV = {
  wiki: 'WIKI_URL',
  gitea: 'GITEA_URL',
  mattermost: 'MATTERMOST_URL',
  email: 'MAILPIT_URL',
} as const;

/** An optional setting for the address a browser uses, when it differs from the server's. */
const PUBLIC_ENV = {
  wiki: 'WIKI_PUBLIC_URL',
  gitea: 'GITEA_PUBLIC_URL',
  mattermost: 'MATTERMOST_PUBLIC_URL',
  email: 'MAILPIT_PUBLIC_URL',
} as const;

/** The local demo's ports, used only when a tool's own setting is absent. */
const DEFAULT_PORT = {
  wiki: '8081',
  gitea: '8082',
  mattermost: '8083',
  email: '8084',
} as const;

function urlOf(raw: string | undefined): URL | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return new URL(raw.trim());
  } catch {
    return undefined;
  }
}

function withoutTrailingSlash(url: URL): string {
  return url.toString().replace(/\/+$/, '');
}

function isLoopback(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('::ffff:127.');
}

/** The address the browser is on, from KAKI_PUBLIC_URL or the request that asked. */
function siteUrl(env: NodeJS.ProcessEnv, fallbackHost: string | undefined): URL | undefined {
  return urlOf(env.KAKI_PUBLIC_URL) ?? urlOf(fallbackHost === undefined ? undefined : `http://${fallbackHost}`);
}

/**
 * The one source of the addresses a browser uses for the sample workspace's tools. It reads the
 * server's own tool settings, replaces a loopback host with the public site's host, and lets an
 * explicit `*_PUBLIC_URL` override the result (the cloud's Mattermost is on its own https port).
 */
export function publicToolUrls(
  env: NodeJS.ProcessEnv = process.env,
  fallbackHost?: string,
): ToolPublicUrls {
  const configuredSite = urlOf(env.KAKI_PUBLIC_URL);
  const site = siteUrl(env, fallbackHost);
  const host = site?.hostname ?? fallbackHost ?? '127.0.0.1';

  const baseFor = (key: keyof typeof INTERNAL_ENV): string => {
    const explicit = urlOf(env[PUBLIC_ENV[key]]);
    if (explicit !== undefined) return withoutTrailingSlash(explicit);

    const internal = urlOf(env[INTERNAL_ENV[key]]);
    if (internal === undefined) {
      return `http://${host}:${DEFAULT_PORT[key]}`;
    }
    if (isLoopback(internal.hostname)) internal.hostname = host;
    return withoutTrailingSlash(internal);
  };

  const calendarOverride = urlOf(env.CALENDAR_PUBLIC_URL);
  const calendar =
    calendarOverride !== undefined
      ? withoutTrailingSlash(calendarOverride)
      : configuredSite !== undefined
        ? withoutTrailingSlash(configuredSite)
        : `http://${host}:${env.PORT ?? '3001'}`;

  return {
    wiki: baseFor('wiki'),
    gitea: baseFor('gitea'),
    mattermost: baseFor('mattermost'),
    email: baseFor('email'),
    calendar,
  };
}

/** Rebuild an artifact URL on its tool's public base, keeping its path, query and hash. */
export function publicArtifactUrl(rawUrl: string, base: string | undefined): string {
  if (base === undefined) return rawUrl;
  try {
    const raw = new URL(rawUrl);
    const publicBase = new URL(base);
    raw.protocol = publicBase.protocol;
    raw.host = publicBase.host;
    const prefix = publicBase.pathname.replace(/\/+$/, '');
    if (prefix !== '' && !raw.pathname.startsWith(`${prefix}/`) && raw.pathname !== prefix) {
      raw.pathname = `${prefix}${raw.pathname.startsWith('/') ? '' : '/'}${raw.pathname}`;
    }
    return raw.toString();
  } catch {
    return rawUrl;
  }
}
