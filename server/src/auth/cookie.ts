import type { IncomingMessage } from 'node:http';

/** The cookie that carries the opaque session token. */
export const SESSION_COOKIE = 'kaki_session';

/** Sessions and their cookies live for 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** Read the session token from a request's cookie header. */
export function readSessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value === '') return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function serialize(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Build the Set-Cookie value for a new session. */
export function sessionCookie(token: string, secure: boolean): string {
  return serialize(token, SESSION_TTL_SECONDS, secure);
}

/** Build the Set-Cookie value that removes the session cookie. */
export function clearSessionCookie(secure: boolean): string {
  return serialize('', 0, secure);
}
