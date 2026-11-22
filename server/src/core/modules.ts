import type { MeetingMemoryEntry, Role, Scenario } from '@kaki/shared';
import type { Hub } from './hub';
import type { MeetingPersistence } from '../persist/persistence';
import type { SavedMeetingDetails } from '../persist/state';
import type { MeetingSession, MeetingSessionResetOptions } from '../meeting/session';
import type { TaskStore } from '../meeting/tasks';
import type { WorkspaceTools } from '../workspace/tools';

/** Everything a plug-in module may use while the meeting runs. */
export interface KakiContext {
  hub: Hub;
  tasks: TaskStore;
  /** The meeting's scenario right now; a Start commit or reset replaces it, so read it every time. */
  activeScenario(): Scenario;
  memory?: readonly MeetingMemoryEntry[];
  /** When true, actions may be drafted and reviewed but never sent to external services. */
  draftOnly?: boolean;
  /** Keeps the meeting across a restart; absent when no Postgres is configured. */
  persistence?: MeetingPersistence;
  /** The server-owned identity of the current meeting, saved with it so a restart resumes the same one. */
  meetingId(): string;
  /** The workspace this meeting belongs to; the sample workspace for the legacy practice meeting. */
  workspaceId(): string;
  /** The workspace's tool connections, read fresh when an action drafts or runs. */
  tools?(): Promise<WorkspaceTools>;
  /** Reset the meeting through the one meeting session and admission queue; resolves with the new meeting id. */
  resetMeeting?(options?: MeetingSessionResetOptions): Promise<string>;
  /**
   * Run a meeting lifecycle change on the one admission queue, so it can never interleave with a join
   * that is still signing a room token or claiming a seat. Absent in standalone module use.
   */
  serializeChange?<T>(task: () => Promise<T> | T): Promise<T>;
  /** Register per-module work to run during a meeting reset, instead of reacting to MEETING_RESET. */
  onReset?(hook: () => void): () => void;
  /** The session that owns meeting state, for modules that need more than reset and onReset. */
  session?: MeetingSession;
  /** The journey this meeting runs: real or practice. Read it every time; a reset can clear it. */
  meetingKind?(): 'real' | 'practice' | undefined;
  /** A quiet note for the shared meeting state; real meetings have no spoken cues. */
  quietCue?(text: string): void;
  /** The loud, plain-words notice shown to everyone, or null once the notes are healthy again. */
  notesPaused?(text: string | null): void;
  /** The setup, code and seat holders the app server owns, saved alongside the meeting record. */
  meetingDetails?(): SavedMeetingDetails;
  /**
   * True when the person holding this seat is a guest with no signed-in account; undefined when
   * the server does not know. A module that reads the workspace must fail closed on undefined.
   */
  seatIsGuest?(role: Role): boolean | undefined;
  /**
   * Keep Kaki's own copy of the end-of-meeting minutes and to-dos with the meeting, so the
   * workspace history still has them after the meeting is unloaded and whatever tools are connected.
   */
  archiveMinutes?(input: {
    minutes: string;
    todos: Array<{ id: string; title: string; owner: string; status: string }>;
  }): Promise<void>;
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
