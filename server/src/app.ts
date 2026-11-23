import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { type MeetingMemoryEntry, type Scenario } from '@kaki/shared';
import {
  assertSafeBind,
  assertSafeMattermost,
  bearerToken,
  isCrossSiteRequest,
  isLoopbackAddress,
  matchRoute,
  tokenMatches,
  type Route,
} from './http/access';
import { sendJson } from './http/http';
import type { CalendarSettings } from './action/calendar';
import type { ActionToolOptions } from './action/tools';
import type { Auth } from './auth/module';
import { createAttemptLimiter } from './http/attemptLimiter';
import type { Hub } from './core/hub';
import { createIdleTracker, type IdleTracker } from './core/idle';
import type { KakiModule } from './core/modules';
import type { MeetingPersistence } from './persist/persistence';
import {
  createMeetingCodeSource,
  MEETING_CODE_FAILURE_LIMIT,
  MEETING_CODE_WINDOW_MS,
  type MeetingCodeSource,
} from './meeting/meetingCode';
import type { MeetingPauseControl } from './host';
import type { MeetingSession } from './meeting/session';
import type { TaskStore } from './meeting/tasks';
import { ADMISSION_RESERVATION_MS, livekitRoster, type RoomRoster } from './services/livekit';
import { buildMeetingRouteTable } from './http/meetingRoutes';
import { handleRoutedRequest } from './http/dispatch';
import type { RequestContext, RoutedRoute } from './http/routeCall';
import { handleAuthRoutes } from './http/routes/auth';
import { handlePractice } from './http/routes/practice';
import { handleIdle } from './http/routes/idle';
import { handleHealth } from './http/routes/meeting';
import { handleAgendaFromCalendar, handleTellKaki } from './http/routes/agenda';
import { handleCreateMeeting, handleMeetingByCode, handleMeetingInfo, handleMeetingJoin } from './http/routes/meetings';
import { handleWorkspaces } from './http/routes/workspaces';
import { createMeetingInstance, type MeetingInstance } from './meeting/instance';
import {
  LEGACY_MEETING_ID,
  MeetingBusyError,
  createMeetingRegistry,
  createMemoryMeetingStore,
  type MeetingRegistry,
  type MeetingStore,
  type OpenMeeting,
} from './meeting/registry';
import type { MeetingRow } from './meeting/types';
import { SAMPLE_WORKSPACE_ID } from './workspace/constants';
import {
  createMemoryWorkspaceToolStore,
  createWorkspaceToolSource,
  WORKSPACE_TOOL_KINDS,
  type WorkspaceToolKind,
  type WorkspaceToolStore,
  type WorkspaceTools,
} from './workspace/tools';
import { createMeetingModules, createPracticeModules, type MeetingModules } from './modules';
import { llmFromEnv, type LlmClient } from './services/llm';
import { createWorkspaceIndexScheduler } from './meeting/indexScheduler';
import { indexSampleKnowledge, indexWorkspaceSource } from './wingman/knowledge/indexer';

