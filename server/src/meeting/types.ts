import type { MeetingPace } from '@kaki/shared';
import type { AgendaItem } from './agenda';

export type { AgendaItem } from './agenda';

/** The lifecycle state of a real meeting. */
export type MeetingStatus = 'scheduled' | 'open' | 'ended';

/** One to-do as Kaki keeps it with an ended meeting's minutes. */
export interface ArchivedMeetingTodo {
  id: string;
  title: string;
  /** The owner as a person reads it. */
  owner: string;
  status: string;
  done: boolean;
}

/** Kaki's own copy of an ended meeting's minutes and to-dos, kept apart from any connected tool. */
export interface MeetingMinutesArchive {
  minutes: string;
  todos: ArchivedMeetingTodo[];
  archivedAt: string;
}

/** One row of the `meetings` table. Workspace and owner ids are plain text for now. */
export interface MeetingRow {
  id: string;
  workspaceId: string;
  ownerUserId: string | null;
  title: string;
  kind: 'real' | 'practice';
  status: MeetingStatus;
  scheduledFor: string | null;
  agenda: AgendaItem[];
  /** The nudge timings the owner chose in setup; absent means the shipped default. */
  pace?: MeetingPace | null;
  createdAt: string;
  endedAt: string | null;
  /** Kaki's own copy of the minutes, once the meeting has ended and they were written. */
  minutes?: MeetingMinutesArchive | null;
}

/** How a meeting is opened at the runner: the practice instance runs everything, a real one listens. */
export type RunnerMeetingKind = 'real' | 'practice';
