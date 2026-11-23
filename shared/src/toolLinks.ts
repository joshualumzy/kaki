/** The address of one meeting's route: every meeting serves its handlers under `/api/meetings/:id`. */
export function meetingApiPath(meetingId: string, path: string): string {
  const rest = path.startsWith('/api') ? path.slice(4) : path;
  return `/api/meetings/${encodeURIComponent(meetingId)}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

/** Join a path onto a tool's public base, whether the base has a path of its own or not. */
export function toolLink(base: string, path: string): string {
  const clean = base.replace(/\/+$/, '');
  return `${clean}${path === '' ? '' : path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The seeded calendar event the practice join page opens. The docker seed writes this id
 * (`docker/seed/calendar.ts`), so the join chip and the seeded event cannot drift apart.
 */
export const PRACTICE_CALENDAR_EVENT_ID = 'seed-food-agency-inspection';

/** One calendar event's viewer page inside the meeting that owns it. */
export function calendarEventApiPath(meetingId: string, eventId: string): string {
  return meetingApiPath(meetingId, `/api/calendar/${encodeURIComponent(eventId)}`);
}

/**
 * Kaki's Mattermost opener for one meeting. The target is the Mattermost post or channel the
 * person should land on; the opener signs the sample user in and redirects there.
 */
export function mattermostOpenApiPath(meetingId: string, targetUrl: string): string {
  return meetingApiPath(meetingId, `/api/mattermost/open?url=${encodeURIComponent(targetUrl)}`);
}
