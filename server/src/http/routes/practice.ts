import { randomUUID } from 'node:crypto';
import { accountUserId, clientAddress, publicUrlIsHttps, tokenMatches } from '../access';
import { cookieValue, sendJson } from '../http';
import { PRACTICE_COOKIE, type RouteCall } from '../routeCall';
import { MeetingBusyError, PracticeFullError } from '../../meeting/registry';

const PRACTICE_RATE_LIMIT_MESSAGE =
  'Too many practice rooms were opened from here. Try again in a minute.';

/** The practice cookie names its own meeting, so one visitor's capability never opens another's. */
function practiceCookie(meetingId: string, capability: string): string {
  const secure = publicUrlIsHttps() ? '; Secure' : '';
  return `${PRACTICE_COOKIE}=${meetingId}.${capability}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** `<meetingId>.<capability>`; anything else (a truncated or legacy cookie) is treated as none. */
function parsePracticeCookie(raw: string): { meetingId: string; capability: string } | undefined {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return undefined;
  return { meetingId: raw.slice(0, dot), capability: raw.slice(dot + 1) };
}

/**
 * Give this visitor their own practice meeting. A valid cookie returns the same meeting, so a
 * refresh or a second tab reuses it; otherwise the registry opens a fresh one. When every practice
 * room is in use the refusal is loud and plain, never a silent queue.
 */
export async function handlePractice(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  const registry = context.registry;
  if (registry === undefined) {
    sendJson(response, 503, { error: 'practice-unavailable', message: 'Practice is not available right now.' });
    return;
  }

  const ownerUserId = accountUserId(call.principal);
  const raw = cookieValue(request, PRACTICE_COOKIE);
  const parsed = raw === undefined ? undefined : parsePracticeCookie(raw);
  if (parsed !== undefined) {
    const existing = registry.findPractice(parsed.meetingId);
    // A practice that belongs to another account must never be handed to this one, even on the
    // same browser: its minutes would land in the wrong history.
    const row = ownerUserId === undefined ? undefined : await context.meetings?.get(parsed.meetingId);
    const ownedByThisAccount = ownerUserId === undefined || row?.ownerUserId === ownerUserId;
    if (existing !== undefined && ownedByThisAccount) {
      if (existing.session.phase() !== 'ended') {
        const expected = existing.session.practiceStartToken();
        // A cookie that names this practice with a different capability is an attempt on another
        // visitor's meeting; it is refused, never quietly replaced with someone else's room.
        if (expected === undefined || tokenMatches(parsed.capability, expected)) {
          const capability = expected ?? parsed.capability;
          response.setHeader('set-cookie', practiceCookie(existing.id, capability));
          sendJson(response, 200, { meetingId: existing.id, signedIn: ownerUserId !== undefined });
          return;
        }
        sendJson(response, 403, {
          error: 'practice-access',
          message: 'This practice meeting belongs to another visitor.',
        });
        return;
      }
      // The old practice has ended; the visitor's next practice is a fresh meeting.
    }
  }

  // Only opening a fresh room counts, one bucket per address: a refresh or second tab that reuses
  // the visitor's own practice never does, but a loop that clears its cookie and asks again is
  // refused plainly instead of keeping every practice room occupied.
  const limiter = context.practiceAttempts;
  const address = `address:${clientAddress(request)}`;
  if (limiter?.isLimited(address) === true) {
    sendJson(response, 429, { error: PRACTICE_RATE_LIMIT_MESSAGE });
    return;
  }
  limiter?.recordFailure(address);

  let meetingId: string;
  try {
    const instance = await registry.createPractice(
      ownerUserId === undefined
        ? {}
        : { ownerUserId, title: 'Nanyang Kopi (sample workspace)' },
    );
    meetingId = instance.id;
    const capability = randomUUID();
    instance.session.beginPractice({ token: capability });
    response.setHeader('set-cookie', practiceCookie(meetingId, capability));
  } catch (error) {
    if (error instanceof PracticeFullError) {
      sendJson(response, 503, { error: 'practice-full', message: error.message });
      return;
    }
    if (error instanceof MeetingBusyError) {
      sendJson(response, 503, { error: 'busy', message: error.message });
      return;
    }
    throw error;
  }
  sendJson(response, 200, { meetingId, signedIn: ownerUserId !== undefined });
}
