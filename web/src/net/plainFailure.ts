/** The plain sentences every failed request or room connection is shown with. */
export const SIGN_IN_ENDED = 'Your sign-in has ended.';
export const SERVER_TROUBLE = 'Kaki is having trouble right now. Try again in a minute.';
export const DID_NOT_WORK = "That didn't work. Try again.";
export const COULD_NOT_JOIN = "Couldn't join. Try again.";

/** Server error codes that must never reach a person as written, with the sentence they get. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  'meeting-not-found': 'This meeting does not exist.',
  'practice-busy':
    'Someone is using the practice meeting right now. It frees up when they finish, usually within 15 minutes.',
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

/** The plain sentence for a failed response: signed out, else the server's own plain words, else a generic one. */
export function plainFailureMessage(status: number, serverText?: unknown): string {
  if (status === 401 || status === 403) return SIGN_IN_ENDED;
  const plain = plainServerText(serverText);
  if (plain !== undefined) return plain;
  return status === 0 || status >= 500 ? SERVER_TROUBLE : DID_NOT_WORK;
}

export const ROOM_CONNECT_PROBLEM =
  "We couldn't connect your audio and video. Check your internet, then press Rejoin.";
export const MEDIA_BLOCKED_PROBLEM =
  'Your microphone (or camera) is blocked. Click the lock icon in the address bar to allow it, then press the mic button.';
