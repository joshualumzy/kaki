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

/**
 * Lower-case words with punctuation removed, so a sentence a person spoke and the line the server
 * transcribed can be compared without capitals, commas or a trailing full stop mattering.
 */
export function normaliseSentence(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
}

/**
 * How much of `expected` appears in `actual`, in the same order: the longest common subsequence
 * length divided by the expected word count. One shared word in a long sentence scores far below
 * the 80% a whole sentence needs, and re-ordered words do not count.
 */
export function sentenceWordRecall(expected: string, actual: string): number {
  const want = normaliseSentence(expected);
  const got = normaliseSentence(actual);
  if (want.length === 0) return got.length === 0 ? 1 : 0;
  let previous = new Array<number>(got.length + 1).fill(0);
  for (let i = 1; i <= want.length; i += 1) {
    const current = new Array<number>(got.length + 1).fill(0);
    for (let j = 1; j <= got.length; j += 1) {
      current[j] = want[i - 1] === got[j - 1]
        ? (previous[j - 1] ?? 0) + 1
        : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous = current;
  }
  return (previous[got.length] ?? 0) / want.length;
}

/** The share of spoken words that must appear in order for a transcript line to count as the sentence. */
export const SENTENCE_MATCH_RECALL = 0.8;

/** True when a transcript line is the whole spoken sentence, not just one word they share. */
export function sentenceMatches(expected: string, actual: string, threshold = SENTENCE_MATCH_RECALL): boolean {
  return sentenceWordRecall(expected, actual) >= threshold;
}

export type OverlapOrderVerdict = { ok: boolean; detail: string };

/**
 * The two overlapping lines must be recorded in the order they started. `appearedOrder` is the
 * order their transcript lines arrived; both people must be present so a missing line is not a pass.
 */
export function judgeOverlapOrder(
  startedFirst: string,
  appearedOrder: readonly string[],
): OverlapOrderVerdict {
  const first = appearedOrder[0];
  if (first === undefined) {
    return { ok: false, detail: 'Neither overlapping line reached the transcript' };
  }
  const hasOther = appearedOrder.some((name) => name !== startedFirst);
  if (!hasOther) {
    return { ok: false, detail: `Only ${first}'s line reached the transcript, so the overlap order could not be checked` };
  }
  const ok = first === startedFirst;
  return {
    ok,
    detail: ok
      ? `${first} started first and was recorded before ${appearedOrder.find((name) => name !== first) ?? 'the other speaker'}`
      : `${first} appeared first, but ${startedFirst} started speaking first`,
  };
}

const SPEECH_FAILURE_PATTERNS: readonly RegExp[] = [
  /speech is not being recorded/i,
  /speech recording isn't ready/i,
  /ai service is not connected/i,
  /speech recognition (?:failed|needs|is not|cannot|does not)/i,
  /could(?: not|n't) hear/i,
  /cannot hear/i,
  /can't hear/i,
  /no microphone was found/i,
  /microphone access was blocked/i,
  /the microphone could not be started/i,
];

/** The first visible speech-failure notice in these page texts, or undefined when there is none. */
export function speechFailureNotice(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    if (SPEECH_FAILURE_PATTERNS.some((pattern) => pattern.test(clean))) return clean;
  }
  return undefined;
}

export type MinutesSpeakersVerdict = { ok: boolean; detail: string };

/**
 * The end-of-meeting minutes quote at least one spoken line from every speaker. The minutes list
 * transcript lines as `- **Speaker:** words`, so a name alone in an action item does not count.
 */
export function judgeMinutesSpeakers(
  body: string,
  expected: ReadonlyArray<{ speaker: string; text: string }>,
  threshold = SENTENCE_MATCH_RECALL,
): MinutesSpeakersVerdict {
  const transcript = new Map<string, string[]>();
  for (const raw of body.split(/\r?\n/)) {
    const match = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(raw.trim());
    if (match === null) continue;
    const speaker = (match[1] ?? '').trim().toLowerCase();
    const text = (match[2] ?? '').trim();
    if (speaker === '' || text === '') continue;
    const lines = transcript.get(speaker) ?? [];
    lines.push(text);
    transcript.set(speaker, lines);
  }
  const names = [...new Set(expected.map((line) => line.speaker))];
  const problems: string[] = [];
  for (const name of names) {
    const lines = transcript.get(name.toLowerCase()) ?? [];
    if (lines.length === 0) {
      problems.push(`no transcript line from ${name}`);
      continue;
    }
    const spoken = expected.filter((line) => line.speaker === name);
    const matched = spoken.some((line) => lines.some((text) => sentenceMatches(line.text, text, threshold)));
    if (!matched) problems.push(`no spoken line from ${name} matched in the minutes`);
  }
  return {
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `Minutes quote a line from ${names.join(', ')}`
      : problems.join('; '),
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
