import { createContext, useContext, type ReactNode } from 'react';
import type { KakiCommand, MeetingStateSnapshot } from '@kaki/shared';
import { useKaki } from '../../kaki';

/** The meeting state and command channel a real meeting room shares with all its parts. */
export interface RealRoomValue {
  meetingState: MeetingStateSnapshot | undefined;
  send(command: KakiCommand): boolean;
  role: string;
  isHost: boolean;
  meetingId: string;
  /** Set when the server closed the connection because the meeting ended while this seat was away. */
  endedWhileAway: string | undefined;
}

const RealRoomContext = createContext<RealRoomValue | null>(null);

/** One socket for the real room: the owner reads the screen, everyone else their own projection. */
export function RealRoomStateProvider({
  role,
  isHost,
  meetingId,
  children,
}: {
  role: string;
  isHost: boolean;
  meetingId: string;
  children: ReactNode;
}) {
  const { meetingState, send, ended } = useKaki(isHost ? { kind: 'screen' } : { kind: 'participant' });
  return (
    <RealRoomContext.Provider value={{ meetingState, send, role, isHost, meetingId, endedWhileAway: ended }}>
      {children}
    </RealRoomContext.Provider>
  );
}

/** The real room's state, or null outside a real meeting (practice never mounts the provider). */
export function useRealRoom(): RealRoomValue | null {
  return useContext(RealRoomContext);
}
