import type { MeetingEnded } from '@kaki/shared';
import { fetchWithTimeout } from '../net/withTimeout';

/** What GET /api/auth/me says about this browser's cookie. */
export type Me =
  | { authEnabled: false }
  | { authEnabled: true; kind: 'host' | 'participant'; role?: string }
  | ({ authEnabled: true; kind: null; reason?: string } & Partial<MeetingEnded>);

type Outcome = { ok: true } | { ok: false; message: string };

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `${fallback} (${response.status})`;
}

/** Ask the server who this cookie belongs to, and whether auth is on at all. */
export async function fetchMe(signal?: AbortSignal): Promise<Me> {
  const response = await fetch('/api/auth/me', signal === undefined ? undefined : { signal });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (body?.authEnabled === false) return { authEnabled: false };
  if (body?.authEnabled === true) {
    if (response.ok) {
      if (body.kind === 'host') return { authEnabled: true, kind: 'host' };
      if (body.kind === 'participant') {
        return typeof body.role === 'string'
          ? { authEnabled: true, kind: 'participant', role: body.role }
          : { authEnabled: true, kind: 'participant' };
      }
    }
    return {
      authEnabled: true,
      kind: null,
      ...(typeof body.error === 'string' ? { reason: body.error } : {}),
      ...(body.ended === true ? { ended: true as const } : {}),
    };
  }

  throw new Error(`Could not read the sign-in state (${response.status}).`);
}

/** Sign the host in and set the session cookie. */
export async function signIn(email: string, password: string): Promise<Outcome> {
  try {
    const response = await fetchWithTimeout('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: await errorMessage(response, 'Could not sign in') };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}
