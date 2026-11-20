/** What a phone is shown when its meeting's code has been replaced. Display only: never compare it. */
export const MEETING_ENDED_MESSAGE = 'This meeting has ended; scan the new code.';

/** The one refusal for a team-meeting join while the owner has not opened a real meeting. */
export const NO_TEAM_MEETING_MESSAGE =
  'No team meeting is open right now. Ask the meeting owner for the invite link.';

/** The machine-readable mark on a refused phone session whose meeting is gone for good. */
export interface MeetingEnded {
  ended: true;
}
