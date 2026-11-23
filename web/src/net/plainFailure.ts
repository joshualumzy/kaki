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

/**
 * The plain sentence for a failed response. Only a missing or expired session sends someone to
 * sign in: the server marks that with `signInEnded`, and a bare 401 means the same. Every other
 * refusal, including a 403 from a signed-in person, keeps the server's own plain words.
 */
export function plainFailureMessage(
  status: number,
  serverText?: unknown,
  signInEnded?: boolean,
): string {
  if (signInEnded === true || (status === 401 && signInEnded !== false)) return SIGN_IN_ENDED;
  const plain = plainServerText(serverText);
  if (plain !== undefined) return plain;
  return status === 0 || status >= 500 ? SERVER_TROUBLE : DID_NOT_WORK;
}

export const ROOM_CONNECT_PROBLEM =
  "We couldn't connect your audio and video. Check your internet, then press Rejoin.";
/** What a person sees when the browser refuses a microphone or camera, naming the device. */
export const MIC_BLOCKED_PROBLEM =
  "Your microphone is blocked. Allow it in your browser's site settings to take part.";
export const CAMERA_BLOCKED_PROBLEM =
  "Your camera is blocked. Allow it in your browser's site settings to take part.";
export const MEDIA_BLOCKED_PROBLEM =
  "Your microphone or camera is blocked. Allow it in your browser's site settings to take part.";
/** The same problem in a practice meeting, which is speech only and has no Type to fall back on. */
export const MEDIA_BLOCKED_PROBLEM_SPEECH_ONLY =
  "Your microphone (or camera) is blocked. Click the lock icon in the address bar to allow it in your browser's site settings, then rejoin to speak.";

/** A server refusal of a command, in words a person can act on. */
export function plainRejection(reason: string): string {
  if (reason === 'not connected') return "You're not connected right now. Try again in a moment.";
  return plainServerText(reason) ?? DID_NOT_WORK;
}
