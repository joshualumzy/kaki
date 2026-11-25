import { randomUUID } from 'node:crypto';
import {
  defaultMeetingSetup,
  demoPackNpcProfileIds,
  deriveMeetingScenario,
  hostIdentityOf,
  isHumanParticipant,
  isPackFreeMeeting,
  KAKI_LISTENER_IDENTITY,
  MEETING_ENDED_MESSAGE,
  meetingScenarioFromSetup,
  parseMeetingSetup,
  resolveAgendaPick,
  setMeetingAgenda,
  setupPersonSeatRoles,
  setupScenarioRoles,
  shuffleAgendaForRole,
  type MeetingMemoryEntry,
  type MeetingSetup,
  type MeetingStateSnapshot,
  type RunnerMeetingSnapshot,
  type Scenario,
  type Task,
} from '@kaki/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { bearerToken, isLoopbackAddress, tokenMatches, type Principal } from '../http/access';
import { cookieValue } from '../http/http';
import { handleRoutedRequest } from '../http/dispatch';
import type { MeetingPauseControl } from '../host';
import type { Auth } from '../auth/module';
import type { CalendarSettings } from '../action/calendar';
import type { ActionToolOptions } from '../action/tools';
import type { AttemptLimiter } from '../http/attemptLimiter';
import { audienceRole, type ClientAudience } from '../core/audience';
import { CommandError, createHub, type MeetingHub } from '../core/hub';
import type { RunnerStartRequest } from '../core/serviceMessages';
import type { IdleTracker } from '../core/idle';
import type { KakiModule } from '../core/modules';
import type { WorkspaceTools } from '../workspace/tools';
import type { MeetingPersistence } from '../persist/persistence';
import type { ArchivedMeetingTodo, MeetingMinutesPublish, MeetingRow } from './types';
import {
  holderForRoomIdentity,
  realBaseScenario,
  realMeetingScenario,
  realMeetingSetup,
  realScenarioWithPeople,
} from './realMeeting';
import type { MeetingCodeSource } from './meetingCode';
import { assertReadableSavedMeeting, assertReadableSavedSetup } from '../persist/state';
import { createRejoinGuard, createRoomPoll, rejoinGraceMsFromEnv, roomPollIntervalMs, REJOIN_POLL_MS } from './rejoin';
import { findCrossSeatDuplicate, rememberSpeechLine, type SpeechLine } from './crossSeatBleed';
import { buildRunnerMeetingSnapshot, hostIsHumanFromSession } from './runnerState';
import { createMeetingSession, type MeetingSession } from './session';
import { createTaskStore, type TaskStore } from './tasks';
import {
  ADMISSION_RESERVATION_MS,
  createAdmissionQueue,
  createSeatReservations,
  removeRoomHumans,
  type RoomRoster,
} from '../services/livekit';
import { PRACTICE_COOKIE, type RequestContext, type RoutedRoute, type StartOutcome } from '../http/routeCall';

/** Whether the AI runner's control socket is connected; shared by every meeting instance. */
export interface RunnerPresence {
  connected(): boolean;
  subscribe(handler: (connected: boolean) => void): () => void;
}

/** One meeting's live state: its own session, hub, task list, room and agenda clock. */
export interface MeetingInstance {
  /** The registry key: the meeting row id, or a random id for a practice meeting. */
  id: string;
  /** The workspace this meeting belongs to. */
  workspaceId: string;
  /** The account that owns this real meeting; null for a practice or ownerless meeting. */
  ownerUserId: string | null;
  /** The kind this instance runs at the AI runner. */
  runnerKind: 'real' | 'practice';
  /** True for a practice meeting that belongs to one visitor. */
  perVisitorPractice: boolean;
  session: MeetingSession;
  hub: MeetingHub;
  tasks: TaskStore;
  memory: MeetingMemoryEntry[];
  /** Fresh modules for this instance; started once and stopped on dispose. */
  modules: KakiModule[];
  /** The LiveKit room this meeting uses right now. */
  roomName: string;
  /** The row meeting_state.id = id; absent when no database is configured. */
  persistence?: MeetingPersistence;
  /** Run one of this meeting's routes; `rest` is the path after the meeting prefix. */
  handle(request: IncomingMessage, response: ServerResponse, rest: string): Promise<void>;
  /** Accept this meeting's `/ws` upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** When a person last used this meeting; the registry unloads instances nobody has touched. */
  lastActivityAt(): number;
  /** How many people are connected right now. */
  connectedPeople(): number;
  /** The code people type to join this meeting right now. */
  meetingCode(): string;
  /**
   * Rebase an unstarted lobby onto an edited row, so its saved draft, agenda and pace match the
   * plan the next opening will use. A room that has begun starting or running is left untouched.
   */
  rebaseScheduledPlan(row: MeetingRow): void;
  /** Stop modules, close the hub and room poll, and save the meeting. */
  dispose(): Promise<void>;
}

/** Everything one meeting needs from the server-wide app. */
export interface MeetingInstanceDeps {
  /** The registry key: the meeting row id, or a random id for a practice meeting. */
  id: string;
  workspaceId: string;
  /** Which journey this instance is for: a real product meeting or a practice meeting. */
  kind: 'real' | 'practice';
  /** The pack this meeting runs; a practice instance always keeps it unchanged. */
  scenario: Scenario;
  /** The row a real product meeting was created from: its own title and agenda, never the pack. */
  meetingRow?: MeetingRow;
  /** Fresh modules for this instance; started once and stopped on dispose. */
  modules: KakiModule[];
  /** The workspace's tool connections, read by Action and never from the environment. */
  tools?: () => Promise<WorkspaceTools>;
  /** This meeting's route table (full /api/... paths). */
  routes: readonly RoutedRoute[];
  devRoutes: boolean;
  persistence?: MeetingPersistence;
  auth?: Auth;
  serviceToken?: string;
  calendar?: CalendarSettings;
  calendarFetch?: typeof fetch;
  actionTools: ActionToolOptions;
  roomRoster: RoomRoster;
  draftOnly: boolean;
  meetingCode: MeetingCodeSource;
  meetingCodeAttempts: AttemptLimiter;
  rejoinGraceMs?: number;
  rejoinPollMs?: number;
  emptyRoomPauseMs?: number;
  admissionReservationMs?: number;
  startAckTimeoutMs?: number;
  meetingElapsedSeconds?: () => number | undefined;
  meetingAgendaIndex?: () => number | undefined;
  meetingPaused?: () => boolean | undefined;
  meetingPause?: MeetingPauseControl;
  speechRecognition: 'server' | 'browser';
  idle: IdleTracker;
  /** The owner's display name, for "Waiting for <owner> to start". */
  ownerName?: string;
  /** The runner's control channel, so a real meeting can say loudly when Kaki cannot hear. */
  runnerPresence?: RunnerPresence;
  /** Record that this meeting's row is over. */
  onEnded?: (endedAt: string) => Promise<void>;
  /**
   * Record that the meeting has really started, before Start commits. Throws when the row is gone
   * or already ended, so a Start can never run a meeting that was cancelled in the same instant.
   */
  onStarted?: () => Promise<void>;
  /**
   * Run this meeting's Start transition under its registry lifecycle lock, so an edit, cancel or
   * load cannot interleave between the phase checks and the transition itself.
   */
  serializeLifecycle?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Keep Kaki's own copy of the minutes with the meeting row; absent for the sample practice meeting. */
  onMinutes?: (archive: { minutes: string; todos: ArchivedMeetingTodo[] }) => Promise<void>;
  /** Keep the minutes card's progress towards the wiki with the meeting row, so history survives a reload. */
  onMinutesPublish?: (publish: MeetingMinutesPublish) => Promise<void>;
}

/** The publish state a minutes card reports, or undefined while it has nothing to report yet. */
function minutesPublishFromTask(task: Pick<Task, 'status' | 'artifactUrl' | 'error'>): MeetingMinutesPublish | undefined {
  switch (task.status) {
    case 'DRAFT_READY':
      return { status: 'draft' };
    case 'RUNNING':
      return { status: 'publishing' };
    case 'COMPLETED':
    case 'SYNCED':
      return {
        status: 'published',
        ...(task.artifactUrl === undefined ? {} : { artifactUrl: task.artifactUrl }),
      };
    case 'FAILED':
      return {
        status: 'failed',
        error: task.error ?? 'Could not publish the minutes.',
      };
    default:
      return undefined;
  }
}

