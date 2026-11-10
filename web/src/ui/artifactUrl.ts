/**
 * Rewrites `localhost` / `127.0.0.1` artifact URLs returned by the backend (from internal Docker/env
 * endpoints like `http://localhost:8082/...` or `http://127.0.0.1:3001/api/calendar/...`) so that phones
 * and remote browsers visiting a public hostname or LAN IP can open them directly.
 */
export function resolveArtifactUrl(rawUrl: string): string {
  if (typeof window === 'undefined') return rawUrl;
  const currentHost = window.location.hostname;
  try {
    const parsed = new URL(rawUrl);
    if (
      currentHost &&
      currentHost !== 'localhost' &&
      currentHost !== '127.0.0.1' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      if (parsed.port === '3001' || parsed.pathname.startsWith('/api/')) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
      parsed.hostname = currentHost;
    }
    if (parsed.port === '8083' || parsed.pathname.includes('/nanyang-kopitiam/')) {
      return `${window.location.origin}/api/mattermost/open?url=${encodeURIComponent(parsed.toString())}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
