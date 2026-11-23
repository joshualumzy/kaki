/** The plain sentences every failed request or room connection is shown with. */
export const SIGN_IN_ENDED = 'Your sign-in has ended.';
export const SERVER_TROUBLE = 'Kaki is having trouble right now. Try again in a minute.';
export const DID_NOT_WORK = "That didn't work. Try again.";
export const COULD_NOT_JOIN = "Couldn't join. Try again.";

/** Server error codes that must never reach a person as written, with the sentence they get. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  'meeting-not-found': 'This meeting does not exist.',
  'practice-moved': 'Practice now has its own page. Open it from the home page.',
  'practice-access': 'That practice meeting belongs to another visitor. Start a new practice.',
  'practice-full': 'All practice rooms are in use right now. Please try again in a few minutes.',
  'practice-ended': 'This practice meeting has ended. Start a new practice.',
};

/** Practice refusals that are about the practice meeting, not a sign-in that ended. */
const PRACTICE_CODES: ReadonlySet<string> = new Set(['practice-moved', 'practice-access']);

/** A machine code such as "meeting-not-found": lowercase words joined by hyphens, no spaces. */
function isRawCode(text: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(text);
}

/** The sentence for a server error code or message; a code with no sentence is dropped, not shown. */
export function plainServerText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (!isRawCode(text)) return text;
  return CODE_SENTENCES[text];
}

/** The plain sentence for a failed response: signed out, else the server's own plain words, else a generic one. */
export function plainFailureMessage(status: number, serverText?: unknown): string {
  const plain = plainServerText(serverText);
  if (status === 401 || status === 403) {
    // A practice refusal is not a sign-in problem; show it rather than sending the visitor to sign in.
    const code = typeof serverText === 'string' ? serverText.trim() : '';
    return PRACTICE_CODES.has(code) && plain !== undefined ? plain : SIGN_IN_ENDED;
  }
  if (plain !== undefined) return plain;
  return status === 0 || status >= 500 ? SERVER_TROUBLE : DID_NOT_WORK;
}

export const ROOM_CONNECT_PROBLEM =
  "We couldn't connect your audio and video. Check your internet, then press Rejoin.";
export const MEDIA_BLOCKED_PROBLEM =
  'Your microphone (or camera) is blocked. Click the lock icon in the address bar to allow it in your browser\'s site settings, then press the mic button. Or use Type to take part in text.';
/** The same problem in a practice meeting, which is speech only and has no Type to fall back on. */
export const MEDIA_BLOCKED_PROBLEM_SPEECH_ONLY =
  'Your microphone (or camera) is blocked. Click the lock icon in the address bar to allow it in your browser\'s site settings, then rejoin to speak.';

/** A server refusal of a command, in words a person can act on. */
export function plainRejection(reason: string): string {
  if (reason === 'not connected') return "You're not connected right now. Try again in a moment.";
  return plainServerText(reason) ?? DID_NOT_WORK;
}
