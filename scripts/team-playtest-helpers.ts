/** Pure decisions for the three-window team-meeting playtest. No browser or network in here. */

import type { CheckStatus } from './playtest-report';

export const OWNER_EMAIL_ENV = 'KAKI_PLAYTEST_OWNER_EMAIL';
export const OWNER_PASSWORD_ENV = 'KAKI_PLAYTEST_OWNER_PASSWORD';

export type OwnerCredentials =
  | { ok: true; email?: string; password?: string }
  | { ok: false; missing: string[]; message: string };

/** Sign-in needs credentials only when the server says auth is on. Never puts the password in a message. */
export function ownerCredentials(
  env: Record<string, string | undefined>,
  authEnabled: boolean,
): OwnerCredentials {
  if (!authEnabled) return { ok: true };
  const email = (env[OWNER_EMAIL_ENV] ?? '').trim();
  const password = env[OWNER_PASSWORD_ENV] ?? '';
  const missing: string[] = [];
  if (email === '') missing.push(OWNER_EMAIL_ENV);
  if (password === '') missing.push(OWNER_PASSWORD_ENV);
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: `Sign-in is on but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Export the owner credentials before running the playtest.`,
    };
  }
  return { ok: true, email, password };
}

/** The code in an invite link (`/join?code=ABCD`), or undefined when the link is not an invite. */
export function inviteCodeFromLink(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, 'http://playtest.invalid');
  } catch {
    return undefined;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/join') return undefined;
  const code = url.searchParams.get('code')?.trim() ?? '';
  return code === '' ? undefined : code;
}

export type TranscriptVerdict = { ok: boolean; detail: string; problems: string[] };

/**
 * Every expected line must appear exactly once in each window's transcript. Exact matches only, so
 * a short line inside a longer one does not count twice.
 */
export function judgeTranscriptPresence(
  expected: readonly string[],
  windows: Readonly<Record<string, readonly string[]>>,
): TranscriptVerdict {
  const problems: string[] = [];
  const names = Object.keys(windows);
  for (const name of names) {
    const lines = (windows[name] ?? []).map((line) => line.trim());
    for (const wanted of expected) {
      const wantedText = wanted.trim();
      const count = lines.filter((line) => line === wantedText).length;
      if (count !== 1) {
        problems.push(`${name}: "${wantedText}" appeared ${count} time(s)`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `Each of the ${expected.length} line(s) appeared exactly once in ${names.join(', ')}`
      : problems.join('; '),
    problems,
  };
}

/** True for the server's seat refusal, and false for a raw status code or an unrelated error. */
export function seatRefusalIsPlain(text: string): boolean {
  const normal = text.trim();
  if (normal === '') return false;
  return /seat is taken/i.test(normal)
    && /pick another role/i.test(normal)
    && !/\b(?:HTTP|status|409|conflict)\b/i.test(normal);
}

/** True for the practice refusal while a team meeting is open, and false for a technical message. */
export function practiceBusyIsPlain(text: string): boolean {
  const normal = text.trim();
  if (normal === '') return false;
  return /team meeting is in progress/i.test(normal)
    && !/\b(?:HTTP|status|409|conflict)\b/i.test(normal);
}

export type SeatOptionsVerdict = { ok: boolean; detail: string };

/** The join form must offer exactly the meeting's person seats, in any order. */
export function judgeSeatOptions(actual: readonly string[], expected: readonly string[]): SeatOptionsVerdict {
  const clean = (values: readonly string[]): string[] =>
    values.map((value) => value.trim()).filter((value) => value !== '').sort();
  const got = clean(actual);
  const want = clean(expected);
  const ok = got.length === want.length && got.every((value, index) => value === want[index]);
  const list = (values: readonly string[]): string => (values.length === 0 ? '(none)' : values.join(', '));
  return {
    ok,
    detail: ok
      ? `Only the person seats were offered: ${list(got)}`
      : `Seats offered: ${list(got)}; expected: ${list(want)}`,
  };
}

export type MinutesVerdict = { ok: boolean; detail: string };

/** The minutes card must be assigned to the owner's seat, never to a participant's. */
export function judgeMinutesRecipient(
  minutes: { assignee?: string; suggestedAssignee?: string } | undefined,
  ownerRoleId: string,
  participantRoleIds: readonly string[],
): MinutesVerdict {
  if (minutes === undefined) {
    return { ok: false, detail: 'No end-of-meeting minutes card appeared' };
  }
  const assignee = minutes.assignee ?? minutes.suggestedAssignee ?? '';
  const participants = new Set(participantRoleIds.map((role) => role.toLowerCase()));
  if (assignee.toLowerCase() === ownerRoleId.toLowerCase()) {
    return { ok: true, detail: `Minutes card assigned to the owner's seat ${ownerRoleId}` };
  }
  if (participants.has(assignee.toLowerCase())) {
    return { ok: false, detail: `Minutes card went to a participant's seat ${assignee}, not the owner ${ownerRoleId}` };
  }
  return { ok: false, detail: `Minutes card assigned to ${assignee === '' ? '(no seat)' : assignee}, not the owner ${ownerRoleId}` };
}

export type TaskVerdict = { status: CheckStatus; detail: string };

/**
 * No card is only NOT EXERCISED when the notetaker says it has no LLM at all. A configured
 * notetaker that stayed silent or failed is a real failure.
 */
export function judgeFollowUpTask(cardSeen: boolean, notetakerStatus: string | undefined): TaskVerdict {
  if (cardSeen) return { status: 'PASS', detail: 'A follow-up card was produced' };
  if (notetakerStatus === 'off') {
    return {
      status: 'NOT EXERCISED',
      detail: 'The notetaker has no LLM configured (notetakerStatus off), so it could not create a follow-up card',
    };
  }
  if (notetakerStatus === 'stale') {
    return {
      status: 'FAIL',
      detail: 'The notetaker is configured but its last pass failed (notetakerStatus stale); no follow-up card was produced',
    };
  }
  return {
    status: 'FAIL',
    detail: `No follow-up card appeared within the wait (notetakerStatus ${notetakerStatus ?? 'unknown'})`,
  };
}

/** A published artifact link is present in this page's text or links. */
export function pageShowsArtifact(text: string, hrefs: readonly string[], artifactUrl: string): boolean {
  const wanted = artifactUrl.trim();
  if (wanted === '') return false;
  if (hrefs.some((href) => {
    const clean = href.trim();
    return clean !== '' && (clean.includes(wanted) || wanted.includes(clean));
  })) return true;
  return text.includes(wanted) || /Open meeting minutes in Wiki/i.test(text);
}
