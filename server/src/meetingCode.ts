import { randomBytes } from 'node:crypto';
import { normalizeMeetingCode } from '@kaki/shared';

/** What a caller sees after too many wrong codes from one address. */
export const MEETING_CODE_RATE_LIMIT_MESSAGE =
  'Too many meeting-code attempts. Wait a minute and try again.';

/** Wrong codes allowed per address in one window. */
export const MEETING_CODE_FAILURE_LIMIT = 5;
export const MEETING_CODE_WINDOW_MS = 60_000;

/** Uppercase letters and digits without look-alikes such as I/O/0/1. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MEETING_CODE_LENGTH = 6;

/** Generate one short meeting code that is easy to read out or type. */
function generateMeetingCode(): string {
  const bytes = randomBytes(MEETING_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/**
 * The one meeting code shared by LiveKit admission and phone sign-in. It rotates when the meeting
 * changes, unless KAKI_MEETING_CODE pins it for a fixed test or demo.
 */
export interface MeetingCodeSource {
  /** The code people type today. */
  readonly value: string;
  /** True when the environment pins the code, so a new meeting must keep it. */
  readonly fixed: boolean;
  /** Start a new meeting's code; a no-op when the code is fixed. */
  rotate(): void;
  /**
   * Adopt the code a saved meeting was using. A pinned code wins, so this is a no-op and returns
   * false when `fixed`; otherwise it sets the value and returns true.
   */
  restore(code: string): boolean;
}

/** Create the code both the app and the auth module read. */
export function createMeetingCodeSource(
  fixedCode: string | undefined = process.env.KAKI_MEETING_CODE?.trim(),
): MeetingCodeSource {
  const fixedValue = normalizeMeetingCode(fixedCode);
  const fixed = fixedValue !== '';
  let value = fixed ? fixedValue : generateMeetingCode();
  return {
    get value() {
      return value;
    },
    fixed,
    rotate() {
      if (!fixed) value = generateMeetingCode();
    },
    restore(code) {
      if (fixed) return false;
      const restored = normalizeMeetingCode(code);
      if (restored === '') throw new Error('A restored meeting code cannot be empty');
      value = restored;
      return true;
    },
  };
}
