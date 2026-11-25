/** What a cancelled meeting needs to remove from the calendar. */
export interface CancelledMeetingCalendarEvent {
  meetingId: string;
  workspaceId: string;
  ownerUserId: string | null;
  title: string;
  scheduledFor: string | null;
}

/**
 * Round 3 hook: remove the calendar event Kaki created for a cancelled meeting.
 *
 * A meeting has no calendar event yet, so there is nothing to delete. The cancellation path calls
 * this one named function so Round 3 adds the calendar write in exactly one place.
 */
export async function removeCalendarEventForCancelledMeeting(
  input: CancelledMeetingCalendarEvent,
): Promise<void> {
  void input;
}
