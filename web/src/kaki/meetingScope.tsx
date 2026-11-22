import { createContext, useContext, type ReactNode } from 'react';

/** Which meeting the page follows; absent is the legacy practice page and its unprefixed API. */
export interface MeetingScopeValue {
  meetingId?: string;
}

const MeetingScope = createContext<MeetingScopeValue>({});

/** Make a page's real meeting available to every socket and API call beneath it. */
export function MeetingScopeProvider({
  meetingId,
  children,
}: {
  meetingId?: string;
  children: ReactNode;
}) {
  return <MeetingScope.Provider value={{ meetingId }}>{children}</MeetingScope.Provider>;
}

/** The meeting this page follows, or no meeting for the legacy practice pages. */
export function useMeetingScope(): MeetingScopeValue {
  return useContext(MeetingScope);
}

/**
 * The address of a meeting route. A real meeting serves the same handlers under
 * `/api/meetings/:id`, so one path works for both the legacy practice meeting and a real one.
 */
export function meetingApiPath(meetingId: string | undefined, path: string): string {
  if (meetingId === undefined || meetingId === '') return path;
  const rest = path.startsWith('/api') ? path.slice(4) : path;
  return `/api/meetings/${encodeURIComponent(meetingId)}${rest.startsWith('/') ? rest : `/${rest}`}`;
}