/** Options for creating the Kaki server; port 0 picks a free port for tests. */
export interface CreateAppOptions {
  port?: number;
  /**
   * The bind address, 127.0.0.1 by default (the production entry point always passes one). A
   * loopback default keeps a test server's port its own: on macOS a wildcard bind can share its
   * port with another program's 127.0.0.1 listener, which then answers the test's requests.
   * An open (sign-in off) non-loopback bind needs KAKI_ALLOW_OPEN=1.
   */
  host?: string;
  scenario: Scenario;
  /** The legacy instance's modules; fresh modules for other meetings come from `meetingModules`. */
  modules?: KakiModule[];
  devRoutes?: boolean;
  /** Optional sign-in, sessions and WebSocket gating; absent means auth is off. */
  auth?: Auth;
  /** The mock calendar server; when set, `/api/calendar/:id` shows an event a person can read. */
  calendar?: CalendarSettings;
  /** How the setup import reads the calendar; tests inject a fake, elsewhere global fetch is used. */
  calendarFetch?: typeof fetch;
  actionTools?: ActionToolOptions;
  /** The workspace tool table; absent uses an in-memory store (tests, and a database-less server). */
  workspaceTools?: WorkspaceToolStore;
  /**
   * Index one just-connected tool for its workspace; defaults to the real indexer. Tests inject a
   * fake so connecting a tool never calls the embedding gateway.
   */
  indexWorkspaceTool?: (input: {
    workspaceId: string;
    kind: WorkspaceToolKind;
    tools: WorkspaceTools;
  }) => Promise<void>;
  /** How often an open workspace is reindexed; defaults to 30 minutes. Tests set it low. */
  workspaceIndexIntervalMs?: number;
  /** Who is in a LiveKit room, to refuse a join when the meeting is full; defaults to asking LiveKit. */
  roomRoster?: RoomRoster;
  /** When true, modules may draft and review actions but must never send them to external services. */
  draftOnly?: boolean;
  /** Seconds since the legacy meeting started, for stamping settled cards with their source time; omit when unknown. */
  meetingElapsedSeconds?: () => number | undefined;
  /** The live agenda item, for a reconnecting runner; omit when unknown. */
  meetingAgendaIndex?: () => number | undefined;
  /** Whether the server-owned agenda clock is paused, for the runner snapshot. */
  meetingPaused?: () => boolean | undefined;
  /**
   * The server's pause control. When present, the app pauses a running meeting for an empty room
   * and resumes it when someone returns; a person's explicit Stop stays paused.
   */
  meetingPause?: MeetingPauseControl;
  /** Keeps the legacy meeting, notetaker and tasks across a restart; absent means memory only. */
  persistence?: MeetingPersistence;
  /** The saved state of any other meeting, loaded when that meeting first opens. */
  persistenceFor?: (id: string) => Promise<MeetingPersistence | undefined>;
  /** Finds the meeting whose saved state holds a code; absent means only loaded meetings can be found by code. */
  findSavedIdByCode?: (code: string) => Promise<string | undefined>;
  /** The meetings table; absent uses an in-memory store (tests, and a database-less server). */
  meetings?: MeetingStore;
  /** The model server-wide helpers use; defaults to the one built from the environment. */
  llm?: LlmClient;
  /** Fresh modules for a new meeting's instance; defaults to this pack's Host, Wingman and Action modules. */
  meetingModules?: (meeting: MeetingRow) => MeetingModules;
  /** Fresh modules for one practice instance; every practice must get its own clock and modules. */
  practiceModules?: () => Partial<MeetingModules> & { modules: MeetingModules['modules'] };
  /** How many meetings may be open at once; defaults to KAKI_MAX_OPEN_MEETINGS or 10. */
  maxOpenMeetings?: number;
  /** How many practice meetings may be open at once; defaults to KAKI_MAX_PRACTICE or 5. */
  maxPracticeMeetings?: number;
  /** How many real meetings one owner may keep open at once; defaults to KAKI_MAX_OPEN_MEETINGS_PER_USER or 2. */
  maxOpenMeetingsPerUser?: number;
  /** How many meetings one owner may create per day; defaults to KAKI_MAX_MEETINGS_PER_DAY or 20. */
  maxMeetingsPerDay?: number;
  /** How many paid model or calendar requests, or practice opens, one user or address may make a minute; defaults to 10. */
  llmRequestsPerMinute?: number;
  /** How long a meeting with nobody connected stays loaded; defaults to KAKI_MEETING_UNLOAD_MS or 30 min. */
  meetingUnloadMs?: number;
  /** How long an empty practice meeting stays loaded; defaults to KAKI_PRACTICE_UNLOAD_MS or 5 min. */
  practiceUnloadMs?: number;
  /** How often the registry looks for idle meetings; defaults to 60 s. */
  meetingSweepMs?: number;
  /** How long an empty meeting is kept for the same person to return; defaults to KAKI_REJOIN_GRACE_MS or 2 minutes. */
  rejoinGraceMs?: number;
  /** How often the app server checks who is in the room; defaults to 5 seconds. */
  rejoinPollMs?: number;
  /**
   * How long the room must read empty before a running meeting auto-pauses; defaults to
   * EMPTY_ROOM_PAUSE_MS. Tests set it low so a blip can be told from a real departure quickly.
   */
  emptyRoomPauseMs?: number;
  /** How long a seat stays reserved after a token is issued; defaults to 15 seconds. */
  admissionReservationMs?: number;
  /** How long Start waits for the AI runner to open the meeting; defaults to 6 seconds. */
  startAckTimeoutMs?: number;
  /** Shared secret the AI runner uses for its service channels; defaults to KAKI_SERVICE_TOKEN. */
  serviceToken?: string;
  /** The one code shared with phone sign-in; omitted creates one that rotates with the meeting. */
  meetingCode?: MeetingCodeSource;
  /**
   * Who hears a person's speech: the runner's server-side recogniser (the default) or the browser's.
   * A server-side meeting needs a connected runner even when every seat is a person.
   */
  speechRecognition?: 'server' | 'browser';
  /** The clock behind idle timing; tests inject one so it can move without waiting. */
  idleClock?: () => number;
}

