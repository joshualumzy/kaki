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

/** The plain sentence for a failed response: its status first, then the server's own words. */
export function plainFailureMessage(status: number, serverText?: unknown): string {
  if (status === 401 || status === 403) return SIGN_IN_ENDED;
  if (status === 0 || status >= 500) return SERVER_TROUBLE;
  return plainServerText(serverText) ?? DID_NOT_WORK;
}