/** Create one meeting: its session, hub, rooms, tasks, routes and modules. */
export async function createMeetingInstance(deps: MeetingInstanceDeps): Promise<MeetingInstance> {
  const {
    id,
    workspaceId,
    kind,
    scenario,
    meetingRow,
    modules,
    tools,
    routes,
    devRoutes,
    persistence,
    auth,
    serviceToken,
    calendar,
    calendarFetch,
    actionTools,
    roomRoster,
    draftOnly,
    meetingCode,
    meetingCodeAttempts,
    rejoinGraceMs,
    rejoinPollMs,
    emptyRoomPauseMs,
    admissionReservationMs = ADMISSION_RESERVATION_MS,
    startAckTimeoutMs = 6_000,
    meetingElapsedSeconds,
    meetingAgendaIndex,
    meetingPaused,
    meetingPause,
    speechRecognition,
    idle,
    ownerName,
    runnerPresence,
    onEnded,
    onStarted,
    serializeLifecycle,
    onMinutes,
    onMinutesPublish,
  } = deps;
  const runnerKind: 'real' | 'practice' = kind;
  const perVisitorPractice = kind === 'practice';
  const ownerUserId = meetingRow?.ownerUserId ?? null;
  let lastActivity = Date.now();
  let people = 0;
  const touch = (): void => {
    lastActivity = Date.now();
  };
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  // A real product meeting owns its own empty scenario. A practice instance keeps today's pack.
  const baseScenario = meetingRow === undefined ? scenario : realBaseScenario(meetingRow);
  const fullScenario = {
    ...baseScenario,
    agenda: [...baseScenario.agenda],
    roles: [...baseScenario.roles],
    attendees: [...baseScenario.attendees],
    ...(baseScenario.npcs === undefined ? {} : { npcs: [...baseScenario.npcs] }),
  };
  const pickedAgenda = agendaPick ? resolveAgendaPick(fullScenario, agendaPick) : undefined;
  // The draft the setup screen starts from, rebuilt from the packaged scenario for every new meeting.
  // A real meeting's draft also carries the pace its owner chose when the meeting was created.
  const baseDefaultSetup = defaultMeetingSetup(fullScenario);
  const defaultSetup =
    meetingRow?.pace === null || meetingRow?.pace === undefined
      ? baseDefaultSetup
      : { ...baseDefaultSetup, pace: { ...meetingRow.pace } };
  // Validate the whole saved meeting before any part of it is applied. A started meeting keeps the
  // sealed setup it ran with, even once it has ended, so its roles are the ones tasks may name.
  const savedMeeting = persistence?.saved;
  let restoredRoles: Scenario['roles'] | undefined;
  if (savedMeeting !== undefined) {
    // A malformed save must give the friendly message before its roles are derived from it.
    assertReadableSavedSetup(savedMeeting, fullScenario, kind === 'real');
    const sealed =
      savedMeeting.phase === 'running' || savedMeeting.phase === 'ended' ? savedMeeting.sealed : undefined;
    restoredRoles = sealed === undefined ? undefined : setupScenarioRoles(fullScenario, sealed);
    // Tasks and talk time may name a role the owner added, so validate against both registries.
    const validationRoles =
      restoredRoles === undefined
        ? fullScenario.roles
        : [
            ...fullScenario.roles,
            ...restoredRoles.filter((role) => !fullScenario.roles.some((packRole) => packRole.id === role.id)),
          ];
    assertReadableSavedMeeting(savedMeeting, { ...fullScenario, roles: validationRoles }, kind === 'real');
    if (meetingCode.fixed) {
      if (savedMeeting.meetingCode !== meetingCode.value) {
        console.log('kaki persist: KAKI_MEETING_CODE replaced the saved meeting code');
      }
    } else {
      meetingCode.restore(savedMeeting.meetingCode);
    }
  }
  const restoredAgendaIndex =
    savedMeeting?.phase === 'running' ? savedMeeting.state.clock.agendaIndex : 0;
  const meeting = { id };
  /** One LiveKit room per registry meeting; a reset never moves it. */
  const roomNameFor = (_meetingId: string): string => `kaki-${id}`;
  const roomName = (): string => roomNameFor(meeting.id);
  /** A fresh copy of the pack; the active scenario is a value, never the pack object itself. */
  function packScenario(): Scenario {
    return {
      ...fullScenario,
      agenda: [...fullScenario.agenda],
      roles: [...fullScenario.roles],
      attendees: [...fullScenario.attendees],
      ...(fullScenario.npcs === undefined ? {} : { npcs: [...fullScenario.npcs] }),
    };
  }
  /** The agenda an untouched draft runs: the role's topics when there is an AI cast, else the pack order. */
  function shapedAgenda(seat: string | undefined): Scenario['agenda'] {
    const hasAi = (fullScenario.npcs ?? []).length > 0;
    if (seat !== undefined && hasAi && fullScenario.agenda.length > 1) {
      const maxAgendaItems = Number(process.env.KAKI_AGENDA_ITEMS) || 2;
      return pickedAgenda ?? shuffleAgendaForRole(fullScenario, seat, Math.random, maxAgendaItems);
    }
    return fullScenario.agenda;
  }
  interface MeetingScenarioOptions {
    agenda: readonly Scenario['agenda'][number][];
    /** Allow a title the pack does not have (a setup topic with no briefing). */
    allowPlain?: boolean;
    meetingTitle?: string;
    roles?: Scenario['roles'];
    npcs?: Scenario['npcs'];
    joinSeats?: string[];
  }

  /**
   * The one way a meeting Scenario is built: a fresh copy of the pack, shaped by the picked agenda
   * through the old normalization (minutes and owner applied, links pruned to surviving titles,
   * excludedPairs pruned). Every other meeting field is applied over that base.
   */
  function meetingScenario({
    agenda,
    allowPlain = false,
    meetingTitle,
    roles,
    npcs,
    joinSeats,
  }: MeetingScenarioOptions): Scenario {
    const next = packScenario();
    if (meetingTitle !== undefined) next.meetingTitle = meetingTitle;
    if (roles !== undefined) next.roles = roles;
    if (npcs !== undefined) next.npcs = npcs;
    if (joinSeats !== undefined) next.joinSeats = joinSeats;
    setMeetingAgenda(next, fullScenario, agenda, { allowPlain });
    return next;
  }

  /** The scenario a reset installs: pack title, roles and cast, with the agenda the next meeting runs. */
  function resetScenario({ seat, draftTouched: touched }: { seat?: string; draftTouched: boolean }): Scenario {
    return meetingScenario({ agenda: touched ? fullScenario.agenda : shapedAgenda(seat) });
  }
  // A lobby's untouched draft runs the shaped pick admission already chose; keep it across a restart.
  const savedLobbyAgenda =
    savedMeeting?.phase === 'lobby' && savedMeeting.lobbyAgenda !== undefined
      ? savedMeeting.lobbyAgenda.map((title) => {
          const item = fullScenario.agenda.find((candidate) => candidate.title === title);
          if (item === undefined) {
            throw new Error(
              `kaki session: the saved lobby agenda names "${title}", which this scenario no longer has`,
            );
          }
          return item;
        })
      : undefined;
  /** The scenario the server boots with: the restored meeting's sealed setup, else the pack's. */
  function bootScenario(): Scenario {
    const sealed =
      savedMeeting !== undefined && (savedMeeting.phase === 'running' || savedMeeting.phase === 'ended')
        ? savedMeeting.sealed
        : undefined;
    if (sealed === undefined) {
      return meetingScenario({ agenda: savedLobbyAgenda ?? fullScenario.agenda });
    }
    // A running meeting and an ended one still under review both keep exactly the plan they ran:
    // its own title, roles, attendees, agenda and cast. The pack only supplies content attached to
    // a matching topic or character, never a second set of roles, seats or people.
    return meetingScenarioFromSetup(fullScenario, sealed, {
      agendaOrder: sealed.agenda.map((item) => item.title),
    });
  }
  const initialScenario = bootScenario();
  const memory: MeetingMemoryEntry[] = [];
  const rejoin = createRejoinGuard({ graceMs: rejoinGraceMs ?? rejoinGraceMsFromEnv() });
  const reservations = createSeatReservations(admissionReservationMs);
  const admit = createAdmissionQueue();
  // The pack owns the reserved names for the whole meeting, whatever cast is active right now.
  const packNpcNames = (fullScenario.npcs ?? []).map((npc) => npc.attendee.toLowerCase());
  // The runner's listener is left in the room like the AI attendees when people are removed.
  const runnerOwnedNames = [...packNpcNames, KAKI_LISTENER_IDENTITY];
  let watchedRoom: string | undefined;
  /**
   * The seats a successful room read shows connected right now, or undefined when it cannot be
   * checked. Cues read this instead of the retained holders, who outlive an individual departure.
   */
  let presentSeats: Set<string> | undefined;
  // The plan the owner opened, frozen for non-owners so later draft edits never leak into it.
  let lobbySnapshot: Scenario | undefined;
  // The server owns the empty-room pause: a running meeting pauses once the room has read empty
  // across the poll debounce (EMPTY_ROOM_PAUSE_MS), and resumes the moment someone returns, but
  // only when the pause was the empty-room kind. A person's explicit Stop stays paused, and the
  // kind is saved so a restart keeps that distinction.
  function autoPauseForEmptyRoom(): void {
    if (meetingPause === undefined || session.phase() !== 'running') return;
    if (meetingPause.paused() !== false) return;
    meetingPause.pause('empty-room');
    console.log('kaki meeting: the room is empty; pausing until someone returns');
    publishRunnerState();
    persistence?.scheduleSave();
  }
  function autoResumeForReturn(): void {
    if (meetingPause === undefined || session.phase() !== 'running') return;
    if (meetingPause.kind() !== 'empty-room') return;
    meetingPause.resume();
    console.log('kaki meeting: someone returned; the meeting resumes');
    publishRunnerState();
    persistence?.scheduleSave();
  }
  /**
   * Remember who a room read shows, for code that must answer "who is present" synchronously.
   * LiveKit's roster is the same source the People view uses; an unreadable roster clears presence
   * so cues fail closed rather than fall back to holders who may have left.
   */
  function rememberPresentPeople(
    people: readonly { name: string; role?: string }[] | undefined,
  ): void {
    if (people === undefined) {
      presentSeats = undefined;
      return;
    }
    const seats = new Set<string>();
    const holders = session.holders();
    for (const person of people) {
      if (!isHumanParticipant(person.name, packNpcNames)) continue;
      const role = person.role?.trim();
      if (role !== undefined && role !== '') {
        seats.add(role.toLowerCase());
        continue;
      }
      const name = person.name.trim().toLowerCase();
      const holder = holders.find(
        (candidate) =>
          (candidate.displayName?.trim() || candidate.name).trim().toLowerCase() === name ||
          candidate.name.trim().toLowerCase() === name,
      );
      if (holder !== undefined) seats.add(holder.seat.trim().toLowerCase());
    }
    presentSeats = seats;
  }
  const roomPoll = createRoomPoll({
    guard: rejoin,
    // Someone joined (even before Start), or the meeting is running: keep watching the room.
    hasMeeting: () =>
      session.reviewingEndedTeamMeeting() ||
      (!session.abandoned() && (session.holders().length > 0 || session.phase() === 'running')),
    roster: roomRoster,
    roomName: () => watchedRoom,
    isHuman: (name) => isHumanParticipant(name, packNpcNames),
    onRoster: rememberPresentPeople,
    // Quick while a meeting runs so an empty room pauses and a returning person resumes promptly;
    // the slower interval is only for the grace window around a meeting that has not started.
    intervalMs: () =>
      roomPollIntervalMs(session.phase() === 'running', rejoinPollMs ?? REJOIN_POLL_MS),
    ...(emptyRoomPauseMs === undefined ? {} : { emptyPauseAfterMs: emptyRoomPauseMs }),
    onEmpty: autoPauseForEmptyRoom,
    onOccupied: autoResumeForReturn,
  });
  const watchRoom = (roomName: string): void => {
    watchedRoom = roomName;
    roomPoll.start();
  };
  const closeRejoin = (): void => {
    roomPoll.reset();
    roomPoll.close();
    rejoin.close();
  };
  /**
   * The practice visitor's capability, read from the cookie. The cookie names its own meeting
   * (`<meetingId>.<capability>`), so another practice's cookie is never accepted here.
   */
  function practicePrincipal(request: IncomingMessage): Principal | undefined {
    if (session.kind() !== 'practice') return undefined;
    const token = session.practiceStartToken();
    if (token === undefined) return undefined;
    if (session.practiceGeneration() !== session.generation()) return undefined;
    const raw = cookieValue(request, PRACTICE_COOKIE);
    if (raw === undefined) return undefined;
    const dot = raw.indexOf('.');
    if (dot === -1 || raw.slice(0, dot) !== id) return undefined;
    return tokenMatches(raw.slice(dot + 1), token) ? { kind: 'practice' } : undefined;
  }
  let roomCleanupWarned = false;
  /**
   * A meeting handoff: close every practice authority and remove the people from the room that no
   * longer exists. Room identity alone already refuses an old token; this makes it immediate.
   */
  function onCredentialChange(ended: boolean, kind?: 'real' | 'practice'): void {
    // A practice END is the end of its agenda, not a handoff: the visitor must stay connected to
    // receive the closing cue, the frozen record and the minutes card, exactly as in open mode.
    // Its people are removed and its sockets revoked on the next reset or owner handoff.
    if (ended && kind === 'practice') return;
    hub.endPracticeSessions?.(MEETING_ENDED_MESSAGE);
    // Ending a real meeting keeps its room: the owner and participants stay to review and publish
    // the minutes. Everything else here is a handoff that replaces the room, so its people and
    // practice authority go with it.
    if (ended && kind === 'real') return;
    const oldRoom = watchedRoom ?? roomName();
    void removeRoomHumans(oldRoom, runnerOwnedNames).catch((error: unknown) => {
      if (roomCleanupWarned) return;
      roomCleanupWarned = true;
      console.warn(`kaki livekit: could not remove people from the old room ${oldRoom}`, error);
    });
  }
  const serviceTokenConfigured = serviceToken !== undefined && serviceToken !== '';
  /** The roles an AI profile currently voices; Start narrows this to the sealed AI seats. */
  const aiVoiceRoles = (): Set<string> => {
    const active = session.active();
    const profiles = new Set((active.npcs ?? []).map((npc) => npc.attendee));
    return new Set(
      active.attendees.filter((attendee) => profiles.has(attendee.name)).map((attendee) => attendee.role),
    );
  };
  const isHumanSeat = (role: string): boolean =>
    session.holders().some((holder) => holder.seat === role);
  /**
   * Whether the person in each seat is a guest, learned from the principal that authorized their
   * socket. A seat's own ask always arrives over such a socket, so the map is current when read.
   */
  const seatGuests = new Map<string, boolean>();
  const runnerMayUseAudience = (audience: ClientAudience): boolean => {
    const role = audienceRole(audience);
    return role !== undefined && aiVoiceRoles().has(role) && !isHumanSeat(role);
  };
  /** One WebSocket authorization path: the runner token first, then the same session principal as HTTP. */
  const authorizeUpgradeBase = async (
    request: IncomingMessage,
    audience: ClientAudience,
  ): Promise<Awaited<ReturnType<Auth['authorize']>>> => {
    const runnerRequest =
      serviceTokenConfigured && tokenMatches(bearerToken(request), serviceToken ?? '');
    // A configured service token always gates the service channel, even when user sign-in is off.
    if (audience.kind === 'service') {
      if (serviceTokenConfigured) {
        return runnerRequest
          ? { ok: true, runner: true, principal: { kind: 'service' } }
          : { ok: false, message: 'Service sign-in required' };
      }
      // No credential configured: only a direct local peer may use the service channel.
      if (auth === undefined) return isLoopbackAddress(request.socket.remoteAddress)
        ? { ok: true, principal: { kind: 'service' } }
        : { ok: false, message: 'Service sign-in required' };
      return auth.authorize(request, audience, id);
    }
    if (runnerRequest) {
      if (audience.kind === 'screen') {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      if (audience.kind === 'lifecycle') {
        return { ok: false, message: 'The AI runner does not follow the lifecycle feed' };
      }
      if (runnerMayUseAudience(audience)) {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      return { ok: false, message: 'The AI runner may not act as a human seat' };
    }
    if (auth === undefined) {
      // With sign-in off there is no owner to tell apart from the one practice visitor. Tag every
      // socket of a practice meeting as practice, so it is read-only on the screen and dies with
      // the meeting instead of carrying into the real one that replaces it.
      if (session.kind() === 'practice') {
        const seat = session.practiceSeat();
        return {
          ok: true,
          principal: { kind: 'practice' },
          ...(seat === undefined ? {} : { seat }),
        };
      }
      return { ok: true };
    }
    // A practice visitor follows only their own practice meeting: its lifecycle, its screen and
    // the seat they took. The capability dies with the meeting, so it can never reach another one.
    const practice = practicePrincipal(request);
    if (practice !== undefined) {
      const seat = session.practiceSeat();
      const role = audienceRole(audience);
      if (audience.kind === 'lifecycle' || audience.kind === 'screen' || (seat !== undefined && role === seat)) {
        return {
          ok: true,
          principal: practice,
          ...(seat === undefined ? {} : { seat }),
        };
      }
      return { ok: false, message: 'Practice access belongs to its practice meeting only' };
    }
    return auth.authorize(request, audience, id, { anyOfferedSeat: true });
  };
  const authorizeUpgrade = async (
    request: IncomingMessage,
    audience: ClientAudience,
  ): Promise<Awaited<ReturnType<Auth['authorize']>>> => {
    const decision = await authorizeUpgradeBase(request, audience);
    if (decision.ok) {
      const principal = decision.principal;
      const seat =
        audienceRole(audience) ??
        decision.seat ??
        (principal?.kind === 'seat' ? principal.role : undefined) ??
        (principal?.kind === 'host' ? principal.seat : undefined);
      if (seat !== undefined) {
        if (principal?.kind === 'seat' || principal?.kind === 'host') {
          // An owner, host or seat holder goes through the same workspace-membership check. A seat
          // without an account, a signed-in person outside this workspace, or a check the server
          // cannot make all fail closed as a guest: retained workspace facts must never reach
          // someone whose membership is not proven.
          const userId = principal.userId;
          let guest = true;
          if (userId !== undefined && auth !== undefined) {
            try {
              const workspaceMissing = (await auth.store.getWorkspace(workspaceId)) === undefined;
              if (!workspaceMissing) {
                guest =
                  (await auth.store.getMembership({ workspaceId, userId })) ===
                  undefined;
              }
            } catch (error) {
              console.warn(`kaki meetings: could not read a seat holder's workspace membership`, error);
              // A lookup that fails is not a missing workspace: keep the seat failed closed.
              guest = true;
            }
          }
          seatGuests.set(seat, guest);
        } else if (decision.runner === true || principal?.kind === 'practice') {
          // The AI runner and a practice visitor are not workspace guests: the runner acts for an
          // AI colleague inside the pack, and a practice visitor never reaches real workspace data.
          seatGuests.set(seat, false);
        } else {
          // An unidentified principal fails closed as a guest.
          seatGuests.set(seat, true);
        }
      }
    }
    return decision;
  };
  const hub = createHub(null, () => session.active(), {
    noServer: true,
    authorize: authorizeUpgrade,
    closeUnknownRoleAfterUpgrade: auth === undefined && !serviceTokenConfigured,
    isHumanSeat,
    // A real meeting re-checks a seat's membership on every reconnect; an unknown seat fails
    // closed as a guest. Practice meetings keep their sample workspace on replay.
    retainedFactsAllowed: (role) => session.kind() !== 'real' || seatGuests.get(role) === false,
    onPersonConnected: () => {
      people += 1;
      touch();
      idle.personConnected();
    },
    onPersonDisconnected: () => {
      people = Math.max(0, people - 1);
      touch();
      idle.personDisconnected();
    },
    onPersonActivity: () => {
      touch();
      idle.recordActivity();
    },
    onPersonAction: () => {
      touch();
      idle.recordAction();
    },
  });
  // A revoked session is gone, so every hub closes its sockets. A replaced one (the same person
  // signed in again or took a seat) leaves an owner's screen open in a real meeting.
  const stopSessionEnded = auth?.onSessionEnded((sessionTokenHash, reason) => {
    if (reason === 'revoked') hub.endSession?.(sessionTokenHash);
  });
  const tasks = createTaskStore({
    hub,
    scenario: () => session.active(),
    seatIsGuest: (role) => seatGuests.get(role),
    isHostSeat: (role) => hostIdentityOf(session.active()).seat === role,
  });
  hub.onCommand(tasks.handleCommand);
  // One publish-state write at a time, in task order: a slow "draft" write can never land after a
  // newer "published" one. A failed write is logged loudly but does not stop later writes.
  let publishStateWrites: Promise<void> = Promise.resolve();
  function keepMinutesPublish(publish: MeetingMinutesPublish): Promise<void> {
    if (onMinutesPublish === undefined) return Promise.resolve();
    const write = publishStateWrites.then(() => onMinutesPublish(publish));
    publishStateWrites = write.catch((error: unknown) => {
      console.error(
        `kaki minutes: could not keep the publish state "${publish.status}" for ${id}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
    });
    return publishStateWrites;
  }
  // The ended team meeting is the owner's until the minutes are published or dismissed. Any other
  // task moving says nothing about that review, so leave the protection alone.
  tasks.onChange((task) => {
    if (task.purpose !== 'meeting_minutes') return;
    const publish = minutesPublishFromTask(task);
    if (publish !== undefined) void keepMinutesPublish(publish);
    if (
      task.status === 'COMPLETED' ||
      task.status === 'SYNCED' ||
      task.status === 'DISMISSED' ||
      task.status === 'SUPERSEDED'
    ) {
      session.finishReview();
    }
  });

  // The AI runner must confirm it prepared the meeting before Start succeeds. Without that
  // acknowledgement a guest would sit on "Starting..." forever while nobody speaks.
  interface RunnerWaiter {
    meetingId: string;
    resolve(): void;
    reject(error: Error): void;
  }
  const runnerWaiters = new Map<string, RunnerWaiter>();
  /** A Start attempt whose acknowledgement must still match this exact meeting. */
  interface ActiveStart {
    attempt: string;
    meetingId: string;
    promise: Promise<StartOutcome>;
  }
  let starting: ActiveStart | undefined;
  /** Acknowledgements already refused, so a late one is logged once rather than on every retry. */
  const ignoredAcks = new Set<string>();

  function logIgnoredAck(key: string, reason: string): void {
    if (ignoredAcks.has(key)) return;
    ignoredAcks.add(key);
    if (ignoredAcks.size > 100) ignoredAcks.clear();
    console.warn(`kaki server: ignored a runner acknowledgement (${reason})`);
  }

  hub.onServiceMessage?.((message) => {
    if (message.attempt !== message.requestId) {
      logIgnoredAck(message.requestId, `attempt ${message.attempt} does not match request ${message.requestId}`);
      return;
    }
    const waiter = runnerWaiters.get(message.requestId);
    if (waiter === undefined) {
      logIgnoredAck(message.requestId, `no Start is waiting for ${message.requestId}`);
      return;
    }
    if (waiter.meetingId !== message.meetingId || message.meetingId !== meeting.id) {
      runnerWaiters.delete(message.requestId);
      logIgnoredAck(message.requestId, `it names meeting ${message.meetingId}, not the current ${meeting.id}`);
      waiter.reject(new Error('the meeting changed while it was starting'));
      return;
    }
    runnerWaiters.delete(message.requestId);
    if (message.kind === 'ready') waiter.resolve();
    else waiter.reject(new Error(message.reason ?? 'the AI attendees could not prepare the meeting'));
  });

  /**
   * A real meeting's runner needs a few seconds after the meeting is created to open its control and
   * service sockets. Wait for both inside the Start window rather than failing the owner's first press.
   */
  function waitForRunnerReady(deadline: number): Promise<boolean> {
    const ready = (): boolean =>
      (runnerPresence === undefined || runnerPresence.connected()) &&
      hub.servicePresence?.().connected === true;
    if (ready()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function settle(value: boolean): void {
        if (settled) return;
        settled = true;
        unsubscribePresence();
        unsubscribeService();
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      }
      const onPresence = (): void => {
        if (ready()) settle(true);
      };
      const unsubscribePresence: () => void =
        runnerPresence === undefined ? () => {} : runnerPresence.subscribe(onPresence);
      const unsubscribeService =
        hub.onServicePresence === undefined ? () => {} : hub.onServicePresence(onPresence);
      timer = setTimeout(() => settle(ready()), Math.max(0, deadline - Date.now()));
      timer.unref?.();
    });
  }

  /** Ask the runner to open the meeting, waiting for it to connect when a real meeting starts early. */
  async function requestRunnerStart(request: RunnerStartRequest, deadline: number): Promise<boolean> {
    for (;;) {
      if (hub.requestStart?.(request) === true) return true;
      if (Date.now() >= deadline) return false;
      const isReady = await waitForRunnerReady(deadline);
      if (!isReady) return false;
    }
  }

  function waitForRunner(attempt: string, meetingId: string, deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runnerWaiters.delete(attempt);
        reject(new Error('no acknowledgement from the AI attendees'));
      }, Math.max(1, deadline - Date.now()));
      timer.unref?.();
      runnerWaiters.set(attempt, {
        meetingId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Abandon every Start in flight because its meeting is gone; a late acknowledgement cannot revive it. */
  function cancelPendingStart(reason: string): void {
    for (const [attempt, waiter] of [...runnerWaiters]) {
      runnerWaiters.delete(attempt);
      waiter.reject(new Error(reason));
    }
    starting = undefined;
  }

  /** Move to a new meeting identity; a reset carries the id every client and runner must adopt. */
  function rotateIdentity({ rotateCode = true }: { rotateCode?: boolean } = {}): string {
    const previousMeetingId = meeting.id;
    if (rotateCode) meetingCode.rotate();
    // A phone session belongs to one meeting generation: close its sockets and free its seats.
    // Host screen and lifecycle feeds stay; the runner's own sockets stay.
    if (auth !== undefined || !meetingCode.fixed) hub.endRoleSessions?.(MEETING_ENDED_MESSAGE);
    void auth?.releaseMeeting(previousMeetingId);
    cancelPendingStart('the meeting was reset while it was starting');
    // A new meeting identity means the opened room is gone; its public lobby snapshot must not
    // carry into the next one. The first arrival's reset keeps the identity, so it keeps the plan.
    lobbySnapshot = undefined;
    // A per-visitor practice is one meeting of its own, addressed by its registry id: a reset
    // (New meeting) keeps that id so its prefixed routes and room stay resolvable.
    if (!perVisitorPractice) meeting.id = randomUUID();
    return meeting.id;
  }

  /** The holder whose seat is a person seat, taking the first person seat in setup order. */
  function holderPersonSeat(): string | undefined {
    const setup = session.sealed() ?? session.draft();
    const holders = session.holders();
    for (const roleId of setupPersonSeatRoles(setup)) {
      const key = roleId.trim().toLowerCase();
      if (holders.some((holder) => holder.seat.trim().toLowerCase() === key)) return roleId;
    }
    // An admitted holder can sit in a seat the untouched draft still marks AI; that person is the
    // human the next meeting is shaped for.
    return holders[0]?.seat;
  }

  const session = createMeetingSession({
    hub,
    memory,
    defaultSetup,
    resetScenario,
    restoreActive: () => bootScenario(),
    saved: savedMeeting,
    initialScenario,
    meetingId: () => meeting.id,
    meetingCode: () => meetingCode.value,
    rotateIdentity,
    defaultSeat: holderPersonSeat,
    clearGrace: () => rejoin.reset(),
    onCredentialChange,
    ...(kind === 'real' ? { allowEmptyScenario: true } : {}),
    ...(persistence === undefined ? {} : { persistence }),
  });
  // A real meeting is fixed at creation: it is never a practice meeting.
  if (kind === 'real') {
    session.setKind('real');
    if (session.holders().length > 0) {
      session.refreshRealScenario(realScenarioForRoom());
    }
  }
  /**
   * A real meeting's scenario with the people now in it. The current scenario already carries the
   * agenda owners the meeting sealed; a sealed setup is re-applied so an owner who is absent, whether
   * before or after joining, keeps the stable seat the meeting named. Only people's plain seats are
   * added, so a roster refresh never brings back AI attendees or drops a late joiner's role.
   */
  function realScenarioForRoom(): Scenario {
    const holders = session.holders();
    const sealed = session.sealed();
    return sealed === undefined
      ? realScenarioWithPeople(session.active(), holders)
      : realMeetingScenario(session.active(), holders, sealed);
  }
  /** Show the people now in a real meeting: one plain seat per person, named by them. */
  function refreshRealPeople(): void {
    if (kind !== 'real') return;
    session.refreshRealScenario(realScenarioForRoom());
    // The web validates speaker roles against its scenario, so a person who joins must also be
    // told to reload it; otherwise their lines are dropped as unknown roles on everyone's screen.
    hub.publish({
      type: 'SCENARIO_CHANGED',
      audience: { kind: 'all' },
      payload: { meetingId: meeting.id },
    });
  }
  // The task store belongs to the meeting, so a reset forgets its cards too. The session clears
  // every retained key (including 'task:') after these hooks run.
  session.onReset(() => {
    tasks.reset();
    roomPoll.reset();
    reservations.clear();
    presentSeats = undefined;
  });

  /** Speech lines are bounded separately: a long recognised turn is still one line. */
  const HUMAN_LINE_MAX_SPEECH_CHARS = 2_000;
  /** Per seat, at most this many lines in the window; a retry is deduped before it is counted. */
  const HUMAN_LINE_RATE_LIMIT = 5;
  const HUMAN_LINE_RATE_WINDOW_MS = 1_000;
  /** How many recent line ids one seat is remembered by, so a retry cannot write twice. */
  const HUMAN_LINE_MEMORY_PER_SEAT = 200;

  /**
   * The one writer for a person's finalized speech line. The speaker is always resolved from the
   * socket's current seat holder and the setup, never from the client payload. The line is
   * published as an ordinary transcript chunk, so the screen, notetaker and minutes all see it.
   */
  interface HumanLineMemory {
    ids: Set<string>;
    order: string[];
  }
  const humanLineIds = new Map<string, HumanLineMemory>();
  /**
   * A real meeting keeps its latest spoken lines on the hub, so a person who refreshes or rejoins
   * sees the recent conversation again instead of an empty transcript. Practice rooms and their AI
   * runner hear lines live only.
   */
  const RETAINED_LINES = 50;
  const retainedLineKeys: string[] = [];
  let retainedLineCount = 0;
  function retainRecentLine(): { retainKey: string } | undefined {
    if (session.kind() !== 'real') return undefined;
    retainedLineCount += 1;
    const retainKey = `line:${retainedLineCount}:`;
    retainedLineKeys.push(retainKey);
    if (retainedLineKeys.length > RETAINED_LINES) {
      const oldest = retainedLineKeys.shift();
      if (oldest !== undefined) hub.clearRetained(oldest);
    }
    return { retainKey };
  }
  const humanLineTimes = new Map<string, number[]>();
  /** Accepted speech lines, so a second seat's microphone picking up the same voice is not written twice. */
  const recentSpeechLines: SpeechLine[] = [];
  hub.subscribe((event) => {
    if (event.type !== 'MEETING_RESET') return;
    humanLineIds.clear();
    humanLineTimes.clear();
    recentSpeechLines.length = 0;
  });

  function seatKey(seat: string): string {
    return seat.trim().toLowerCase();
  }

  function writeHumanLine({
    seat,
    text,
    clientLineId,
    meetingId,
    participantIdentity,
    speechStartedAt,
    speechEndedAt,
    micLevel,
    overlap,
  }: {
    seat: string;
    text: string;
    clientLineId: string;
    meetingId?: string;
    participantIdentity?: string;
    speechStartedAt?: string;
    speechEndedAt?: string;
    micLevel?: number;
    overlap?: boolean;
  }): void {
    if (meetingId !== undefined && meetingId !== meeting.id) {
      throw new CommandError('That line belongs to a different meeting');
    }
    // Off the record: the room's words are not transcribed, analysed or stored.
    if (session.offTheRecordSince() !== undefined) return;
    const phase = session.phase();
    if (phase !== 'running' && phase !== 'starting') {
      throw new CommandError('The meeting is not running');
    }
    const holders = session.holders();
    const wantedSeat = seatKey(seat);
    const holder =
      participantIdentity === undefined
        ? holders.find((candidate) => seatKey(candidate.seat) === wantedSeat)
        : holderForRoomIdentity(holders, participantIdentity);
    if (holder === undefined) {
      throw new CommandError(
        participantIdentity === undefined
          ? 'Only a person seated in this meeting can add a line'
          : 'That person is no longer seated in this meeting',
      );
    }
    if (seatKey(holder.seat) !== wantedSeat) {
      throw new CommandError('That person no longer holds that seat');
    }
    const cleaned = text.trim();
    if (cleaned === '') throw new CommandError('A line needs some words');
    if (cleaned.length > HUMAN_LINE_MAX_SPEECH_CHARS) {
      throw new CommandError(`That line is too long; keep it under ${HUMAN_LINE_MAX_SPEECH_CHARS} characters`);
    }
    const key = seatKey(holder.seat);
    const seen = humanLineIds.get(key);
    if (seen?.ids.has(clientLineId)) return;
    // The admitted person is the speaker; the setup seat is only the role they took.
    const speaker = holder.displayName?.trim() || holder.name;
    if (speaker.trim() === '') {
      throw new CommandError('That person has no name in this meeting');
    }
    const now = Date.now();
    const startedAtMs = speechStartedAt === undefined ? undefined : Date.parse(speechStartedAt);
    const endedAtMs = speechEndedAt === undefined ? undefined : Date.parse(speechEndedAt);
    // Two microphones in one room can both recognise the same voice. Only audio evidence proves it:
    // the two stretches must overlap in time and this microphone must have been clearly quieter.
    // The same words alone are not enough, because two people really do both say "Yes".
    const line = {
      seat: key,
      speaker,
      text: cleaned,
      ...(startedAtMs === undefined || !Number.isFinite(startedAtMs) ? {} : { speechStartedAt: startedAtMs }),
      ...(endedAtMs === undefined || !Number.isFinite(endedAtMs) ? {} : { speechEndedAt: endedAtMs }),
      ...(micLevel === undefined ? {} : { micLevel }),
    };
    const duplicate = findCrossSeatDuplicate(line, recentSpeechLines);
    if (duplicate !== undefined) {
      console.warn(
        `kaki transcript: dropped "${cleaned}" from ${speaker}; ${duplicate.speaker}'s line overlaps it and this microphone was quieter (${micLevel?.toFixed(3)} vs ${duplicate.micLevel?.toFixed(3)}), so another seat's microphone heard it too`,
      );
      return;
    }
    rememberSpeechLine(recentSpeechLines, line);
    const times = (humanLineTimes.get(key) ?? []).filter((at) => now - at < HUMAN_LINE_RATE_WINDOW_MS);
    if (times.length >= HUMAN_LINE_RATE_LIMIT) {
      throw new CommandError('Too many lines at once; wait a moment and try again');
    }
    times.push(now);
    humanLineTimes.set(key, times);
    const memory = seen ?? { ids: new Set<string>(), order: [] };
    memory.ids.add(clientLineId);
    memory.order.push(clientLineId);
    if (memory.order.length > HUMAN_LINE_MEMORY_PER_SEAT) {
      const oldest = memory.order.shift();
      if (oldest !== undefined) memory.ids.delete(oldest);
    }
    humanLineIds.set(key, memory);
    hub.publish(
      {
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: {
          speaker,
          text: cleaned,
          timestamp: speechStartedAt ?? new Date().toISOString(),
          speakerRole: holder.seat,
          ...(speechStartedAt === undefined ? {} : { speechStartedAt }),
          ...(speechEndedAt === undefined ? {} : { speechEndedAt }),
          ...(overlap === true ? { overlap: true } : {}),
        },
      },
      retainRecentLine(),
    );
  }

  /** The seat a socket writes as: its own role, or the host's chair when a person hosts the screen. */
  function seatForSender(sender: ClientAudience): string | undefined {
    const role = audienceRole(sender);
    if (role !== undefined) return role;
    if (sender.kind !== 'screen') return undefined;
    if (!hostIsHumanFromSession(session, session.active())) return undefined;
    return hostIdentityOf(session.active()).seat;
  }

  hub.onCommand((command, sender) => {
    if (command.type !== 'HUMAN_LINE') return;
    const seat = seatForSender(sender);
    if (seat === undefined) throw new CommandError('Only a person seated in this meeting can add a line');
    // A line names the seat it was spoken in. A socket that now writes as another seat must not
    // deliver it as that other person.
    if (command.seat !== undefined && seatKey(command.seat) !== seatKey(seat)) {
      throw new CommandError('That line belongs to a different seat');
    }
    writeHumanLine({
      seat,
      text: command.text,
      clientLineId: command.clientLineId,
      ...(command.meetingId === undefined ? {} : { meetingId: command.meetingId }),
    });
  });

  hub.onCommand((command, sender) => {
    if (command.type !== 'SET_OFF_THE_RECORD') return;
    // Off the record belongs to a real meeting only.
    if (runnerKind !== 'real' || session.kind() !== 'real') {
      throw new CommandError('Off the record is only available in a real meeting');
    }
    // Any person in the meeting may take it off the record or bring it back; the runner and the
    // service channel are not people and may not speak for the room.
    if (sender.kind === 'service' || sender.kind === 'lifecycle') {
      throw new CommandError('Only a person in this meeting can change off the record');
    }
    if (command.on === (session.offTheRecordSince() !== undefined)) return;
    session.setOffTheRecord(command.on);
    publishMeetingState();
    publishRunnerState();
    persistence?.scheduleSave();
  });

  // The AI runner reads exactly this snapshot, through the service-only endpoint and RUNNER_STATE.
  // Its version moves only when a field a runner can see changes, so a reconnect can fence old reads.
  // The version is a server-incarnation fence: `epoch` is made once for this process, ordered by the
  // boot time and identified by a random id, and `seq` only increases across every meeting. A
  // restarted server therefore starts a newer epoch instead of having to continue a persisted
  // revision it may never have managed to save.
  /** The latest quiet agenda note for a real meeting; null until the clock raises one. */
  let meetingCue: MeetingStateSnapshot['cue'] = null;
  /** Set while the notetaker's own model is failing or too slow; the room shows it in plain words. */
  let notetakerNotesPaused: string | null = null;
  /** A real meeting cannot be heard while the runner's control socket is away: say so loudly. */
  const notesPausedMessage = "Kaki can't hear the room right now";
  function runnerIsDown(): boolean {
    return runnerKind === 'real' && runnerPresence !== undefined && !runnerPresence.connected();
  }
  function buildMeetingState(): MeetingStateSnapshot {
    return {
      meetingId: meeting.id,
      phase: session.phase(),
      ...(session.kind() === undefined ? {} : { kind: session.kind() }),
      started: session.phase() === 'running',
      waitingForOwner: runnerKind === 'real' && session.kind() === 'real' && session.phase() === 'lobby',
      ownerName: ownerName ?? null,
      offTheRecord:
        session.offTheRecordSince() === undefined ? null : { since: session.offTheRecordSince()! },
      participants: session.holders().map((holder) => ({
        name: holder.name,
        displayName: holder.displayName ?? holder.name,
        seat: holder.seat,
        photoUrl: holder.photoUrl ?? null,
      })),
      // A missing runner is the more basic failure; otherwise the notetaker's own catch-up shows.
      notesPaused: runnerIsDown() ? notesPausedMessage : notetakerNotesPaused,
      cue: meetingCue,
    };
  }
  /** Broadcast the one state every participant reads; retained so a late joiner sees it at once. */
  function publishMeetingState(): void {
    // A practice meeting takes no part in real-meeting state.
    if (runnerKind !== 'real') return;
    hub.publish(
      { type: 'MEETING_STATE', audience: { kind: 'all' }, payload: buildMeetingState() },
      { retainKey: 'meeting:state' },
    );
  }
  const stopRunnerPresence = runnerPresence?.subscribe(() => publishMeetingState());

  const runnerEpoch = { startedAt: Date.now(), id: randomUUID() };
  let runnerStateSeq = 0;
  let runnerStateSignature: string | undefined;
  function publishRunnerState(): RunnerMeetingSnapshot {
    const state = buildRunnerMeetingSnapshot({
      meetingId: meeting.id,
      session,
      fullScenario,
      agendaIndex: meetingAgendaIndex?.(),
      paused: meetingPaused?.(),
      pauseKind: meetingPause?.kind(),
      offTheRecordSince: session.offTheRecordSince(),
    });
    const signature = JSON.stringify(state);
    let version = { epoch: runnerEpoch, seq: runnerStateSeq };
    if (signature !== runnerStateSignature) {
      runnerStateSignature = signature;
      runnerStateSeq += 1;
      version = { epoch: runnerEpoch, seq: runnerStateSeq };
      hub.publish(
        { type: 'RUNNER_STATE', audience: { kind: 'service' }, payload: { ...state, version } },
        { retainKey: 'runner:state' },
      );
    }
    return { ...state, version };
  }
  // Start, agenda moves and pause/resume all surface as these events; a seat change is published
  // by whoever changes the roster, because it has no event of its own.
  let endedRecordedFor: string | undefined;
  hub.subscribe((event) => {
    if (event.type === 'MEETING_RESET') {
      // A reset always yields a newer snapshot, even when it keeps the meeting id and every visible
      // field (the runner cleared its copy and must be able to adopt the republished version).
      runnerStateSignature = undefined;
      meetingCue = null;
      notetakerNotesPaused = null;
      publishRunnerState();
      publishMeetingState();
      return;
    }
    if (event.type === 'MEETING_STARTED') {
      publishRunnerState();
      publishMeetingState();
    } else if (event.type === 'MEETING_RECORD_UPDATED') {
      publishRunnerState();
      if (event.payload.ended === true) publishMeetingState();
    }
    if (event.type === 'MEETING_RECORD_UPDATED' && event.payload.ended === true && onEnded !== undefined) {
      // The meeting row is over for everyone, not merely this process's session.
      if (endedRecordedFor !== meeting.id) {
        endedRecordedFor = meeting.id;
        void onEnded?.(new Date().toISOString()).catch((error: unknown) =>
          console.error('kaki meetings: could not mark the meeting ended', error),
        );
      }
    }
  });
  // Server-side recognition lives in the runner, so the screen must know when that service is gone.
  // Browser recognition needs no runner, and then this is always on.
  const servicePresence = (): { connected: boolean; serverSpeech: boolean } =>
    hub.servicePresence?.() ?? { connected: false, serverSpeech: false };
  function publishSpeechRecording(): void {
    if (session.phase() !== 'running') return;
    const recording = speechRecognition === 'browser' || servicePresence().serverSpeech;
    hub.publish(
      { type: 'SPEECH_RECORDING', audience: { kind: 'all' }, payload: { recording } },
      { retainKey: 'speech:recording' },
    );
  }
  hub.onServicePresence?.(() => publishSpeechRecording());
  hub.subscribe((event) => {
    if (event.type === 'MEETING_STARTED') publishSpeechRecording();
  });
  // The grace ending is not proof the room is empty: a still-connected holder must survive. Only a
  // roster read that succeeds, shows no person and no live reservation may prune and abandon.
  let rosterOutageLogged = false;
  function checkRoomBeforePruning(): void {
    // The read can arrive after the owner reset and started a replacement meeting. It only applies
    // to the grace window it was asked for, never to the next meeting's holders.
    const forMeetingId = meeting.id;
    const forGeneration = session.generation();
    const forGraceEpoch = rejoin.epoch();
    const watchedRoomName = watchedRoom ?? roomName();
    void roomRoster(watchedRoomName)
      .then((roster) => {
        if (
          meeting.id !== forMeetingId ||
          session.generation() !== forGeneration ||
          rejoin.epoch() !== forGraceEpoch
        ) {
          return;
        }
        if (roster === undefined) {
          if (!rosterOutageLogged) {
            console.warn(
              'kaki rejoin: could not check who is in the room; keeping the meeting and its holders',
            );
            rosterOutageLogged = true;
          }
          return;
        }
        rosterOutageLogged = false;
        const humans = roster.filter((person) => isHumanParticipant(person.name, packNpcNames));
        if (humans.length > 0) {
          // The poll lagged: someone is still there, so keep the meeting open.
          rejoin.occupied();
          return;
        }
        // A token was just issued but LiveKit has not shown the person yet: keep their seat.
        if (reservations.active(roster.map((person) => person.name)).length > 0) return;
        session.pruneHolders();
        publishRunnerState();
        publishMeetingState();
        // An ended meeting that is verified empty has nobody left to review the minutes.
        if (session.phase() === 'ended') session.finishReview();
        if (session.phase() === 'running') session.abandon();
        // A verified empty real meeting is released, so it can never block practice forever. A
        // running one keeps its abandonment mark for the restart path; a lobby is rotated clean.
        if (session.kind() === 'real') {
          if (session.phase() === 'running') session.releaseRealMeeting();
          else session.reset();
        }
        persistence?.scheduleSave();
      })
      .catch((error: unknown) => {
        if (
          meeting.id !== forMeetingId ||
          session.generation() !== forGeneration ||
          rejoin.epoch() !== forGraceEpoch
        ) {
          return;
        }
        if (rosterOutageLogged) return;
        rosterOutageLogged = true;
        console.warn(
          'kaki rejoin: could not check who is in the room; keeping the meeting and its holders',
          error,
        );
      });
  }
  rejoin.onGraceExpired(checkRoomBeforePruning);
  // A restored running meeting starts its grace now and watches its own room immediately, so a
  // connected holder is never pruned merely because no new token request arrived.
  if (savedMeeting?.phase === 'running' && !session.abandoned()) {
    watchedRoom = roomName();
    rejoin.beginGrace();
    roomPoll.start();
  }
  // A restored ended team meeting is still under review: watch its room now so a verified empty
  // room expires the review and releases the server for practice, exactly as a live END would.
  if (session.reviewingEndedTeamMeeting()) {
    watchedRoom = roomName();
    rejoin.beginGrace();
    roomPoll.start();
  }

  /** Setup writes are refused from the moment Start begins until it commits or fails. */
  function setupLocked(): 'starting' | 'started' | undefined {
    const phase = session.phase();
    if (phase === 'running') return 'started';
    if (phase === 'starting') return 'starting';
    return undefined;
  }

  /** The roles the setup offers as person seats, including a role the owner added in setup. */
  function personSeatRoles(setup: MeetingSetup): string[] {
    return setupPersonSeatRoles(setup);
  }

  /** How many real people the setup can seat: one per offered person seat. */
  function personSeatCapacity(setup: MeetingSetup): number {
    return personSeatRoles(setup).length;
  }

  /**
   * The roles for a view that keeps the live agenda: every role the live cast or agenda still names
   * stays, and a role the next draft defines takes precedence. A blank draft names no roles, so the
   * finished meeting's registry (including a role the owner added) must not be dropped from the
   * live view the owner is still looking at.
   */
  function rolesKeepingLive(live: Scenario['roles'], next: Scenario['roles']): Scenario['roles'] {
    const nextById = new Map(next.map((role) => [role.id, role]));
    const liveIds = new Set(live.map((role) => role.id));
    return [
      ...live.map((role) => nextById.get(role.id) ?? role),
      ...next.filter((role) => !liveIds.has(role.id)),
    ];
  }

  /** The scenario an owner-edited setup describes, with its AI seats treated as AI-only. */
  function scenarioFromSetup(setup: MeetingSetup): Scenario {
    return meetingScenarioFromSetup(fullScenario, setup);
  }

  /**
   * The scenario people see, plus the one admission resolves seats against. A returning seat holder
   * inside the grace of a running meeting is judged against its sealed setup. Every other arrival
   * starts the next meeting: an untouched draft stays open, an owner-edited one admits its person
   * seats, and a setup a Start consumed is already done with.
   */
  function seating(
    returning = false,
    roomEmpty?: boolean,
  ): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup; admissionCap?: number } {
    // A practice meeting always follows the demo pack; the owner's draft is not its plan.
    if (session.kind() === 'practice') {
      return { scenario: session.active(), admissionScenario: fullScenario };
    }
    const sealed = session.sealed();
    const active = session.active();
    const phase = session.phase();
    // The sealed setup governs only a running meeting this arrival joins: while people are still
    // there, or when the person coming back is one of its seat holders.
    const empty = roomEmpty ?? rejoin.isEmpty();
    const joiningSealed =
      sealed !== undefined && phase === 'running' && (returning || !empty);
    if (joiningSealed) {
      const joinSeats = personSeatRoles(sealed);
      return {
        scenario: { ...active, joinSeats },
        admissionScenario: { ...active, joinSeats },
        setup: sealed,
        admissionCap: personSeatCapacity(sealed),
      };
    }
    // A setup a Start consumed is discarded when that meeting resets; until then it must not narrow
    // the next arrival's seats. The next meeting follows the pack, not the sealed cast still live —
    // unless the owner has edited the draft since that seal, which is exactly the next meeting's setup.
    // A seal kept at boot from an already-ended meeting is history, not a live meeting's cast.
    const consumed = sealed !== undefined && phase !== 'lobby' && !session.draftEditedSinceSeal();
    const nextTouched = consumed ? false : session.draftTouched();
    if (!nextTouched) {
      return consumed
        ? { scenario: fullScenario, admissionScenario: fullScenario }
        : { scenario: active, admissionScenario: active };
    }
    const setup = session.draft();
    const joinSeats = personSeatRoles(setup);
    // The lobby must show exactly the meeting Start will seal, so build it with the same builder
    // admission uses. This keeps a pack-free draft's own organisation, people and story instead
    // of the demo pack's.
    const derived = scenarioFromSetup(setup);
    // A kept seal (an ended meeting) and a draft with no agenda yet still own the live view: its
    // cast, story and agenda stay while the next draft supplies the title, roles and seats
    // admission will use. Without an agenda the draft cannot stand alone.
    const scenario: Scenario =
      sealed !== undefined || setup.agenda.length === 0
        ? {
            ...active,
            meetingTitle: setup.title.trim() === '' ? active.meetingTitle : setup.title,
            roles: rolesKeepingLive(active.roles, derived.roles),
            agenda: active.agenda,
            joinSeats,
          }
        : {
            ...derived,
            // A blank draft has not named the meeting yet: keep the live title.
            ...(setup.title.trim() === '' ? { meetingTitle: active.meetingTitle } : {}),
          };
    return {
      scenario,
      admissionScenario: derived,
      setup,
      admissionCap: personSeatCapacity(setup),
    };
  }

  /**
   * The scenario the join form is shown right now: the sealed meeting once Start runs, the draft
   * setup in the lobby. Phone joins offer exactly these seats.
   */
  function visibleScenario(service = false): Scenario {
    const phase = session.phase();
    if (phase === 'starting') {
      return service ? session.candidate() ?? session.active() : session.active();
    }
    return phase === 'running' ? session.active() : seating().scenario;
  }

  /** What the public may see of the plan: the pack until the owner opens a room, then that snapshot. */
  function publicScenario(): Scenario {
    return lobbySnapshot ?? fullScenario;
  }

  /** The owner opened the room: freeze exactly the plan they opened as the public lobby view. */
  function captureLobbySnapshot(): void {
    lobbySnapshot = seating().scenario;
  }

  /**
   * The first person into an opened lobby picks the agenda for their seat, what the reset they
   * replaced used to shape. An owner-edited draft is never overwritten: the pick is for the
   * untouched pack plan only.
   */
  function shapeLobbyFor(seat: string): void {
    if (session.draftTouched()) return;
    session.shapeLobby(resetScenario({ seat, draftTouched: false }));
  }

  /** True when the sealed meeting carries no demo-pack content, so its facts must stay out of it. */
  function packFree(): boolean {
    const setup = session.sealed();
    return setup !== undefined && isPackFreeMeeting(setup, fullScenario);
  }

  /**
   * The setup an untouched draft seals: the meeting admission already shaped (its active agenda and
   * the admitted person's seat), not the full pack. The owner's pack title, roles and pace still apply.
   */
  function untouchedSetup(humanSeatOverride?: string): MeetingSetup {
    const agenda: MeetingSetup['agenda'] = session.active().agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: item.ownerRole,
    }));
    const humanSeat = humanSeatOverride ?? holderPersonSeat();
    if (humanSeat === undefined || (fullScenario.npcs ?? []).length === 0) {
      return { ...defaultSetup, agenda };
    }
    const npcByAttendee = new Map((fullScenario.npcs ?? []).map((npc) => [npc.attendee, npc]));
    const seats = defaultSetup.seats.map((seat) => {
      const attendee = fullScenario.attendees.find((candidate) => candidate.name === seat.displayName);
      if (attendee?.role === humanSeat) {
        return { displayName: seat.displayName, roleId: seat.roleId, kind: 'person' as const };
      }
      const npc = npcByAttendee.get(seat.displayName);
      return npc === undefined
        ? seat
        : { displayName: seat.displayName, roleId: seat.roleId, kind: 'ai' as const, npcProfileId: npc.attendee };
    });
    return { ...defaultSetup, agenda, seats };
  }

  /** Run the runner acknowledgement and commit, after the admission queue has released. */
  function runStart({
    attempt,
    meetingId,
    generation,
    activeAi,
    deadline,
  }: {
    attempt: string;
    meetingId: string;
    generation: number;
    activeAi: boolean;
    /** When this Start's one window closes; the runner must be ready and acknowledge by then. */
    deadline: number;
  }): Promise<StartOutcome> {
    /** Drop the candidate and leave the active scenario untouched; a reset has already replaced it. */
    const failed = (outcome: StartOutcome, reason: string): StartOutcome => {
      if (session.phase() === 'starting' && session.generation() === generation) {
        session.abortStart(reason);
      }
      persistence?.scheduleSave();
      return outcome;
    };
    const resetDuringStart = (): StartOutcome => ({
      status: 503,
      body: {
        error: 'The meeting was reset while it was starting. Press Start again for the new meeting.',
        retryable: true,
      },
    });
    const outcome = (async (): Promise<StartOutcome> => {
      const startedAt = new Date().toISOString();
      try {
        // A reset can land between beginStart and this continuation; never ask the runner for a dead meeting.
        if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
          return resetDuringStart();
        }
        if (activeAi) {
          const startRequest = {
            requestId: attempt,
            attempt,
            meetingId,
            startedAt,
            agendaIndex: 0,
            resumed: false,
          };
          // A practice meeting fails at once when its runner is absent; only a real meeting's owner
          // gets the wait for a runner that is still opening the room.
          const sent =
            runnerKind === 'real'
              ? await requestRunnerStart(startRequest, deadline)
              : hub.requestStart?.(startRequest) === true;
          if (!sent) {
            return failed(
              runnerKind === 'real'
                ? realRunnerNotReadyOutcome()
                : {
                    status: 503,
                    body: {
                      error:
                        'The AI attendees are not connected, so the meeting cannot open yet. Start the runner with npm run npc, then try again.',
                      retryable: true,
                    },
                  },
              'the AI runner is not connected',
            );
          }
          // The wait may have outlived the meeting (a reset or the Start window closing).
          if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
            return resetDuringStart();
          }
          try {
            await waitForRunner(attempt, meetingId, deadline);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // A reset cancels the waiter on purpose: say that, instead of blaming the runner.
            if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
              console.warn(`[start] meeting ${meetingId} was reset while it was starting: ${reason}`);
              return resetDuringStart();
            }
            console.warn(`[start] the AI attendees did not prepare the meeting: ${reason}`);
            return failed(
              runnerKind === 'real'
                ? realRunnerNotReadyOutcome()
                : {
                    status: 503,
                    body: {
                      error:
                        'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
                      retryable: true,
                    },
                  },
              reason,
            );
          }
        }
        // A reset during preparation must never let this old attempt start the replacement meeting.
        if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
          console.warn(`[start] refused to start meeting ${meetingId}: the meeting changed while it was starting`);
          return resetDuringStart();
        }
        // Persist that the meeting is open before it commits to running. An early Start must turn a
        // scheduled row open at once, so it can never be edited or cancelled as if it had not begun.
        if (runnerKind === 'real' && onStarted !== undefined) {
          try {
            await onStarted();
          } catch (error) {
            console.warn(`[start] meeting ${meetingId} could not be marked open: ${String(error)}`);
            return failed(
              {
                status: 409,
                body: {
                  error: 'This meeting was ended or cancelled while it was starting. Open it again from the list.',
                  retryable: false,
                },
              },
              'the meeting row is no longer open',
            );
          }
          if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
            return resetDuringStart();
          }
        }
        // Start commits here: the candidate becomes the active scenario and the draft becomes the seal.
        session.commitStart(startedAt);
        hub.publish(
          {
            type: 'MEETING_STARTED',
            audience: { kind: 'all' },
            payload: { meetingId, startedAt, agendaIndex: 0, resumed: false },
          },
          { retainKey: 'meeting:started' },
        );
        console.log(`[start] meeting ${meetingId} has started`);
        return { status: 200, body: { started: true, meetingId } };
      } catch (error) {
        console.error('[start] the meeting could not be started', error);
        if (meeting.id === meetingId && session.generation() === generation && session.phase() === 'starting') {
          session.abortStart('the meeting could not be started');
          persistence?.scheduleSave();
          return {
            status: 500,
            body: { error: 'The meeting could not be started. Try again.', retryable: true },
          };
        }
        throw error;
      }
    })();
    const pending: ActiveStart = { attempt, meetingId, promise: undefined! };
    pending.promise = outcome.finally(() => {
      if (starting === pending) starting = undefined;
    });
    starting = pending;
    return pending.promise;
  }

  /** A real meeting's owner sees plain words: the developer runner command belongs to practice only. */
  function realRunnerNotReadyOutcome(): StartOutcome {
    return {
      status: 503,
      body: {
        error: 'Kaki is still getting ready for this meeting. Try again in a few seconds.',
        retryable: true,
      },
    };
  }

  function startTimeoutOutcome(): StartOutcome {
    if (runnerKind === 'real') return realRunnerNotReadyOutcome();
    return {
      status: 503,
      body: {
        error: 'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
        retryable: true,
      },
    };
  }

  function startMeeting(practiceRequest = false): Promise<StartOutcome> {
    // The meeting this Start was requested for: a reset while it waits for the admission queue must
    // refuse it rather than let it start the replacement meeting.
    const requestedMeetingId = meeting.id;
    const requestedGeneration = session.generation();
    // The one Start timeout covers the queue wait as well as the runner acknowledgement. A Start
    // still waiting when it expires never runs later.
    const deadline = Date.now() + Math.max(1, startAckTimeoutMs);
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<StartOutcome>((resolve) => {
      timeout = setTimeout(() => {
        cancelled = true;
        if (
          meeting.id === requestedMeetingId &&
          session.generation() === requestedGeneration &&
          session.phase() === 'starting'
        ) {
          session.abortStart('the meeting did not start in time');
          persistence?.scheduleSave();
          cancelPendingStart('the meeting did not start in time');
        }
        resolve(startTimeoutOutcome());
      }, Math.max(1, startAckTimeoutMs));
      timeout.unref?.();
    });
    // The phase flip shares the admission queue with joins: a Start waits for an admission already in
    // flight, and an admission waits for beginStart. Only that atomic step is serialized; the runner
    // acknowledgement runs after the queue is released so joins are not held for its whole window.
    // The registry's lifecycle lock encloses the same step, so an edit or cancel cannot check the
    // row and then act across the moment the meeting becomes starting.
    const runAtomicStart = () =>
      admit(
      async (): Promise<StartOutcome | (() => Promise<StartOutcome>)> => {
        if (cancelled) return startTimeoutOutcome();
        // A practice Start is valid only for the exact practice meeting it was granted for. The
        // capability may have been revoked, or the owner may have opened a real meeting, while it
        // waited for the queue.
        if (
          practiceRequest &&
          (session.kind() !== 'practice' || session.practiceGeneration() !== requestedGeneration)
        ) {
          return {
            status: 403,
            body: { error: 'Practice access has ended with its practice meeting.' },
          };
        }
        if (meeting.id !== requestedMeetingId || session.generation() !== requestedGeneration) {
          return {
            status: 409,
            body: { error: 'The meeting was reset before it could start; press Start again.' },
          };
        }
        const phase = session.phase();
        if (phase === 'running') {
          return { status: 200, body: { started: true, alreadyStarted: true } };
        }
        if (phase === 'starting') {
          return {
            status: 409,
            body: { error: 'This meeting is already starting; give it a moment.', retryable: true },
          };
        }
        if (phase === 'ended') {
          return {
            status: 409,
            body: { error: 'This meeting has ended; press New meeting to start the next one.' },
          };
        }
        let candidate: Scenario;
        let sealed: MeetingSetup;
        if (runnerKind === 'real') {
          // Start needs someone in the meeting: an owner cannot open an empty room.
          if (session.holders().length === 0) {
            return { status: 409, body: { error: 'Join the meeting before pressing Start.' } };
          }
          // A real product meeting has no pack to prepare: its people are its seats, and its own
          // title and agenda are the plan. Its draft already carries the owners and pace the owner
          // chose when creating the meeting, so it is always the configured setup, edited or not.
          const holders = session.holders();
          const configured = session.draft();
          candidate = realMeetingScenario(fullScenario, holders, configured);
          sealed = realMeetingSetup(fullScenario, holders, configured);
        } else {
          // Re-validate the whole draft before anything is applied or the runner is asked, so a bad edit
          // made outside the setup screen fails Start loudly and leaves the meeting untouched. A
          // practice meeting never reads the owner's draft: it always runs the demo pack.
          const parsed = parseMeetingSetup(session.draft(), {
            npcProfileIds: demoPackNpcProfileIds(fullScenario),
          });
          if (!parsed.ok) {
            return {
              status: 422,
              body: {
                error: 'The meeting setup is not valid, so the meeting was not started. Fix the setup and try again.',
                errors: parsed.errors,
              },
            };
          }
          // Start needs someone in the meeting: an owner cannot open an empty room.
          if (session.holders().length === 0) {
            return { status: 409, body: { error: 'Join the meeting before pressing Start.' } };
          }
          // An untouched draft follows the live meeting; an owner-edited one is applied exactly as written.
          const touchedSeal = session.draftTouched() ? parsed.value : undefined;
          sealed =
            touchedSeal ??
            untouchedSetup(
              session.kind() === 'practice' ? session.holders()[0]?.seat : undefined,
            );
          // Everyone already seated must have a person seat in the setup about to become the meeting.
          const personRoles = new Set(personSeatRoles(sealed));
          const stranded = session.holders().find((holder) => !personRoles.has(holder.seat));
          if (stranded !== undefined) {
            const role = sealed.roles.find((candidate) => candidate.id === stranded.seat);
            const packRole = fullScenario.roles.find((candidate) => candidate.id === stranded.seat);
            // The room is empty and the grace is over: that seat holder has left for good, so say what
            // really happened instead of naming them as if they were still in the meeting.
            const left = rejoin.isEmpty() && !rejoin.wouldHold();
            if (left) {
              return {
                status: 409,
                body: {
                  error: `${stranded.name} has left the meeting, so their seat is not in this setup. Ask them to rejoin, or reset the meeting.`,
                },
              };
            }
            return {
              status: 409,
              body: {
                error: `This meeting's setup has no place for ${role?.label ?? packRole?.label ?? stranded.seat}; the owner set the seats.`,
              },
            };
          }
          // A setup that passes field validation can still describe a meeting the scenario rules refuse.
          const derived = deriveMeetingScenario(fullScenario, sealed);
          if (!derived.ok) {
            return {
              status: 422,
              body: {
                error: 'This setup describes a meeting that cannot run, so the meeting was not started. Fix the setup and try again.',
                errors: derived.errors,
              },
            };
          }
          // Seal the meeting as a new value; the live scenario keeps serving everyone until this commits.
          candidate = derived.scenario;
        }
        const activeAi = (candidate.npcs ?? []).length > 0;
        // Server-side recognition is the runner's job, so even a meeting with no AI cast needs it
        // to hear anyone at all. Without it, refuse loudly instead of opening a silent meeting.
        if (!activeAi && speechRecognition === 'server' && !servicePresence().serverSpeech) {
          return {
            status: 503,
            body: {
              error:
                "Speech recording isn't ready, the AI service is not connected. Start it with npm run npc, then try again.",
              retryable: true,
            },
          };
        }
        const attempt = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const meetingId = requestedMeetingId;
        const generation = requestedGeneration;
        session.beginStart(candidate, sealed);
        return () => runStart({ attempt, meetingId, generation, activeAi, deadline });
      },
    );
    const atomicStart =
      serializeLifecycle === undefined ? runAtomicStart() : serializeLifecycle(runAtomicStart);
    const queued = atomicStart.then((result) =>
      typeof result === 'function' ? result() : result,
    );
    return Promise.race([queued, timedOut]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
  }
  if (persistence !== undefined) {
    hub.subscribe((event) => {
      if (
        event.type === 'TRANSCRIPT_CHUNK' ||
        event.type === 'MEETING_STARTED' ||
        event.type === 'MEETING_RECORD_UPDATED' ||
        event.type === 'HOST_SPEECH_TRIGGERED' ||
        event.type === 'TASK_UPDATED'
      ) {
        persistence.scheduleSave();
      }
    });
    if (persistence.saved !== undefined) {
      try {
        tasks.restore(persistence.saved.state.tasks);
        // A publish Kaki was running when it stopped is now FAILED on the card. Keep the same
        // plain "try again" state with the meeting row, so history never sticks on "publishing".
        if (
          tasks
            .list()
            .some((task) => task.purpose === 'meeting_minutes' && task.interrupted === true)
        ) {
          await keepMinutesPublish({
            status: 'failed',
            error: 'Publishing was interrupted; try again.',
          });
        }
        // Restored tasks do not fire a change: an ended meeting whose minutes were already
        // published before the restart is not under review any more.
        if (
          tasks
            .list()
            .some(
              (task) =>
                task.purpose === 'meeting_minutes' &&
                (task.status === 'COMPLETED' ||
                  task.status === 'SYNCED' ||
                  task.status === 'DISMISSED' ||
                  task.status === 'SUPERSEDED'),
            )
        ) {
          session.finishReview();
        }
      } catch (error) {
        closeRejoin();
        hub.close();
        throw error;
      }
    }

  }

  /** Everything a route handler may use for this one meeting. */
  function requestContext(): RequestContext {
    return {
      hub,
      tasks,
      memory,
      fullScenario,
      workspaceId,
      ...(pickedAgenda === undefined ? {} : { pickedAgenda }),
      devRoutes,
      ...(auth === undefined ? {} : { auth }),
      authMeetingId: id,
      ...(serviceToken === undefined ? {} : { serviceToken }),
      routes,
      idle,
      ...(calendar === undefined ? {} : { calendar }),
      ...(calendarFetch === undefined ? {} : { calendarFetch }),
      actionTools,
      roomRoster,
      meetingCode,
      meetingCodeAttempts,
      rejoin,
      meeting,
      session,
      startMeeting,
      reservations,
      admit,
      watchRoom,
      roomName,
      roomNameFor,
      practicePrincipal,
      ...(meetingElapsedSeconds === undefined ? {} : { meetingElapsedSeconds }),
      ...(meetingAgendaIndex === undefined ? {} : { meetingAgendaIndex }),
      ...(meetingPaused === undefined ? {} : { meetingPaused }),
      runnerStateChanged: () => publishRunnerState(),
      meetingStateChanged: () => publishMeetingState(),
      meetingKind: () => session.kind(),
      realMeeting: kind === 'real',
      perVisitorPractice,
      refreshRealPeople,
      quietCue: (text: string) => {
        meetingCue = { text, at: new Date().toISOString() };
        publishMeetingState();
      },
      isOffTheRecord: () => session.offTheRecordSince() !== undefined,
      seating,
      visibleScenario,
      publicScenario,
      captureLobbySnapshot,
      shapeLobbyFor,
      setupLocked,
      scheduleSave: () => persistence?.scheduleSave(),
      writeHumanLine: (input) => writeHumanLine(input),
      onActivity: touch,
    };
  }

  const cleanups: Array<() => void> = [];
  for (const feature of modules) {
    try {
      const stop = feature.start({
        hub,
        tasks,
        activeScenario: () => session.active(),
        memory,
        draftOnly,
        ...(persistence === undefined ? {} : { persistence }),
        meetingId: () => meeting.id,
        workspaceId: () => workspaceId,
        ...(tools === undefined ? {} : { tools }),
        resetMeeting: (options) => admit(async () => session.reset(options)),
        serializeChange: (task) => admit(async () => task()),
        onReset: session.onReset,
        session,
        meetingKind: () => (session.kind() === 'practice' ? 'practice' : runnerKind === 'real' ? 'real' : undefined),
        quietCue: (text: string) => {
          meetingCue = { text, at: new Date().toISOString() };
          publishMeetingState();
        },
        notesPaused: (text: string | null) => {
          if (notetakerNotesPaused === text) return;
          notetakerNotesPaused = text;
          publishMeetingState();
        },
        packFree,
        meetingDetails: () => session.snapshot(),
        seatIsGuest: (role) => seatGuests.get(role),
        presentRoles: () => presentSeats,
        ...(onMinutes === undefined
          ? {}
          : {
              archiveMinutes: async (input) => {
                await onMinutes({
                  minutes: input.minutes,
                  todos: input.todos.map((todo) => ({ ...todo, done: false })),
                });
              },
            }),
      });
      if (typeof stop === 'function') cleanups.push(stop);
    } catch (error) {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (cleanupError) {
          console.error('kaki server: a module failed to stop after startup failed', cleanupError);
        }
      }
      closeRejoin();
      stopRunnerPresence?.();
      stopSessionEnded?.();
      hub.close();
      await persistence
        ?.flush()
        .catch((flushError: unknown) =>
          console.error('kaki server: saving the meeting after startup failed did not finish', flushError),
        );
      throw new Error(
        `kaki server: module "${feature.name}" failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  // The module has registered how to read its state; save once so an interrupted task already shows FAILED.
  persistence?.scheduleSave();

  // A restored meeting is already started: keep the start event available to late clients and the NPC,
  // carrying the saved agenda item so a fresh runner resumes it instead of reopening item zero.
  const savedStartAt = session.startedAt();
  if (session.phase() === 'running' && savedStartAt !== undefined) {
    hub.publish(
      {
        type: 'MEETING_STARTED',
        audience: { kind: 'all' },
        payload: {
          meetingId: meeting.id,
          startedAt: savedStartAt,
          agendaIndex: restoredAgendaIndex,
          resumed: true,
        },
      },
      { retainKey: 'meeting:started' },
    );
  }
  // Keep the runner snapshot and the participants' state available to anyone who connects late.
  publishRunnerState();
  publishMeetingState();

  let disposed = false;
  const instance: MeetingInstance = {
    id,
    workspaceId,
    ownerUserId,
    runnerKind,
    perVisitorPractice,
    session,
    hub,
    tasks,
    memory,
    modules,
    get roomName() {
      return roomName();
    },
    ...(persistence === undefined ? {} : { persistence }),
    handle(request, response, rest) {
      // The prefixed dev routes live under the meeting's own prefix but keep their `/dev/...`
      // path, so a local tool names exactly the meeting it is poking.
      const canonical = rest.startsWith('/')
        ? rest
        : rest.startsWith('dev/')
          ? `/${rest}`
          : `/api/${rest}`;
      return handleRoutedRequest(request, response, requestContext(), canonical);
    },
    handleUpgrade(request, socket, head) {
      hub.handleUpgrade(request, socket, head);
    },
    lastActivityAt: () => lastActivity,
    connectedPeople: () => people,
    meetingCode: () => meetingCode.value,
    rebaseScheduledPlan(row) {
      // Only an unstarted lobby can take a new plan; a starting or running room keeps the one it has.
      if (runnerKind !== 'real' || session.phase() !== 'lobby') return;
      const base = realBaseScenario(row);
      const basePlan = defaultMeetingSetup(base);
      const plan =
        row.pace === null || row.pace === undefined
          ? basePlan
          : { ...basePlan, pace: { ...row.pace } };
      // Mark it as the owner's edit, so the saved snapshot never keeps a stale shaped lobbyAgenda,
      // and show the new plan to anyone still in the old lobby until it is unloaded.
      session.setDraft(plan);
      session.refreshRealScenario(realScenarioWithPeople(base, session.holders()));
      // Queue the rebased snapshot now; the registry unloads this lobby straight after, and that
      // close flushes the queue. Without it the old saved plan would be the one still on record.
      persistence?.scheduleSave();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          console.error('kaki server: a module failed to stop', error);
        }
      }
      closeRejoin();
      stopRunnerPresence?.();
      stopSessionEnded?.();
      hub.close();
      await persistence
        ?.flush()
        .catch((error: unknown) => console.error('kaki server: saving the meeting did not finish', error));
    },
  };
  return instance;
}
