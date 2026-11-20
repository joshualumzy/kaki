/** What a phone is shown when its meeting's code has been replaced. Display only: never compare it. */
export const MEETING_ENDED_MESSAGE = 'This meeting has ended; scan the new code.';

/** The machine-readable mark on a refused phone session whose meeting is gone for good. */
export interface MeetingEnded {
  ended: true;
}
