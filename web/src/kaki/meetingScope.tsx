import { createContext, useContext, type ReactNode } from 'react';

/** Which meeting the page follows. */
export interface MeetingScopeValue {
  meetingId: string;
}

const MeetingScope = createContext<MeetingScopeValue | null>(null);

/** Make a page's meeting available to every socket and API call beneath it. */
export function MeetingScopeProvider({
  meetingId,
  children,
}: {
  meetingId: string;
  children: ReactNode;
}) {
  return <MeetingScope.Provider value={{ meetingId }}>{children}</MeetingScope.Provider>;
}

/** The meeting this page follows; it must be inside a MeetingScopeProvider. */
export function useMeetingScope(): MeetingScopeValue {
  const value = useContext(MeetingScope);
  if (value === null) throw new Error('useMeetingScope must be used inside MeetingScopeProvider');
  return value;
}

/** The address of one meeting's route: every meeting serves its handlers under `/api/meetings/:id`. */
export function meetingApiPath(meetingId: string, path: string): string {
  const rest = path.startsWith('/api') ? path.slice(4) : path;
  return `/api/meetings/${encodeURIComponent(meetingId)}${rest.startsWith('/') ? rest : `/${rest}`}`;
}
