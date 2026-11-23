import type { ActionKind, ToolPublicUrls } from '@kaki/shared';

const TOOL_FOR_KIND = {
  gitea_issue: 'gitea',
  mattermost_post: 'mattermost',
  wiki_page: 'wiki',
  email: 'email',
  calendar_event: 'calendar',
} as const satisfies Record<ActionKind, keyof ToolPublicUrls>;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('::ffff:127.');
}

/**
 * Rebuild one link on a public tool base, keeping its path, query and hash. The server may only
 * know its loopback address in a local run, so a phone's hostname replaces it there.
 */
function withPublicBase(rawUrl: string, base: string, currentHost: string): string {
  try {
    const raw = new URL(rawUrl);
    const publicBase = new URL(base);
    if (isLoopbackHost(publicBase.hostname) && currentHost !== '' && !isLoopbackHost(currentHost)) {
      publicBase.hostname = currentHost;
    }
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

/** Join a path onto a tool's public base, whether the base has a path of its own or not. */
export function toolLink(base: string, path: string): string {
  const clean = base.replace(/\/+$/, '');
  return `${clean}${path === '' ? '' : path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Rewrites an artifact URL the server returned so a browser can open it. With the sample
 * workspace's public tool URLs it rebuilds the link on the right tool base; without them (a real
 * workspace's own tools) it keeps the address the owner saved. A Mattermost post goes through
 * Kaki's opener only for the sample workspace, which is the only place the shared demo sign-in
 * exists.
 */
export function resolveArtifactUrl(
  rawUrl: string,
  kind?: ActionKind,
  toolUrls?: ToolPublicUrls,
): string {
  if (typeof window === 'undefined') return rawUrl;
  const tool = kind === undefined ? undefined : TOOL_FOR_KIND[kind];
  const base = tool === undefined ? undefined : toolUrls?.[tool];

  let resolved = rawUrl;
  if (base !== undefined) {
    resolved = withPublicBase(rawUrl, base, window.location.hostname);
  } else {
    // Older links were built with localhost or 127.0.0.1; a phone or remote browser needs its own host.
    const currentHost = window.location.hostname;
    try {
      const parsed = new URL(resolved);
      if (
        currentHost !== '' &&
        !isLoopbackHost(currentHost) &&
        isLoopbackHost(parsed.hostname)
      ) {
        if (parsed.port === '3001' || parsed.pathname.startsWith('/api/')) {
          resolved = `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
        } else {
          parsed.hostname = currentHost;
          resolved = parsed.toString();
        }
      }
    } catch {
      // A relative or non-URL artifact stays as it is.
    }
  }

  if (kind === 'mattermost_post' && toolUrls !== undefined) {
    const local = isLoopbackHost(window.location.hostname);
    // The sample workspace's calendar base is Kaki's own public address, so it carries the server's
    // real PORT; a fixed one would 404 the opener whenever the server runs somewhere else.
    const apiBase = local ? toolUrls.calendar : window.location.origin;
    return `${toolLink(apiBase, '/api/mattermost/open')}?url=${encodeURIComponent(resolved)}`;
  }
  return resolved;
}
