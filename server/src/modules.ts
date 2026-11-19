import type { MeetingMemoryEntry, Scenario } from '@kaki/shared';
import type { Hub } from './hub';
import type { MeetingPersistence } from './persist/persistence';
import type { SavedMeetingDetails } from './persist/state';
import type { TaskStore } from './tasks';

/** Everything a plug-in module may use while the meeting runs. */
export interface KakiContext {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
  memory?: readonly MeetingMemoryEntry[];
  /** When true, actions may be drafted and reviewed but never sent to external services. */
  draftOnly?: boolean;
  /** Keeps the meeting across a restart; absent when no Postgres is configured. */
  persistence?: MeetingPersistence;
  /** The server-owned identity of the current meeting, saved with it so a restart resumes the same one. */
  meetingId?(): string;
  /** Start a new meeting identity; returns it for the MEETING_RESET payload. */
  resetMeetingIdentity?(): string;
  /** The setup, code and seat holders the app server owns, saved alongside the meeting record. */
  meetingDetails?(): SavedMeetingDetails;
  /**
   * True when the sealed meeting carries no demo-pack content: every seat is a person and no agenda
   * item is a pack topic. Such a meeting must not use the demo pack's company knowledge.
   */
  packFree?(): boolean;
}

/** A team-owned feature that plugs into the server without editing shared files. */
export interface KakiModule {
  name: string;
  start(ctx: KakiContext): void | (() => void);
}