/** A listening Kaki server and the one registry that owns every meeting it serves. */
export interface KakiApp {
  server: Server;
  /** The legacy practice instance's hub, kept for existing clients and tests. */
  hub: Hub;
  tasks: TaskStore;
  session: MeetingSession;
  memory: readonly MeetingMemoryEntry[];
  /** Every route this server serves, each with its mandatory access level. */
  routes: readonly Route[];
  /** The server's view of who is connected and when a person was last active. */
  idle: IdleTracker;
  /** Create, load and unload meetings; the dev/test door for new meetings in step 2. */
  registry: MeetingRegistry;
  close(): Promise<void>;
}

/** Every route the server answers without a meeting prefix. */
function buildServerRouteTable({ auth }: { auth: Auth | undefined }): RoutedRoute[] {
  const routes: RoutedRoute[] = [
    { method: 'GET', path: '/health', access: 'public', handle: handleHealth },
    // Deliberately outside the proxied prefixes: only the VM's own idle checker may read it.
    { method: 'GET', path: '/idle', access: 'loopback', handle: handleIdle },
    // One practice meeting per visitor; no sign-in, identified by its own cookie.
    { method: 'POST', path: '/api/practice', access: 'public', handle: handlePractice },
  ];
  if (auth === undefined) {
    routes.push({ method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes });
    return routes;
  }
  routes.push(
    { method: 'POST', path: '/api/auth/login', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/auth/logout', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/auth/google/start', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/auth/google/callback', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/join', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/workspaces', access: 'user', handle: handleWorkspaces },
    { method: 'POST', path: '/api/workspaces', access: 'user', handle: handleWorkspaces },
    { method: 'GET', path: '/api/workspaces/:id', access: 'user', handle: handleWorkspaces },
    { method: 'PATCH', path: '/api/workspaces/:id', access: 'user', handle: handleWorkspaces },
    { method: 'GET', path: '/api/workspaces/:id/meetings', access: 'user', handle: handleWorkspaces },
    { method: 'GET', path: '/api/workspaces/:id/meetings/:meetingId/minutes', access: 'user', handle: handleWorkspaces },
    { method: 'POST', path: '/api/workspaces/:id/meetings/:meetingId/todos/:taskId', access: 'user', handle: handleWorkspaces },
    { method: 'GET', path: '/api/workspaces/:id/tools', access: 'user', handle: handleWorkspaces },
    { method: 'POST', path: '/api/workspaces/:id/tools/:kind/test', access: 'user', handle: handleWorkspaces },
    { method: 'PUT', path: '/api/workspaces/:id/tools/:kind', access: 'user', handle: handleWorkspaces },
    { method: 'DELETE', path: '/api/workspaces/:id/tools/:kind', access: 'user', handle: handleWorkspaces },
    { method: 'POST', path: '/api/meetings', access: 'user', handle: handleCreateMeeting },
    { method: 'POST', path: '/api/tell-kaki', access: 'user', handle: handleTellKaki },
    { method: 'POST', path: '/api/agenda/from-calendar', access: 'user', handle: handleAgendaFromCalendar },
    { method: 'GET', path: '/api/meetings/by-code/:code', access: 'public', handle: handleMeetingByCode },
    { method: 'GET', path: '/api/meetings/:id/info', access: 'public', handle: handleMeetingInfo },
    { method: 'POST', path: '/api/meetings/:id/join', access: 'public', handle: handleMeetingJoin },
  );
  return routes;
}

/** The connected tool kinds that hold searchable records; the calendar has none. */
function connectedIndexKinds(tools: WorkspaceTools): WorkspaceToolKind[] {
  return WORKSPACE_TOOL_KINDS.filter((kind) => {
    switch (kind) {
      case 'mattermost':
        return tools.mattermost !== undefined;
      case 'gitea':
        return tools.gitea !== undefined;
      case 'wiki':
        return tools.wiki !== undefined;
      case 'email':
        return tools.email !== undefined;
      case 'calendar':
        return false;
    }
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    const ready = () => {
      server.off('error', onError);
      resolve();
    };
    server.listen(port, host, ready);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Answer an upgrade we refuse, before any WebSocket exists. */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The one runner control channel: `/ws?audience=service-control` (the service token). It tells a
 * runner which meetings are open, and sends MEETING_OPENED / MEETING_CLOSED as they load and unload.
 */
function createRunnerControl({
  serviceToken,
  authOn,
  openMeetings,
}: {
  serviceToken?: string;
  authOn: boolean;
  openMeetings: () => readonly OpenMeeting[];
}) {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const presenceHandlers = new Set<(connected: boolean) => void>();
  let wasConnected = false;
  function notifyPresence(): void {
    const connected = sockets.size > 0;
    if (connected === wasConnected) return;
    wasConnected = connected;
    for (const handler of presenceHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error('kaki meetings: a runner-presence handler failed', error);
      }
    }
  }
  wss.on('connection', (socket) => {
    sockets.add(socket);
    notifyPresence();
    // A (re)connecting runner gets every open meeting as its list.
    for (const meeting of openMeetings()) {
      socket.send(JSON.stringify({ type: 'MEETING_OPENED', ...meeting }));
    }
    const forget = (): void => {
      sockets.delete(socket);
      notifyPresence();
    };
    socket.on('close', forget);
    socket.on('error', (error) => {
      console.error('kaki meetings: runner control socket error', error);
      forget();
    });
  });
  function send(message: object): void {
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }
  return {
    allowed(request: IncomingMessage): boolean {
      if (serviceToken !== undefined && serviceToken !== '') {
        return tokenMatches(bearerToken(request), serviceToken);
      }
      return !authOn && isLoopbackAddress(request.socket.remoteAddress);
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (!this.allowed(request)) {
        refuseUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit('connection', websocket, request);
      });
    },
    opened(meeting: OpenMeeting): void {
      send({ type: 'MEETING_OPENED', ...meeting });
    },
    closed(meetingId: string): void {
      send({ type: 'MEETING_CLOSED', meetingId });
    },
    close(): void {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      notifyPresence();
      wss.close();
    },
    presence: {
      connected: () => sockets.size > 0,
      subscribe(handler: (connected: boolean) => void): () => void {
        presenceHandlers.add(handler);
        return () => {
          presenceHandlers.delete(handler);
        };
      },
    },
  };
}

/**
 * Create the HTTP server and the registry, then open the legacy instance. The legacy instance keeps
 * every unprefixed path and its WebSocket; other meetings live under `/api/meetings/:id` and
 * `/ws?meeting=:id`.
 */
export async function createApp({
  port = 0,
  host = '127.0.0.1',
  scenario,
  modules = [],
  devRoutes = false,
  auth,
  calendar,
  calendarFetch,
  actionTools = {},
  workspaceTools: workspaceToolsOption,
  indexWorkspaceTool: indexWorkspaceToolOption,
  workspaceIndexIntervalMs,
  roomRoster = livekitRoster(),
  draftOnly = false,
  meetingElapsedSeconds,
  meetingAgendaIndex,
  meetingPaused,
  meetingPause,
  persistence,
  persistenceFor,
  findSavedIdByCode,
  meetings = createMemoryMeetingStore(),
  llm: llmOption,
  meetingModules,
  practiceModules,
  maxOpenMeetings,
  maxPracticeMeetings,
  maxOpenMeetingsPerUser,
  maxMeetingsPerDay,
  llmRequestsPerMinute = 10,
  meetingUnloadMs,
  practiceUnloadMs,
  meetingSweepMs,
  rejoinGraceMs,
  rejoinPollMs,
  emptyRoomPauseMs,
  admissionReservationMs = ADMISSION_RESERVATION_MS,
  // A real meeting's runner needs a few seconds to open the room, longer when several open at once.
  startAckTimeoutMs = 20_000,
  serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim(),
  meetingCode: meetingCodeOption,
  speechRecognition = 'server',
  idleClock,
}: CreateAppOptions): Promise<KakiApp> {
  assertSafeBind(host, auth !== undefined);
  assertSafeMattermost(auth !== undefined);
  if (devRoutes && auth !== undefined) {
    throw new Error(
      'kaki server: KAKI_DEV_ROUTES=1 cannot be combined with KAKI_AUTH=1; the dev routes are a local-only tool. Unset one of them.',
    );
  }
  const idle = createIdleTracker(idleClock);
  const llm = llmOption ?? llmFromEnv();
  const workspaceTools = workspaceToolsOption ?? createMemoryWorkspaceToolStore();
  const toolSource = createWorkspaceToolSource(workspaceTools, actionTools.env);
  const requirePostgresUrl = (): string => {
    const url = process.env.POSTGRES_URL?.trim();
    if (url === undefined || url === '') {
      throw new Error('POSTGRES_URL is not set, so workspace knowledge cannot be indexed');
    }
    return url;
  };
  const indexWorkspaceTool =
    indexWorkspaceToolOption ??
    (async ({ workspaceId, kind, tools }: { workspaceId: string; kind: WorkspaceToolKind; tools: WorkspaceTools }) => {
      await indexWorkspaceSource({ workspaceId, kind, tools, postgresUrl: requirePostgresUrl() });
    });
  // The sample is connectionless: refresh its seeded records while its legacy meeting is open.
  const workspaceIndexScheduler = createWorkspaceIndexScheduler({
    intervalMs: workspaceIndexIntervalMs ?? 30 * 60_000,
    async index(workspaceId) {
      if (workspaceId === SAMPLE_WORKSPACE_ID) {
        await indexSampleKnowledge();
        return;
      }
      const tools = await toolSource.toolsFor(workspaceId);
      for (const kind of connectedIndexKinds(tools)) {
        try {
          await indexWorkspaceSource({ workspaceId, kind, tools, postgresUrl: requirePostgresUrl() });
        } catch (error) {
          console.error(
            `kaki indexer: scheduled reindex of ${kind} for workspace ${workspaceId} failed`,
            error,
          );
        }
      }
    },
  });
  workspaceIndexScheduler.opened(SAMPLE_WORKSPACE_ID);
  const serverRoutes = buildServerRouteTable({ auth });
  const legacyRoutes = buildMeetingRouteTable({ devRoutes });
  // Every prefixed meeting answers the same dev routes under its own id when the app has them on.
  const newMeetingRoutes = buildMeetingRouteTable({ devRoutes });
  const meetingCode = meetingCodeOption ?? createMeetingCodeSource();
  const meetingCodeAttempts =
    auth?.meetingCodeLimiter ??
    createAttemptLimiter({
      limit: MEETING_CODE_FAILURE_LIMIT,
      windowMs: MEETING_CODE_WINDOW_MS,
    });
  const guestJoinAttempts = createAttemptLimiter({ limit: 20, windowMs: 60_000 });
  // Paid work: one bucket per endpoint, keyed by both the account and the address that asked.
  const llmRequestLimit = Number.isFinite(llmRequestsPerMinute) && llmRequestsPerMinute > 0 ? llmRequestsPerMinute : 10;
  const tellKakiAttempts = createAttemptLimiter({ limit: llmRequestLimit, windowMs: 60_000 });
  const agendaFromCalendarAttempts = createAttemptLimiter({ limit: llmRequestLimit, windowMs: 60_000 });
  // One bucket per address: a loop that clears its cookie and asks again cannot keep every
  // practice room occupied and lock real visitors out.
  const practiceAttempts = createAttemptLimiter({ limit: llmRequestLimit, windowMs: 60_000 });

  if (auth !== undefined) {
    auth.bindMeetingHost(async (meetingId, userId) => {
      const row = await meetings.get(meetingId);
      if (row === undefined) return false;
      if (row.ownerUserId === userId) return true;
      const role = await auth.store.getMembership({ workspaceId: row.workspaceId, userId });
      return role === 'admin';
    });
  }

  // The control channel exists before any instance, so each meeting can say loudly when its
  // runner is away. Its listener reads the registry lazily, after the registry is built.
  const runnerControl = createRunnerControl({
    serviceToken,
    authOn: auth !== undefined,
    openMeetings: () => registry.openMeetings(),
  });

  const legacy = await createMeetingInstance({
    id: LEGACY_MEETING_ID,
    workspaceId: SAMPLE_WORKSPACE_ID,
    paths: 'legacy',
    kind: 'practice',
    scenario,
    modules,
    tools: () => toolSource.toolsFor(SAMPLE_WORKSPACE_ID),
    routes: legacyRoutes,
    devRoutes,
    ...(persistence === undefined ? {} : { persistence }),
    ...(auth === undefined ? {} : { auth }),
    ...(serviceToken === undefined ? {} : { serviceToken }),
    ...(calendar === undefined ? {} : { calendar }),
    ...(calendarFetch === undefined ? {} : { calendarFetch }),
    actionTools,
    roomRoster,
    draftOnly,
    meetingCode,
    meetingCodeAttempts,
    ...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
    ...(rejoinPollMs === undefined ? {} : { rejoinPollMs }),
    ...(emptyRoomPauseMs === undefined ? {} : { emptyRoomPauseMs }),
    admissionReservationMs,
    startAckTimeoutMs,
    ...(meetingElapsedSeconds === undefined ? {} : { meetingElapsedSeconds }),
    ...(meetingAgendaIndex === undefined ? {} : { meetingAgendaIndex }),
    ...(meetingPaused === undefined ? {} : { meetingPaused }),
    ...(meetingPause === undefined ? {} : { meetingPause }),
    speechRecognition,
    idle,
    runnerPresence: runnerControl.presence,
  });

  async function buildRowInstance(
    row: MeetingRow,
    rowPersistence: MeetingPersistence | undefined,
  ): Promise<MeetingInstance> {
    const built = meetingModules === undefined ? createMeetingModules(row, scenario, toolSource) : meetingModules(row);
    const owner =
      auth !== undefined && row.ownerUserId !== null
        ? await auth.store.findUserById(row.ownerUserId).catch(() => undefined)
        : undefined;
    return createMeetingInstance({
      id: row.id,
      workspaceId: row.workspaceId,
      paths: 'prefixed',
      kind: 'real',
      scenario,
      meetingRow: row,
      modules: built.modules,
      tools: built.tools ?? (() => toolSource.toolsFor(row.workspaceId)),
      routes: newMeetingRoutes,
      devRoutes,
      ...(rowPersistence === undefined ? {} : { persistence: rowPersistence }),
      ...(auth === undefined ? {} : { auth }),
      ...(serviceToken === undefined ? {} : { serviceToken }),
      ...(calendar === undefined ? {} : { calendar }),
      ...(calendarFetch === undefined ? {} : { calendarFetch }),
      actionTools,
      roomRoster,
      draftOnly,
      // Every real meeting gets its own random code; only the practice meeting honours a pinned one.
      meetingCode: createMeetingCodeSource(''),
      meetingCodeAttempts: createAttemptLimiter({
        limit: MEETING_CODE_FAILURE_LIMIT,
        windowMs: MEETING_CODE_WINDOW_MS,
      }),
      ...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
      ...(rejoinPollMs === undefined ? {} : { rejoinPollMs }),
      ...(emptyRoomPauseMs === undefined ? {} : { emptyRoomPauseMs }),
      admissionReservationMs,
      startAckTimeoutMs,
      meetingElapsedSeconds: built.meetingElapsedSeconds,
      meetingAgendaIndex: built.meetingAgendaIndex,
      meetingPaused: built.meetingPaused,
      meetingPause: built.meetingPause,
      speechRecognition,
      idle,
      ...(owner === undefined ? {} : { ownerName: owner.name ?? owner.email }),
      runnerPresence: runnerControl.presence,
      onEnded: async (endedAt: string) => {
        // Ending frees the owner's open slot at once; the instance stays loaded for anyone still
        // in the room and for its minutes. The row still records that the meeting is over.
        registry.noteEnded(row.id);
        await meetings.markEnded?.(row.id, endedAt);
      },
      onMinutes: async (archive) => {
        await meetings.saveMinutes?.(row.id, archive);
      },
    });
  }

  async function buildPracticeInstance(id: string, ownerUserId?: string): Promise<MeetingInstance> {
    // A practice is memory-only: it has no meetings row and is gone after a restart, so the next
    // POST /api/practice simply creates a fresh one. Every practice gets its own modules and clock;
    // falling back to the app's shared set would let two visitors' meetings change each other.
    const built = practiceModules?.() ?? createPracticeModules(scenario);
    return createMeetingInstance({
      id,
      workspaceId: SAMPLE_WORKSPACE_ID,
      paths: 'prefixed',
      kind: 'practice',
      scenario,
      modules: built.modules,
      tools: () => toolSource.toolsFor(SAMPLE_WORKSPACE_ID),
      routes: newMeetingRoutes,
      devRoutes,
      ...(auth === undefined ? {} : { auth }),
      ...(serviceToken === undefined ? {} : { serviceToken }),
      ...(calendar === undefined ? {} : { calendar }),
      ...(calendarFetch === undefined ? {} : { calendarFetch }),
      actionTools,
      roomRoster,
      draftOnly,
      meetingCode: createMeetingCodeSource(''),
      meetingCodeAttempts: createAttemptLimiter({
        limit: MEETING_CODE_FAILURE_LIMIT,
        windowMs: MEETING_CODE_WINDOW_MS,
      }),
      ...(rejoinGraceMs === undefined ? {} : { rejoinGraceMs }),
      ...(rejoinPollMs === undefined ? {} : { rejoinPollMs }),
      ...(emptyRoomPauseMs === undefined ? {} : { emptyRoomPauseMs }),
      admissionReservationMs,
      startAckTimeoutMs,
      ...(built.meetingElapsedSeconds === undefined ? {} : { meetingElapsedSeconds: built.meetingElapsedSeconds }),
      ...(built.meetingAgendaIndex === undefined ? {} : { meetingAgendaIndex: built.meetingAgendaIndex }),
      ...(built.meetingPaused === undefined ? {} : { meetingPaused: built.meetingPaused }),
      ...(built.meetingPause === undefined ? {} : { meetingPause: built.meetingPause }),
      speechRecognition,
      idle,
      runnerPresence: runnerControl.presence,
      ...(ownerUserId === undefined
        ? {}
        : {
            // A signed-in visitor's practice keeps its minutes and to-dos in their own sample history.
            onEnded: async (endedAt: string) => {
              await meetings.markEnded?.(id, endedAt);
            },
            onMinutes: async (archive) => {
              await meetings.saveMinutes?.(id, archive);
            },
          }),
    });
  }

  const registry = createMeetingRegistry({
    legacy,
    store: meetings,
    buildInstance: buildRowInstance,
    buildPracticeInstance,
    ...(persistenceFor === undefined ? {} : { persistenceFor }),
    ...(findSavedIdByCode === undefined ? {} : { findSavedIdByCode }),
    ...(maxOpenMeetings === undefined ? {} : { maxOpen: maxOpenMeetings }),
    ...(maxPracticeMeetings === undefined ? {} : { maxPractice: maxPracticeMeetings }),
    ...(maxOpenMeetingsPerUser === undefined ? {} : { maxOpenPerUser: maxOpenMeetingsPerUser }),
    ...(maxMeetingsPerDay === undefined ? {} : { maxMeetingsPerDay }),
    ...(meetingUnloadMs === undefined ? {} : { unloadMs: meetingUnloadMs }),
    ...(practiceUnloadMs === undefined ? {} : { practiceUnloadMs }),
    ...(meetingSweepMs === undefined ? {} : { sweepMs: meetingSweepMs }),
    onOpened: (meeting) => runnerControl.opened(meeting),
    onClosed: (meetingId) => runnerControl.closed(meetingId),
    onWorkspaceOpened: (workspaceId) => workspaceIndexScheduler.opened(workspaceId),
    onWorkspaceClosed: (workspaceId) => workspaceIndexScheduler.closed(workspaceId),
  });

  /** Server-wide routes have no meeting of their own; their handlers read only auth and idle. */
  const serverContext = {
    auth,
    authStore: auth?.store,
    meetings,
    llm,
    calendar,
    calendarFetch,
    workspaceTools,
    toolSource,
    indexWorkspaceTool,
    guestJoinAttempts,
    tellKakiAttempts,
    agendaFromCalendarAttempts,
    practiceAttempts,
    registry,
    serviceToken,
    routes: serverRoutes,
    idle,
  } as unknown as RequestContext;

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    // Server-wide paths (health, idle, sign-in, workspaces, and a meeting's public info/join) are
    // answered once. They are matched before the meeting prefix so info and join never load an
    // instance; every other /api/meetings/:id/<rest> still belongs to that meeting.
    if (matchRoute(serverRoutes, request.method ?? 'GET', path) !== undefined) {
      await handleRoutedRequest(request, response, serverContext);
      return;
    }

    // The only prefixed meeting paths: /api/meetings/:id/<rest> resolves that meeting first, so
    // its handlers, access levels and principal are never the legacy meeting's.
    const prefixed = /^\/api\/meetings\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (prefixed !== null) {
      const meetingId = decodeURIComponent(prefixed[1] ?? '');
      const rest = prefixed[2];
      if (rest === undefined) {
        sendJson(response, 404, { error: 'meeting-not-found' });
        return;
      }
      let instance: MeetingInstance | undefined;
      try {
        instance = await registry.get(meetingId);
      } catch (error) {
        if (error instanceof MeetingBusyError) {
          console.warn(`kaki meetings: ${meetingId} was refused: ${error.message}`);
          sendJson(response, 503, { error: 'busy', message: error.message });
          return;
        }
        throw error;
      }
      if (instance === undefined) {
        sendJson(response, 404, { error: 'meeting-not-found' });
        return;
      }
      await instance.handle(request, response, rest);
      return;
    }
    if (path.startsWith('/api/') || path.startsWith('/dev/')) {
      await legacy.handle(request, response, path);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    void routeUpgrade(request, socket, head);
  }

  async function routeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    // A browser's WebSocket handshake carries its Origin; a runner or other non-browser client
    // sends none and may pass. A cross-site page may not open a socket with a person's cookie.
    if (auth !== undefined && isCrossSiteRequest(request)) {
      console.warn('kaki server: refused a cross-site WebSocket upgrade');
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (url.searchParams.get('audience') === 'service-control') {
      runnerControl.handleUpgrade(request, socket, head);
      return;
    }
    const meetingParam = url.searchParams.get('meeting');
    // No meeting parameter is the legacy meeting. It is explicit, never a fallback.
    if (meetingParam === null) {
      legacy.handleUpgrade(request, socket, head);
      return;
    }
    let instance: MeetingInstance | undefined;
    try {
      instance = await registry.get(meetingParam);
    } catch (error) {
      if (error instanceof MeetingBusyError) {
        console.warn(`kaki meetings: upgrade refused for ${meetingParam}: ${error.message}`);
        refuseUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      console.error('kaki meetings: resolving a meeting upgrade failed', error);
      refuseUpgrade(socket, 500, 'Internal Server Error');
      return;
    }
    if (instance === undefined) {
      // An unknown meeting id is refused before a WebSocket exists. A 404 on the upgrade socket is
      // the clearest answer a browser sees; no accepted-then-closed 4404 frame is needed.
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    instance.handleUpgrade(request, socket, head);
  }

  server.on('upgrade', handleUpgrade);

  try {
    await listen(server, port, host);
  } catch (error) {
    workspaceIndexScheduler.close();
    await legacy.dispose();
    await closeServer(server).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    server,
    hub: legacy.hub,
    tasks: legacy.tasks,
    session: legacy.session,
    memory: legacy.memory,
    routes: [...serverRoutes, ...legacyRoutes],
    idle,
    registry,
    close: async () => {
      if (closed) return;
      closed = true;
      workspaceIndexScheduler.close();
      await registry.close();
      await legacy.dispose();
      await persistence?.close().catch((error: unknown) =>
        console.error('kaki server: the legacy meeting persistence failed to stop', error),
      );
      await meetings.close?.().catch((error: unknown) =>
        console.error('kaki server: the meetings store failed to stop', error),
      );
      guestJoinAttempts.clearAll();
      tellKakiAttempts.clearAll();
      agendaFromCalendarAttempts.clearAll();
      practiceAttempts.clearAll();
      runnerControl.close();
      await closeServer(server);
      await auth?.close().catch((error: unknown) =>
        console.error('kaki server: the auth feature failed to stop', error),
      );
    },
  };
}
