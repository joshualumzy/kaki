import { randomBytes } from 'node:crypto';

/** Uppercase letters and digits without look-alikes such as I/O/0/1. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MEETING_CODE_LENGTH = 6;

/** Generate one short meeting code that is easy to read out or type. */
export function generateMeetingCode(): string {
  const bytes = randomBytes(MEETING_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}
