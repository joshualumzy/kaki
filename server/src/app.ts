import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { type MeetingMemoryEntry, type Scenario } from '@kaki/shared';
import {
  assertSafeBind,
  assertSafeMattermost,
  bearerToken,
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
import { handleIdle } from './http/routes/idle';
import { handleHealth } from './http/routes/meeting';
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
import { createMeetingModules, type MeetingModules } from './modules';

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
  /** The meetings table; absent uses an in-memory store (tests, and a database-less server). */
  meetings?: MeetingStore;
  /** Fresh modules for a new meeting's instance; defaults to this pack's Host, Wingman and Action modules. */
  meetingModules?: (meeting: MeetingRow) => MeetingModules;
  /** How many meetings may be open at once; defaults to KAKI_MAX_OPEN_MEETINGS or 10. */
  maxOpenMeetings?: number;
  /** How long a meeting with nobody connected stays loaded; defaults to KAKI_MEETING_UNLOAD_MS or 30 min. */
  meetingUnloadMs?: number;
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
  ];
  if (auth === undefined) {
    routes.push({ method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes });
    return routes;
  }
  routes.push(
    { method: 'POST', path: '/api/auth/login', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/auth/logout', access: 'public', handle: handleAuthRoutes },
    { method: 'GET', path: '/api/auth/me', access: 'public', handle: handleAuthRoutes },
    { method: 'POST', path: '/api/join', access: 'public', handle: handleAuthRoutes },
  );
  return routes;
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
  wss.on('connection', (socket) => {
    sockets.add(socket);
    // A (re)connecting runner gets every open meeting as its list.
    for (const meeting of openMeetings()) {
      socket.send(JSON.stringify({ type: 'MEETING_OPENED', ...meeting }));
    }
    const forget = (): void => {
      sockets.delete(socket);
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
      wss.close();
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
  roomRoster = livekitRoster(),
  draftOnly = false,
  meetingElapsedSeconds,
  meetingAgendaIndex,
  meetingPaused,
  meetingPause,
  persistence,
  persistenceFor,
  meetings = createMemoryMeetingStore(),
  meetingModules,
  maxOpenMeetings,
  meetingUnloadMs,
  meetingSweepMs,
  rejoinGraceMs,
  rejoinPollMs,
  emptyRoomPauseMs,
  admissionReservationMs = ADMISSION_RESERVATION_MS,
  startAckTimeoutMs = 6_000,
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
  const serverRoutes = buildServerRouteTable({ auth });
  const legacyRoutes = buildMeetingRouteTable({ devRoutes });
  const newMeetingRoutes = buildMeetingRouteTable({ devRoutes: false });
  const meetingCode = meetingCodeOption ?? createMeetingCodeSource();
  const meetingCodeAttempts =
    auth?.meetingCodeLimiter ??
    createAttemptLimiter({
      limit: MEETING_CODE_FAILURE_LIMIT,
      windowMs: MEETING_CODE_WINDOW_MS,
    });

  const legacy = await createMeetingInstance({
    id: LEGACY_MEETING_ID,
    workspaceId: SAMPLE_WORKSPACE_ID,
    legacy: true,
    scenario,
    modules,
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
  });

  // The control channel is created before the registry, but its listener runs only after both
  // exist, so reading the registry lazily is safe.
  const runnerControl = createRunnerControl({
    serviceToken,
    authOn: auth !== undefined,
    openMeetings: () => registry.openMeetings(),
  });

  async function buildRowInstance(
    row: MeetingRow,
    rowPersistence: MeetingPersistence | undefined,
  ): Promise<MeetingInstance> {
    const built = meetingModules === undefined ? createMeetingModules(row, scenario) : meetingModules(row);
    return createMeetingInstance({
      id: row.id,
      workspaceId: row.workspaceId,
      legacy: false,
      scenario,
      modules: built.modules,
      routes: newMeetingRoutes,
      devRoutes: false,
      ...(rowPersistence === undefined ? {} : { persistence: rowPersistence }),
      ...(auth === undefined ? {} : { auth }),
      ...(serviceToken === undefined ? {} : { serviceToken }),
      ...(calendar === undefined ? {} : { calendar }),
      ...(calendarFetch === undefined ? {} : { calendarFetch }),
      actionTools,
      roomRoster,
      draftOnly,
      meetingCode: createMeetingCodeSource(),
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
    });
  }

  const registry = createMeetingRegistry({
    legacy,
    store: meetings,
    buildInstance: buildRowInstance,
    ...(persistenceFor === undefined ? {} : { persistenceFor }),
    ...(maxOpenMeetings === undefined ? {} : { maxOpen: maxOpenMeetings }),
    ...(meetingUnloadMs === undefined ? {} : { unloadMs: meetingUnloadMs }),
    ...(meetingSweepMs === undefined ? {} : { sweepMs: meetingSweepMs }),
    onOpened: (meeting) => runnerControl.opened(meeting),
    onClosed: (meetingId) => runnerControl.closed(meetingId),
  });

  /** Server-wide routes have no meeting of their own; their handlers read only auth and idle. */
  const serverContext = {
    auth,
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

    // Server-wide paths (health, idle, sign-in) are answered once. Everything else that starts
    // with /api or /dev belongs to the legacy instance: unprefixed means legacy, always.
    if (matchRoute(serverRoutes, request.method ?? 'GET', path) !== undefined) {
      await handleRoutedRequest(request, response, serverContext);
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
      await registry.close();
      await legacy.dispose();
      await persistence?.close().catch((error: unknown) =>
        console.error('kaki server: the legacy meeting persistence failed to stop', error),
      );
      await meetings.close?.().catch((error: unknown) =>
        console.error('kaki server: the meetings store failed to stop', error),
      );
      runnerControl.close();
      await closeServer(server);
      await auth?.close().catch((error: unknown) =>
        console.error('kaki server: the auth feature failed to stop', error),
      );
    },
  };
}
