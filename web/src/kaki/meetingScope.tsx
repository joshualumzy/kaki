import { createContext, useContext, type ReactNode } from 'react';
import { meetingApiPath } from '@kaki/shared';

export { meetingApiPath };

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

