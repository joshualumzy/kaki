import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  MeetingMemoryEntry,
  MeetingSetup,
  RunnerMeetingSnapshot,
  Scenario,
} from '@kaki/shared';
import type { CalendarSettings } from '../action/calendar';
import type { ActionToolOptions } from '../action/tools';
import type { Auth } from '../auth/module';
import type { AuthStore } from '../auth/store';
import type { Hub } from '../core/hub';
import type { IdleTracker } from '../core/idle';
import type { MeetingCodeSource } from '../meeting/meetingCode';
import type { RejoinGuard } from '../meeting/rejoin';
import type { MeetingSession } from '../meeting/session';
import type { TaskStore } from '../meeting/tasks';
import type { MeetingRegistry, MeetingStore } from '../meeting/registry';
import type { RoomRoster, SeatReservations } from '../services/livekit';
import type { LlmClient } from '../services/llm';
import type {
  WorkspaceToolKind,
  WorkspaceToolSource,
  WorkspaceToolStore,
  WorkspaceTools,
} from '../workspace/tools';
import type { AttemptLimiter } from './attemptLimiter';
import type { Principal, Route } from './access';

/** The result of one server-owned Start, ready to send as JSON. */
export interface StartOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Everything a route handler may use: the live meeting, auth, tools and the operations that change it. */
export interface RequestContext {
  hub: Hub;
  tasks: TaskStore;
  memory: MeetingMemoryEntry[];
  fullScenario: Scenario;
  /** The workspace this route's meeting belongs to; routes that only serve the sample check it. */
  workspaceId: string;
  /** A fixed agenda order from KAKI_AGENDA_PICK, used instead of the random draw. */
  pickedAgenda?: Scenario['agenda'];
  devRoutes: boolean;
  auth?: Auth;
  /** The auth persistence, for the server-wide workspace API. */
  authStore?: AuthStore;
  /** The meetings table, for the server-wide meetings API. */
  meetings?: MeetingStore;
  /** The model server-wide helpers use; absent means they answer with their setup message. */
  llm?: LlmClient;
  /** The workspace tool table, for the workspace tools API. */
  workspaceTools?: WorkspaceToolStore;
  /** The tool source, so a just-connected tool can be read for indexing. */
  toolSource?: WorkspaceToolSource;
  /** Start a background index of one just-connected tool; the PUT response never waits for it. */
  indexWorkspaceTool?: (input: {
    workspaceId: string;
    kind: WorkspaceToolKind;
    tools: WorkspaceTools;
  }) => Promise<void>;
  /** Delete every stored trace of an account in one atomic step; returns its session hashes. */
  accountDeletion?: (userId: string) => Promise<string[]>;
  /** Guest-join attempts per client address, owned by the app. */
  guestJoinAttempts?: AttemptLimiter;
  /** Paid model requests for Tell Kaki, per account and address, owned by the app. */
  tellKakiAttempts?: AttemptLimiter;
  /** Paid calendar reads for agenda import, per account and address, owned by the app. */
  agendaFromCalendarAttempts?: AttemptLimiter;
  /** Practice-room opens per client address, so a cookie-clearing loop cannot hold every room. */
  practiceAttempts?: AttemptLimiter;
  /** The meeting registry, for the server-wide lookup and creation of meetings and practices. */
  registry?: Pick<
    MeetingRegistry,
    | 'findByCode'
    | 'create'
    | 'createPractice'
    | 'findPractice'
    | 'endOwnedBy'
    | 'endWorkspaceMember'
    | 'endUser'
    | 'updateScheduled'
    | 'cancel'
    | 'endMeeting'
  >;
  /** The meeting a session must belong to: a seat for meeting A resolves to nobody on B's routes. */
  authMeetingId?: string;
  /** The AI runner's shared secret, compared in the access layer; absent means no service channel. */
  serviceToken?: string;
  /** Every route the access layer knows; anything not listed here is a 404. */
  routes: readonly RoutedRoute[];
  /** The server's view of idleness, read by the VM's loopback-only `/idle` route. */
  idle: IdleTracker;
  calendar?: CalendarSettings;
  calendarFetch?: typeof fetch;
  actionTools: ActionToolOptions;
  roomRoster: RoomRoster;
  /** The one code the second person and phone sign-in need; renewed with the meeting (or fixed by KAKI_MEETING_CODE). */
  meetingCode: MeetingCodeSource;
  /** Wrong-code attempts per client address, shared with phone sign-in and independent of host login. */
  meetingCodeAttempts: AttemptLimiter;
  /** Owns the empty-room grace window: whether an arriving person resumes the meeting or starts a new one. */
  rejoin: RejoinGuard;
  /** The one server-owned identity of the current meeting; its phase lives in the session. */
  meeting: { id: string };
  /** The one owner of meeting resets, phase and generated bookkeeping. */
  session: MeetingSession;
  /** The practice visitor's capability for the current practice meeting, if this request carries it. */
  practicePrincipal(request: IncomingMessage): Principal | undefined;
  /** Run the one Start: wait for the AI runner to open the meeting before declaring it started. */
  startMeeting(practiceRequest?: boolean): Promise<StartOutcome>;
  /** Seats handed out but not yet visible in LiveKit's roster. */
  reservations: SeatReservations;
  /** Runs admissions one at a time so a roster check and its reservation cannot interleave. */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /** Remember the room someone joined and start watching it for the meeting's next empty spell. */
  watchRoom: (roomName: string) => void;
  /** The LiveKit room this meeting uses right now: `kaki-<id>`. */
  roomName(): string;
  /** The room a meeting generation uses, so a committed reset names its new room exactly. */
  roomNameFor(meetingId: string): string;
  /** A person used this meeting; the registry keeps such an instance loaded. */
  onActivity?(): void;
  /** Seconds since the meeting started, read when a settled card is created or revised. */
  meetingElapsedSeconds?: () => number | undefined;
  /** The live agenda item, for a reconnecting runner. */
  meetingAgendaIndex?: () => number | undefined;
  /** Whether the server-owned agenda clock is paused, for the runner snapshot. */
  meetingPaused?: () => boolean | undefined;
  /** Rebuild and publish the runner snapshot after a change no hub event announces (a seat holder). */
  runnerStateChanged(): RunnerMeetingSnapshot;
  /** Rebuild and publish the state every participant reads (a seat holder joined or left). */
  meetingStateChanged(): void;
  /** The journey this meeting runs, read at the moment of use. */
  meetingKind(): 'real' | 'practice' | undefined;
  /** True for a real product meeting, false for a practice meeting. */
  realMeeting: boolean;
  /** True when this is one visitor's own practice meeting. */
  perVisitorPractice: boolean;
  /** Show the people now in a real meeting, one plain seat under each person's name. */
  refreshRealPeople(): void;
  /** Record a quiet agenda-clock note for the shared meeting state. */
  quietCue(text: string): void;
  /** True while the room is off the record: nothing is transcribed, analysed or stored. */
  isOffTheRecord?(): boolean;
  /**
   * The scenario people see, plus the one admission resolves seats against. A returning seat holder
   * inside the grace of a running meeting is judged against its sealed setup; every other arrival
   * starts the next meeting and is judged against the current draft.
   */
  seating(returning?: boolean, roomEmpty?: boolean): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup; admissionCap?: number };
  /** The scenario a browser is shown now: the sealed meeting once started, the draft setup in the lobby. */
  visibleScenario(service?: boolean): Scenario;
  /**
   * What a non-owner sees before a meeting starts: the plan captured when the owner opened the
   * room, or the pack when no meeting has been opened. Never the owner's unopened draft.
   */
  publicScenario(): Scenario;
  /** Freeze the plan the owner just opened as the public lobby view. */
  captureLobbySnapshot(): void;
  /**
   * The first person into an opened lobby picks the agenda for their seat (what the reset they
   * replaced used to shape): install it without resetting the meeting. A no-op for an edited draft.
   */
  shapeLobbyFor(seat: string): void;
  /** Why setup cannot change right now, if it cannot. */
  setupLocked(): 'starting' | 'started' | undefined;
  /** Queue a save of the current meeting, including the setup draft; a no-op without persistence. */
  scheduleSave(): void;
  /** The one writer for a person's finalized line; speaker and seat are checked server-side. */
  writeHumanLine(input: {
    seat: string;
    text: string;
    clientLineId: string;
    meetingId?: string;
    participantIdentity?: string;
    speechStartedAt?: string;
    speechEndedAt?: string;
    micLevel?: number;
    overlap?: boolean;
  }): void;
}

/** One matched request, handed to the route's handler after the access check. */
export interface RouteCall {
  request: IncomingMessage;
  response: ServerResponse;
  context: RequestContext;
  url: URL;
  path: string;
  method: string;
  principal: Principal;
}

/** A route handler: it writes the response for one matched and authorised request. */
export type RouteHandler = (call: RouteCall) => Promise<void>;

/** A route table entry: the access declaration plus the handler that serves it. */
export interface RoutedRoute extends Route {
  handle: RouteHandler;
}

/** The largest request body the JSON-reading routes accept, in bytes. */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * The practice visitor's Start capability lives in this one cookie. It is not a sign-in: it names
 * nothing else, is compared against the current practice meeting's token, and dies with that
 * meeting because a reset clears the token.
 */
export const PRACTICE_COOKIE = 'kaki_practice';

