import type { AgendaItem } from './agenda';

export type { AgendaItem } from './agenda';

/** The lifecycle state of a real meeting. */
export type MeetingStatus = 'scheduled' | 'open' | 'ended';

/** One row of the `meetings` table. Workspace and owner ids are plain text for now. */
export interface MeetingRow {
  id: string;
  workspaceId: string;
  ownerUserId: string | null;
  title: string;
  kind: 'real';
  status: MeetingStatus;
  scheduledFor: string | null;
  agenda: AgendaItem[];
  createdAt: string;
  endedAt: string | null;
}

/** How a meeting is opened at the runner: the practice instance runs everything, a real one listens. */
export type RunnerMeetingKind = 'real' | 'practice';
