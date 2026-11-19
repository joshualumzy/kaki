import { newMeetingCode, normalizeMeetingCode } from '@kaki/shared';

/** What a phone shows when its meeting's code has been replaced. */
export const MEETING_ENDED_MESSAGE = 'This meeting has ended; scan the new code.';

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
}

/** Create the code both the app and the auth module read. */
export function createMeetingCodeSource(
  fixedCode: string | undefined = process.env.KAKI_MEETING_CODE?.trim(),
): MeetingCodeSource {
  const fixedValue = normalizeMeetingCode(fixedCode);
  const fixed = fixedValue !== '';
  let value = fixed ? fixedValue : newMeetingCode();
  return {
    get value() {
      return value;
    },
    fixed,
    rotate() {
      if (!fixed) value = newMeetingCode();
    },
  };
}
