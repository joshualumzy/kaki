import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { codeProblem, defaultMeetingSetup, demoPackNpcProfileIds, demoRoomName, deriveMeetingScenario, humanAttendeeForRole, isKakiEvent, isMeetingMemoryEntries, isPackFreeMeeting, isSuggestInput, joinSeatRoles, KOPITIAM_INVITE_UID, meetingAgendaFromSetup, meetingScenarioFromSetup, parseMeetingInvite, parseMeetingSetup, resolveAgendaPick, seatProblem, setMeetingAgenda, setupAiCast, setupPersonSeatRoles, setupScenarioRoles, shuffleAgendaForRole, type MeetingMemoryEntry, type MeetingSetup, type RunnerMeetingSnapshot, type Scenario, type Task } from '@kaki/shared';
import {
  accessProblem,
  assertSafeBind,
  assertSafeMattermost,
  bearerToken,
  clientAddress,
  isLoopbackAddress,
  matchRoute,
  publicUrlIsHttps,
  tokenMatches,
  type Principal,
  type Route,
} from './access';
import { projectScenario } from './scenarioProjection';
import { assertReadableSavedMeeting, assertReadableSavedSetup } from './persist/state';
import { CALENDAR_CONFIG_MESSAGE, CalendarFetchError, fetchCalendarIcs, viewEvent, type CalendarSettings } from './action/calendar';
import { actionToolStatus, isActionToolKind, probeActionTool, type ActionToolOptions } from './action/tools';
import type { Auth } from './auth/module';
import { createAttemptLimiter, type AttemptLimiter } from './attemptLimiter';
import { CommandError, createHub, type ClientAudience, type Hub } from './hub';
import { resolveJoinBaseUrl } from './joinInfo';
import type { KakiModule } from './modules';
import type { MeetingPersistence } from './persist/persistence';
import {
  createMeetingCodeSource,
  MEETING_CODE_FAILURE_LIMIT,
  MEETING_CODE_RATE_LIMIT_MESSAGE,
  MEETING_CODE_WINDOW_MS,
  MEETING_ENDED_MESSAGE,
  type MeetingCodeSource,
} from './meetingCode';
import type { MeetingPauseControl } from './host';
import { admission, createRejoinGuard, createRoomPoll, rejoinGraceMsFromEnv, roomPollIntervalMs, REJOIN_POLL_MS, type Admission, type RejoinGuard } from './rejoin';
import { buildRunnerMeetingSnapshot } from './runnerState';
import { createMeetingSession, type MeetingSession } from './session';
import { createTaskStore, type TaskStore } from './tasks';
import { ADMISSION_RESERVATION_MS, createAdmissionQueue, createRoomToken, createSeatReservations, JoinError, livekitPublicUrl, livekitRoster, type RoomRoster, type SeatReservations } from './livekit';

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
  /** Seconds since the meeting started, for stamping settled cards with their source time; omit when unknown. */
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
  /** Keeps the meeting, notetaker and tasks across a restart; absent means memory only. */
  persistence?: MeetingPersistence;
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
  /** Shared secret the AI runner uses for its service channel; defaults to KAKI_SERVICE_TOKEN. */
  serviceToken?: string;
  /** The one code shared with phone sign-in; omitted creates one that rotates with the meeting. */
  meetingCode?: MeetingCodeSource;
}

/** The result of one server-owned Start, ready to send as JSON. */
interface StartOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** A listening Kaki server and its hub and task store. */
export interface KakiApp {
  server: Server;
  hub: Hub;
  tasks: TaskStore;
  session: MeetingSession;
  memory: readonly MeetingMemoryEntry[];
  /** Every HTTP route this server serves, each with its mandatory access level. */
  routes: readonly Route[];
  close(): Promise<void>;
}

interface RequestContext {
  hub: Hub;
  tasks: TaskStore;
  memory: MeetingMemoryEntry[];
  fullScenario: Scenario;
  /** A fixed agenda order from KAKI_AGENDA_PICK, used instead of the random draw. */
  pickedAgenda?: Scenario['agenda'];
  devRoutes: boolean;
  auth?: Auth;
  /** The AI runner's shared secret, compared in the access layer; absent means no service channel. */
  serviceToken?: string;
  /** Every route the access layer knows; anything not listed here is a 404. */
  routes: readonly Route[];
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
  /** Run the one Start: wait for the AI runner to open the meeting before declaring it started. */
  startMeeting(): Promise<StartOutcome>;
  /** Seats handed out but not yet visible in LiveKit's roster. */
  reservations: SeatReservations;
  /** Runs admissions one at a time so a roster check and its reservation cannot interleave. */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /** Remember the room someone joined and start watching it for the meeting's next empty spell. */
  watchRoom: (roomName: string) => void;
  /** Seconds since the meeting started, read when a settled card is created or revised. */
  meetingElapsedSeconds?: () => number | undefined;
  /** The live agenda item, for a reconnecting runner. */
  meetingAgendaIndex?: () => number | undefined;
  /** Whether the server-owned agenda clock is paused, for the runner snapshot. */
  meetingPaused?: () => boolean | undefined;
  /** Rebuild and publish the runner snapshot after a change no hub event announces (a seat holder). */
  runnerStateChanged(): RunnerMeetingSnapshot;
  /**
   * The scenario people see, plus the one admission resolves seats against. A returning seat holder
   * inside the grace of a running meeting is judged against its sealed setup; every other arrival
   * starts the next meeting and is judged against the current draft.
   */
  seating(returning?: boolean, roomEmpty?: boolean): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup; admissionCap?: number };
  /** The scenario a browser is shown now: the sealed meeting once started, the draft setup in the lobby. */
  visibleScenario(service?: boolean): Scenario;
  /** Why setup cannot change right now, if it cannot. */
  setupLocked(): 'starting' | 'started' | undefined;
  /** Queue a save of the current meeting, including the setup draft; a no-op without persistence. */
  scheduleSave(): void;
}

const MAX_BODY_BYTES = 1_000_000;

type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The one message for a role id this meeting does not offer: name it and list the offered seats. */
function notAHumanSeat(wanted: string, offered: ReadonlyArray<{ id: string; label: string }>): string {
  const list =
    offered.length === 0 ? 'none' : offered.map((role) => `${role.id} (${role.label})`).join(', ');
  return `"${wanted}" is not a human seat in this meeting. Pick one of the roles offered when you join: ${list}.`;
}

/** Refuse a setup write while the meeting is starting or already started. */
function sendSetupLocked(response: ServerResponse, lock: 'starting' | 'started'): void {
  sendJson(response, 409, {
    error:
      lock === 'starting'
        ? "The meeting is starting; setup can't change now."
        : "The meeting has started; setup can't change now.",
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : 'Could not read body' };
  }

  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Body must be valid JSON' };
  }
}

/**
 * The one route table. Every HTTP path this server answers is declared here with its mandatory
 * access level; the access check runs once, before any handler, and an unlisted path is a 404.
 */
function buildRouteTable({ auth }: { auth: Auth | undefined }): Route[] {
  const routes: Route[] = [
    { method: 'GET', path: '/health', access: 'public' },
    { method: 'GET', path: '/api/meeting/state', access: 'public' },
    { method: 'GET', path: '/api/runner/meeting-state', access: 'service' },
    { method: 'POST', path: '/api/livekit/token', access: 'public' },
    { method: 'POST', path: '/api/meeting/start', access: 'host' },
    { method: 'GET', path: '/api/mattermost/open', access: 'session' },
    { method: 'GET', path: '/api/calendar/:id', access: 'public' },
    { method: 'GET', path: '/api/scenario', access: 'public' },
    { method: 'GET', path: '/api/scenario/full', access: 'service' },
    { method: 'GET', path: '/api/setup', access: 'session' },
    { method: 'GET', path: '/api/setup/tools', access: 'host' },
    { method: 'POST', path: '/api/setup/tools/:kind/test', access: 'host' },
    { method: 'PUT', path: '/api/setup', access: 'host' },
    { method: 'POST', path: '/api/setup/import-calendar', access: 'host' },
    { method: 'GET', path: '/api/join-info', access: 'public' },
    { method: 'POST', path: '/api/runner/emit', access: 'service' },
    { method: 'POST', path: '/api/runner/suggest-task', access: 'service' },
    { method: 'POST', path: '/api/runner/meeting-memory', access: 'service' },
    { method: 'POST', path: '/api/runner/settle-topic', access: 'service' },
    { method: 'POST', path: '/dev/emit', access: 'dev' },
    { method: 'POST', path: '/dev/suggest-task', access: 'dev' },
    { method: 'POST', path: '/dev/meeting-memory', access: 'dev' },
    { method: 'POST', path: '/dev/settle-topic', access: 'dev' },
  ];

  if (auth === undefined) {
    routes.push({ method: 'GET', path: '/api/auth/me', access: 'public' });
    return routes;
  }

  routes.push(
    { method: 'POST', path: '/api/auth/login', access: 'public' },
    { method: 'POST', path: '/api/auth/logout', access: 'public' },
    { method: 'GET', path: '/api/auth/me', access: 'public' },
    { method: 'POST', path: '/api/join', access: 'public' },
    { method: 'GET', path: '/api/meeting-code', access: 'host' },
  );
  return routes;
}

/** Resolve who a request belongs to: a service token first, then this meeting's session. */
async function resolvePrincipal(
  request: IncomingMessage,
  context: { auth?: Auth; serviceToken?: string },
): Promise<Principal> {
  if (
    context.serviceToken !== undefined &&
    tokenMatches(bearerToken(request), context.serviceToken)
  ) {
    return { kind: 'service' };
  }
  if (context.auth !== undefined) {
    const principal = await context.auth.resolvePrincipal(request);
    if (principal !== undefined) return principal;
  }
  return { kind: 'anonymous' };
}

/**
 * Where a person's browser should open Mattermost. The server reaches it at MATTERMOST_URL
 * (often 127.0.0.1 inside the VM); the browser must use the public host instead.
 */
function mattermostPublicBase(internal: URL, env: NodeJS.ProcessEnv = process.env): URL {
  const explicit = env.MATTERMOST_PUBLIC_URL?.trim();
  if (explicit !== undefined && explicit !== '') return new URL(explicit);
  const publicSite = env.KAKI_PUBLIC_URL?.trim();
  if (publicSite !== undefined && publicSite !== '') {
    const site = new URL(publicSite);
    const base = new URL(internal.toString());
    base.hostname = site.hostname;
    return base;
  }
  return new URL(internal.toString());
}

async function syncDemoVisitorProfile(participantName: string): Promise<void> {
  const cleanName = participantName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (cleanName === '') return;

  const giteaUrl = process.env.GITEA_URL?.trim();
  const giteaToken = process.env.GITEA_TOKEN?.trim();
  if (giteaUrl && giteaToken) {
    await fetch(`${giteaUrl.replace(/\/+$/, '')}/api/v1/admin/users/demo`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `token ${giteaToken}` },
      body: JSON.stringify({ full_name: cleanName, login_name: 'demo' }),
    }).catch(() => undefined);
  }

  const mmUrl = process.env.MATTERMOST_URL?.trim();
  const mmPassword = process.env.MATTERMOST_PASSWORD;
  if (mmUrl && mmPassword) {
    try {
      const baseMmUrl = mmUrl.replace(/\/+$/, '');
      const mmAdminToken = process.env.MATTERMOST_TOKEN?.trim();
      if (mmAdminToken) {
        await fetch(`${baseMmUrl}/api/v4/config/patch`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${mmAdminToken}` },
          body: JSON.stringify({ TeamSettings: { TeammateNameDisplay: 'full_name', LockTeammateNameDisplay: true } }),
        }).catch(() => undefined);
      }
      let loginResp: Response | undefined;
      for (const loginId of ['demo@nanyangkopitiam.example', 'demo']) {
        const resp = await fetch(`${baseMmUrl}/api/v4/users/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login_id: loginId, password: mmPassword }),
        });
        if (resp.ok) {
          loginResp = resp;
          break;
        }
      }
      if (loginResp?.ok) {
        const sessionToken = loginResp.headers.get('Token');
        const userObj = (await loginResp.json().catch(() => undefined)) as { id?: string } | undefined;
        if (sessionToken && userObj?.id) {
          await fetch(`${baseMmUrl}/api/v4/users/${userObj.id}/patch`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ username: 'demo', first_name: cleanName, last_name: '', nickname: cleanName }),
          }).catch(() => undefined);
        }
      }
    } catch {
      // Best-effort profile sync when visitor joins.
    }
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const match = matchRoute(context.routes, method, path);
    if (match === undefined) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    const principal = await resolvePrincipal(request, context);
    const denied = accessProblem(match.route, principal, {
      authEnabled: context.auth !== undefined,
      devRoutes: context.devRoutes,
      serviceTokenConfigured: context.serviceToken !== undefined && context.serviceToken !== '',
      loopback: isLoopbackAddress(request.socket.remoteAddress),
      rawPath: request.url ?? '',
    });
    if (denied !== undefined) {
      sendJson(response, denied.status, { error: denied.error });
      return;
    }

    if (method === 'POST' && path === '/api/livekit/token') {
      const codeIp = clientAddress(request);
      if (context.meetingCodeAttempts.isLimited(codeIp)) {
        sendJson(response, 429, { error: MEETING_CODE_RATE_LIMIT_MESSAGE });
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const join = body.value as Record<string, unknown> | null;
      if (
        typeof join !== 'object' ||
        join === null ||
        typeof join.participantName !== 'string' ||
        (join.participantRole !== undefined && typeof join.participantRole !== 'string')
      ) {
        sendJson(response, 400, { error: 'participantName is required' });
        return;
      }
      // The room is the server's, not the caller's: naming a fresh room must not skip admission.
      const roomName = demoRoomName(context.session.active());
      const participantName = join.participantName.trim();
      const wantedRole = typeof join.participantRole === 'string' ? join.participantRole.trim() : '';
      if (wantedRole.length === 0) {
        sendJson(response, 400, { error: 'participantRole is required: pick the seat you are taking.' });
        return;
      }
      // A meeting being prepared is sealed already: admitting someone now would leave their seat out.
      if (context.session.phase() === 'starting') {
        sendJson(response, 409, {
          error: 'The meeting is starting; try again in a moment.',
          retryable: true,
        });
        return;
      }
      try {
        await context.admit(async () => {
          // A Start flips the phase inside this same queue: this catches a join that queued behind it.
          if (context.session.phase() === 'starting') {
            sendJson(response, 409, {
              error: 'The meeting is starting; try again in a moment.',
              retryable: true,
            });
            return;
          }
          const admissionPhase = context.session.phase();
          const admissionGeneration = context.session.generation();
          // Admission reads the pack, not the sealed cast: a seat an AI once had stays a reserved name.
          const npcNames = (context.fullScenario.npcs ?? []).map((npc) => npc.attendee);
          const joiningName = participantName.toLowerCase();
          const roster = await context.roomRoster(roomName);
          if (roster === undefined) {
            sendJson(response, 503, {
              error: 'Could not check who is in the meeting right now. Try again in a moment.',
              retryable: true,
            });
            return;
          }
          const rosterHumans = roster.filter(
            (person) => !npcNames.some((npc) => npc.toLowerCase() === person.name.toLowerCase()),
          );
          // A reservation made by this same person is a retry, not another seat: let them reclaim it.
          const otherReservations = context.reservations
            .active(rosterHumans.map((person) => person.name))
            .filter((reservation) => reservation.participantName.toLowerCase() !== joiningName);
          const present = [
            ...rosterHumans,
            ...otherReservations.map((reservation) => ({ name: reservation.participantName, role: reservation.seatId })),
          ];
          // Every refusal happens before anything can reset or mutate the meeting. With sign-in on,
          // a person needs the code; the signed-in owner may start or carry on a meeting without it.
          const authOn = context.auth !== undefined;
          const isHost = principal.kind === 'host';
          if (authOn && principal.kind !== 'service' && !isHost) {
            const codeError = codeProblem(
              1,
              context.meetingCode.value,
              typeof join.meetingCode === 'string' ? join.meetingCode : undefined,
            );
            if (codeError !== undefined) {
              context.meetingCodeAttempts.recordFailure(codeIp);
              sendJson(response, 403, { error: codeError, needsCode: true });
              return;
            }
          }
          // A seat holder coming back to an empty room inside the grace joins the running meeting;
          // everyone else starts the next meeting, which is judged against the current draft.
          const roomEmpty = present.length === 0;
          const phase = admissionPhase;
          // A saved meeting that did not come back running is consumed: the next arrival starts fresh,
          // even if the person's name was one of its holders.
          const decisionPhase = context.session.restoredWithoutMeeting() ? 'ended' : phase;
          const holders = context.session.holders();
          const abandoned = context.session.abandoned();
          const wouldHold = context.rejoin.wouldHold();
          const returning =
            roomEmpty &&
            admission({
              phase: decisionPhase,
              holders,
              present,
              name: participantName,
              graceActive: wouldHold,
              abandoned,
            }) === 'resume';
          const seating = context.seating(returning, roomEmpty);
          // The role id is the seat's one identity. An owner-edited draft admits only the person seats
          // it names; an untouched draft admits every human seat the pack offers.
          let seatId: string;
          if (seating.setup !== undefined) {
            const key = wantedRole.toLowerCase();
            const role = seating.setup.roles.find((candidate) => candidate.id.toLowerCase() === key);
            if (role === undefined) {
              sendJson(response, 400, {
                error: notAHumanSeat(wantedRole, joinSeatRoles(seating.scenario)),
              });
              return;
            }
            const isPersonSeat = seating.setup.seats.some(
              (candidate) => candidate.kind === 'person' && candidate.roleId === role.id,
            );
            if (!isPersonSeat) {
              sendJson(response, 409, {
                error: `This meeting's setup has no place for ${role.label}; the owner set the seats.`,
              });
              return;
            }
            seatId = role.id;
          } else {
            const seat = humanAttendeeForRole(seating.admissionScenario, wantedRole);
            if (seat === undefined) {
              sendJson(response, 400, {
                error: notAHumanSeat(wantedRole, joinSeatRoles(seating.scenario)),
              });
              return;
            }
            seatId = seat.role;
          }
          const decision: Admission = roomEmpty
            ? admission({
                phase: decisionPhase,
                holders,
                present,
                name: participantName,
                seat: seatId,
                graceActive: wouldHold,
                abandoned,
              })
            : 'join';
          const requestedMax = Number(process.env.NPC_MAX_HUMANS);
          const envMax = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : undefined;
          // A setup admits exactly its own person seats; an AI meeting still caps at one person in seatProblem.
          const setupMax = seating.admissionCap;
          const maxHumans = setupMax === undefined ? envMax : Math.min(setupMax, envMax ?? setupMax);
          const problem = seatProblem(seating.admissionScenario, present, seatId, maxHumans);
          if (problem !== undefined) {
            sendJson(response, 409, { error: problem });
            return;
          }
          if (!authOn) {
            // The trusted demo keeps its first-arrival rule exactly: the first person is shown the code.
            // `present` is read before any reset, so this stays the count from this room.
            const codeError = codeProblem(
              present.length,
              context.meetingCode.value,
              typeof join.meetingCode === 'string' ? join.meetingCode : undefined,
            );
            if (codeError !== undefined) {
              context.meetingCodeAttempts.recordFailure(codeIp);
              sendJson(response, 403, { error: codeError, needsCode: true });
              return;
            }
          }
          context.meetingCodeAttempts.clear(codeIp);
          // The first person into an empty room starts a new meeting with a new code; later people must know it.
          // A person returning within the grace window keeps the meeting, its code, agenda, tasks and NPC conversation;
          // a different person arriving in that empty room starts a fresh meeting instead.
          const meetingWasRunning = phase === 'running';
          const meetingExisted = context.session.restoredWithoutMeeting()
            ? false
            : holders.length > 0 || phase === 'running' || phase === 'ended';
          // A code holder may be first into a fresh meeting, but may never wipe one that already ran.
          // That holds for an abandoned meeting too: it never resumes, and only the owner replaces it.
          const wouldReset = decision === 'reset';
          if (wouldReset && meetingExisted && authOn && !isHost) {
            sendJson(response, 409, {
              error: 'This meeting has ended; the meeting owner must start the next one.',
            });
            return;
          }
          if (present.some((person) => person.name.toLowerCase() === joiningName)) {
            sendJson(response, 409, {
              error: `"${participantName}" is already in the meeting. Pick another name.`,
            });
            return;
          }
          // Token minting needs no meeting id: it only signs this person into the room. Doing it before
          // the reset is what keeps a refused join from wiping a running meeting.
          const token = await createRoomToken(
            { roomName: roomName, participantName, participantRole: seatId },
            npcNames,
          );

          // A Start or reset that landed while this join awaited the roster/token must not let it
          // mutate a meeting it never saw: refuse before any reset or seat claim, and let the client retry.
          if (
            context.session.generation() !== admissionGeneration ||
            context.session.phase() !== admissionPhase
          ) {
            sendJson(response, 409, {
              error: 'The meeting changed while you were joining; try again in a moment.',
              retryable: true,
            });
            return;
          }

          // All checks passed: this is the commit. Admission decides, the session resets if needed,
          // and the seat claim belongs to the new meeting id.
          if (decision === 'reset') {
            // The first arrival starts this app's first meeting. Its identity already exists, and
            // phones may have joined under it through /api/join, so keep that generation and code.
            context.session.reset({
              seat: seatId,
              rotateIdentity: meetingExisted,
              rotateCode: true,
            });
          }
          if (roomEmpty && decision !== 'reset') context.rejoin.beginGrace();
          // Sign-in on: taking the seat and creating its session is one atomic claim shared with
          // /api/join, so a code holder can never take a seat another live holder owns.
          if (context.auth !== undefined && principal.kind !== 'service') {
            if (!(await context.auth.enterSeat(request, response, seatId))) {
              console.error(
                `kaki join: ${participantName} could not take seat ${seatId} after the meeting reset; the seat is already held`,
              );
              sendJson(response, 409, { error: 'That seat is taken. Pick another role.' });
              return;
            }
          }
          context.reservations.add({ participantName, seatId });
          context.session.addHolder({ name: participantName, seat: seatId });
          context.runnerStateChanged();
          if (roomEmpty) context.rejoin.joined();
          else context.rejoin.occupied();
          // Seat holders are part of the meeting: save them so a restart recognises the same people.
          context.scheduleSave();
          context.watchRoom(roomName);
          void syncDemoVisitorProfile(participantName);
          const resumed = meetingWasRunning && decision !== 'reset';
          const started = context.session.phase() === 'running';
          console.log(`[join] seat=${seatId} room=${roomName} reset=${decision === 'reset'} resumed=${resumed} started=${started}`);
          sendJson(response, 200, { token, url: livekitPublicUrl(), meetingCode: context.meetingCode.value, resumed, started });
        });
      } catch (error) {
        if (error instanceof JoinError) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    // One server-owned start for the whole meeting. A second Start is a no-op: it must never open the
    // meeting twice or restart the agenda clock. Every client learns the change from MEETING_STARTED.
    if (request.method === 'POST' && path === '/api/meeting/start') {
      const outcome = await context.startMeeting();
      sendJson(response, outcome.status, outcome.body);
      return;
    }

    // Browsers only need the lifecycle marker; the runner gets the one full meeting snapshot.
    if (request.method === 'GET' && (path === '/api/meeting/state' || path === '/api/runner/meeting-state')) {
      if (path === '/api/runner/meeting-state') {
        sendJson(response, 200, context.runnerStateChanged());
        return;
      }
      sendJson(response, 200, {
        meetingId: context.meeting.id,
        started: context.session.phase() === 'running',
      });
      return;
    }

    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && path === '/api/mattermost/open') {
      const query = url.searchParams;
      const rawTarget = query.get('url')?.trim() ?? '';
      let parsedTarget: URL;
      try {
        parsedTarget = new URL(rawTarget);
      } catch {
        sendJson(response, 400, { error: 'Valid target url is required' });
        return;
      }
      const mmUrl = process.env.MATTERMOST_URL?.trim();
      if (mmUrl === undefined || mmUrl === '') {
        sendJson(response, 503, { error: 'Mattermost is not configured: set MATTERMOST_URL.' });
        return;
      }
      const mmPassword = process.env.MATTERMOST_PASSWORD;
      if (mmPassword === undefined || mmPassword === '') {
        sendJson(response, 503, { error: 'Mattermost is not configured: set MATTERMOST_PASSWORD.' });
        return;
      }
      let mmBase: URL;
      try {
        mmBase = new URL(mmUrl);
      } catch {
        sendJson(response, 503, { error: 'Mattermost is not configured: MATTERMOST_URL is not a valid URL.' });
        return;
      }
      // Old links were generated with localhost, 127.0.0.1 or the LAN/public host. Match the path
      // against the configured server, then build the redirect on the configured public base, so
      // the origin in the link can never send the browser anywhere else.
      const basePath = mmBase.pathname.replace(/\/+$/, '') || '/';
      const insideBase =
        basePath === '/'
          ? parsedTarget.pathname.startsWith('/')
          : parsedTarget.pathname === basePath || parsedTarget.pathname.startsWith(`${basePath}/`);
      if ((parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') || !insideBase) {
        sendJson(response, 400, { error: 'Target must be a link on the Mattermost server.' });
        return;
      }
      let publicBase: URL;
      try {
        publicBase = mattermostPublicBase(mmBase);
      } catch {
        sendJson(response, 503, {
          error: 'Mattermost is not configured: MATTERMOST_PUBLIC_URL or KAKI_PUBLIC_URL is not a valid URL.',
        });
        return;
      }
      const redirect = new URL(publicBase.toString());
      redirect.pathname = parsedTarget.pathname;
      redirect.search = parsedTarget.search;
      redirect.hash = parsedTarget.hash;
      const keepSecure = publicUrlIsHttps();
      const secureAttribute = keepSecure ? '; Secure' : '';
      const baseMmUrl = `${mmBase.origin}${mmBase.pathname}`.replace(/\/+$/, '');
      const setCookies: string[] = [];
      try {
        let loginResp: Response | undefined;
        for (const loginId of ['demo@nanyangkopitiam.example', 'demo']) {
          const resp = await fetch(`${baseMmUrl}/api/v4/users/login`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-requested-with': 'XMLHttpRequest',
            },
            body: JSON.stringify({ login_id: loginId, password: mmPassword }),
          });
          if (resp.ok) {
            loginResp = resp;
            break;
          }
        }
        if (loginResp?.ok) {
          const rawCookies = loginResp.headers.getSetCookie?.() ?? [];
          for (const cookie of rawCookies) {
            // Keep Secure on an https public site; only a local http demo needs it removed.
            setCookies.push(keepSecure ? cookie : cookie.replace(/;\s*Secure/gi, ''));
          }
          if (setCookies.length === 0) {
            const sessionToken = loginResp.headers.get('Token');
            const userObj = (await loginResp.json().catch(() => undefined)) as { id?: string } | undefined;
            if (sessionToken) {
              setCookies.push(
                `MMAUTHTOKEN=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureAttribute}`,
              );
              setCookies.push(
                `MMCSRF=${sessionToken}; Path=/; Max-Age=2592000; SameSite=Lax${secureAttribute}`,
              );
            }
            if (userObj?.id) {
              setCookies.push(`MMUSERID=${userObj.id}; Path=/; Max-Age=2592000; SameSite=Lax${secureAttribute}`);
            }
          }
        }
      } catch {
        // Proceed with redirect even if auto-login fails.
      }
      response.writeHead(302, {
        Location: redirect.toString(),
        'Cache-Control': 'no-store',
        ...(setCookies.length > 0 ? { 'Set-Cookie': setCookies } : {}),
      });
      response.end();
      return;
    }

    const eventMatch = /^\/api\/calendar\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && eventMatch !== null && context.calendar !== undefined) {
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const month = query.get('month') ?? undefined;
      const view = await viewEvent(context.calendar, decodeURIComponent(eventMatch[1] ?? ''), {
        download: query.has('download'),
        ...(month === undefined ? {} : { month }),
      });
      response.writeHead(view.status, {
        'content-type': view.contentType,
        ...(view.filename === undefined ? {} : { 'content-disposition': `attachment; filename="${view.filename}"` }),
      });
      response.end(view.body);
      return;
    }

    if (request.method === 'GET' && path === '/api/scenario/full') {
      // The runner prepares the sealed candidate while Start is in flight; everyone else sees the live one.
      const phase = context.session.phase();
      const active =
        phase === 'starting'
          ? context.session.candidate() ?? context.session.active()
          : phase === 'running'
            ? context.session.active()
            : context.seating().scenario;
      sendJson(response, 200, active);
      return;
    }

    if (request.method === 'GET' && path === '/api/scenario') {
      const active = context.visibleScenario(principal.kind === 'service');
      // A seat holder sees that seat, whether a participant or the host playing it.
      const seat =
        principal.kind === 'seat'
          ? principal.role
          : principal.kind === 'host'
            ? principal.seat
            : undefined;
      // With sign-in off the trusted demo keeps the whole scenario, as it always did.
      const visible =
        context.auth === undefined || principal.kind === 'service'
          ? active
          : projectScenario(active, seat);
      sendJson(response, 200, visible);
      return;
    }

    if (request.method === 'GET' && path === '/api/setup') {
      const phase = context.session.phase();
      sendJson(response, 200, {
        // Only a running meeting shows its seal; every other phase edits the next meeting's draft.
        setup: phase === 'running' ? (context.session.sealed() ?? context.session.draft()) : context.session.draft(),
        started: phase === 'running',
        phase,
      });
      return;
    }

    if (request.method === 'GET' && path === '/api/setup/tools') {
      sendJson(response, 200, { tools: actionToolStatus(context.actionTools.env) });
      return;
    }

    const toolTestMatch = /^\/api\/setup\/tools\/([^/]+)\/test$/.exec(path);
    if (request.method === 'POST' && toolTestMatch !== null) {
      const kind = decodeURIComponent(toolTestMatch[1] ?? '');
      if (!isActionToolKind(kind)) {
        sendJson(response, 404, { error: 'Unknown tool kind.' });
        return;
      }
      const result = await probeActionTool(kind, context.actionTools);
      sendJson(response, 200, { kind, ...result });
      return;
    }

    if (request.method === 'PUT' && path === '/api/setup') {
      // Only the meeting owner edits setup; everyone else gets the read-only join view.
      const lock = context.setupLocked();
      if (lock !== undefined) {
        sendSetupLocked(response, lock);
        return;
      }
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const lateLock = context.setupLocked();
      if (lateLock !== undefined) {
        sendSetupLocked(response, lateLock);
        return;
      }
      const parsed = parseMeetingSetup(body.value, {
        npcProfileIds: demoPackNpcProfileIds(context.fullScenario),
      });
      if (!parsed.ok) {
        sendJson(response, 400, { errors: parsed.errors });
        return;
      }
      const derived = deriveMeetingScenario(context.fullScenario, parsed.value);
      if (!derived.ok) {
        sendJson(response, 422, {
          error: 'This setup describes a meeting that cannot run. Fix the highlighted setup and try again.',
          errors: derived.errors,
        });
        return;
      }
      // An ended meeting keeps its seal for saving; this edit is the next meeting's draft.
      context.session.setDraft(parsed.value);
      context.runnerStateChanged();
      context.scheduleSave();
      sendJson(response, 200, { setup: parsed.value, started: false });
      return;
    }

    if (request.method === 'POST' && path === '/api/setup/import-calendar') {
      // Only the meeting owner edits setup; everyone else gets the read-only join view.
      const lock = context.setupLocked();
      if (lock !== undefined) {
        sendSetupLocked(response, lock);
        return;
      }
      if (context.calendar === undefined) {
        sendJson(response, 503, { error: CALENDAR_CONFIG_MESSAGE });
        return;
      }

      let ics: string;
      try {
        ics = await fetchCalendarIcs(context.calendar, context.calendarFetch);
      } catch (error) {
        if (error instanceof CalendarFetchError) {
          sendJson(response, error.status, { error: error.message });
        } else {
          console.error('kaki setup: calendar import failed', error);
          sendJson(response, 502, { error: 'The calendar could not be read.' });
        }
        return;
      }
      const lateLock = context.setupLocked();
      if (lateLock !== undefined) {
        sendSetupLocked(response, lateLock);
        return;
      }

      const pack = defaultMeetingSetup(context.fullScenario);
      const knownOwners = [
        ...pack.roles.flatMap((role) => [role.id, role.label]),
        ...pack.seats.map((seat) => seat.displayName),
      ];
      const parsedInvite = parseMeetingInvite(ics, { uid: KOPITIAM_INVITE_UID, knownOwners });
      if (!parsedInvite.ok) {
        const missing = parsedInvite.errors.some((problem) => problem.field === 'invite');
        sendJson(
          response,
          missing ? 404 : 422,
          missing
            ? { error: parsedInvite.errors[0]?.message ?? 'The calendar invite was not found.' }
            : { error: 'The calendar invite agenda could not be read.', errors: parsedInvite.errors },
        );
        return;
      }

      const invite = parsedInvite.value;
      const problems: Array<{ field: string; message: string }> = [];
      const roleForOwner = (owner: string): MeetingSetup['roles'][number] | undefined => {
        const key = owner.trim().toLowerCase();
        const role = pack.roles.find(
          (candidate) => candidate.id.toLowerCase() === key || candidate.label.toLowerCase() === key,
        );
        if (role !== undefined) return role;
        const seat = pack.seats.find((candidate) => candidate.displayName.trim().toLowerCase() === key);
        return seat === undefined ? undefined : pack.roles.find((candidate) => candidate.id === seat.roleId);
      };

      const agenda: MeetingSetup['agenda'] = [];
      invite.agenda.forEach((item, index) => {
        const role = roleForOwner(item.owner);
        if (role === undefined) {
          problems.push({
            field: `agenda[${index}].owner`,
            message: `"${item.owner}" is not a seat or role in the demo pack.`,
          });
          return;
        }
        agenda.push({ id: `agenda-${index + 1}`, title: item.title, minutes: item.minutes, ownerRoleId: role.id });
      });

      // The invite's people are the meeting's people; the pack supplies each one's role and AI stand-in.
      const packSeatByName = new Map(pack.seats.map((seat) => [seat.displayName.trim().toLowerCase(), seat]));
      const seats: MeetingSetup['seats'] = [];
      invite.people.forEach((displayName, index) => {
        const seat = packSeatByName.get(displayName.trim().toLowerCase());
        if (seat === undefined) {
          problems.push({
            field: `seats[${index}].displayName`,
            message: `"${displayName}" is in the calendar invite but not in the demo pack.`,
          });
          return;
        }
        seats.push({ ...seat, displayName });
      });

      if (problems.length > 0) {
        sendJson(response, 422, { error: 'The calendar invite does not match the demo pack.', errors: problems });
        return;
      }

      const imported: MeetingSetup = {
        title: invite.title,
        agenda,
        roles: pack.roles,
        seats,
        pace: pack.pace,
        source: {
          title: 'calendar invite',
          agenda: 'calendar invite',
          roles: 'demo pack',
          seats: 'demo pack',
          pace: 'demo pack',
        },
      };
      const parsed = parseMeetingSetup(imported, {
        npcProfileIds: demoPackNpcProfileIds(context.fullScenario),
      });
      if (!parsed.ok) {
        sendJson(response, 422, { error: 'The imported setup is not valid.', errors: parsed.errors });
        return;
      }
      const derived = deriveMeetingScenario(context.fullScenario, parsed.value);
      if (!derived.ok) {
        sendJson(response, 422, {
          error: 'The imported setup describes a meeting that cannot run.',
          errors: derived.errors,
        });
        return;
      }

      // An ended meeting keeps its seal for saving; this import is the next meeting's draft.
      context.session.setDraft(parsed.value);
      context.scheduleSave();
      sendJson(response, 200, { setup: parsed.value, started: false });
      return;
    }

    if (request.method === 'GET' && path === '/api/join-info') {
      const join = resolveJoinBaseUrl();
      if (!join.ok) {
        sendJson(response, 503, { error: join.error });
        return;
      }
      sendJson(response, 200, { baseUrl: join.baseUrl });
      return;
    }

    if (request.method === 'POST' && (path === '/dev/emit' || path === '/api/runner/emit')) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isKakiEvent(body.value, context.session.active())) {
        sendJson(response, 400, { error: 'Body must be a valid KakiEvent' });
        return;
      }
      if (body.value.type === 'MEETING_RESET') {
        sendJson(response, 400, { error: 'MEETING_RESET can only be published by the meeting session' });
        return;
      }

      // Transcript lines and reactions are live-only: replaying them to a page that opens later shows ghost speech
      // or a stale reaction badge. Everything else a demo emits (nudges, facts, tasks) stays available to phones
      // that join later.
      const liveOnly = body.value.type === 'TRANSCRIPT_CHUNK' || body.value.type === 'COLLEAGUE_REACTION';
      context.hub.publish(
        body.value,
        liveOnly ? undefined : { retainKey: `dev:${JSON.stringify(body.value)}` },
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && (path === '/dev/suggest-task' || path === '/api/runner/suggest-task')) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isSuggestInput(body.value, context.session.active())) {
        sendJson(response, 400, { error: 'Body must be a valid task suggestion' });
        return;
      }
      sendJson(response, 200, context.tasks.suggest(body.value));
      return;
    }

    if (request.method === 'POST' && (path === '/dev/meeting-memory' || path === '/api/runner/meeting-memory')) {
      const body = await readJsonBody(request);
      if (!body.ok) { sendJson(response, body.status, { error: body.error }); return; }
      if (!isMeetingMemoryEntries(body.value, context.session.active().agenda.map((item) => item.title))) {
        sendJson(response, 400, { error: 'Invalid meeting memory' }); return;
      }
      context.memory.splice(0, context.memory.length, ...body.value);
      sendJson(response, 200, { ok: true });
      return;
    }

    // The live demo's engine locked the visitor's decision on an agenda item: create its follow-up and release
    // whatever was held for that item, in one request so the two can never disagree.
    if (request.method === 'POST' && (path === '/dev/settle-topic' || path === '/api/runner/settle-topic')) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isSuggestInput(body.value, context.session.active())) {
        sendJson(response, 400, { error: 'Body must be a valid task suggestion with an agendaItemTitle' });
        return;
      }
      const followUp = body.value;
      const sourceSeconds = context.meetingElapsedSeconds?.();
      const reopening = new URL(request.url ?? '/', 'http://localhost').searchParams.get('reopen') === '1';
      const agendaTitle = followUp.agendaItemTitle;
      if (agendaTitle === undefined) {
        sendJson(response, 400, { error: 'Body must be a valid task suggestion with an agendaItemTitle' });
        return;
      }
      // The settlement is the visitor's authoritative follow-up for this topic, so it replaces whichever early
      // suggestion was being held for the same agenda item, role and deliverable, however differently the two were
      // worded. A retried settlement reuses the card its first POST already dispatched, so it never creates a second
      // one. Any other held card for those same three keys is a duplicate and is dismissed; cards for another
      // deliverable or owner stay untouched.
      const sameTopic = (task: Task): boolean =>
        task.agendaItemTitle === followUp.agendaItemTitle &&
        task.suggestedAssignee === followUp.suggestedAssignee && (reopening || task.actionKind === followUp.actionKind);
      const matching = context.tasks.list().filter((task) => sameTopic(task) && task.status !== 'SUPERSEDED');
      const settled = matching.find((task) => task.status !== 'SUGGESTED' && task.status !== 'DISMISSED');
      const suggested = matching.filter((task) => task.status === 'SUGGESTED');
      const sameDecision = settled !== undefined && settled.decisionSource === followUp.decisionSource &&
        settled.actionKind === followUp.actionKind;
      if (settled !== undefined && reopening && !sameDecision) {
        context.tasks.supersede(settled.id);
      }
      const task = settled !== undefined && (!reopening || sameDecision) ? settled :
        (suggested[0] === undefined
          ? context.tasks.suggest(followUp, undefined, sourceSeconds)
          : context.tasks.reviseSuggested(suggested[0].id, followUp, sourceSeconds));
      for (const duplicate of settled === undefined ? suggested.slice(1) : suggested) {
        context.tasks.transition(duplicate.id, 'DISMISSED');
      }
      context.hub.publish({
        type: 'TOPIC_SETTLED',
        audience: { kind: 'screen' },
        payload: { title: agendaTitle, taskId: task.id },
      });
      sendJson(response, 200, context.tasks.get(task.id));
      return;
    }

    if (context.auth !== undefined) {
      if (await context.auth.handleHttp(request, response)) return;
    } else if (request.method === 'GET' && path === '/api/auth/me') {
      sendJson(response, 200, { authEnabled: false });
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof CommandError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error('kaki server: request failed', error);
    sendJson(response, 500, { error: 'Internal server error' });
  }
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

/** Create the HTTP server, the `/ws` hub and the task store, then start every module. */
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
  rejoinGraceMs,
  rejoinPollMs,
  emptyRoomPauseMs,
  admissionReservationMs = ADMISSION_RESERVATION_MS,
  startAckTimeoutMs = 6_000,
  serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim(),
  meetingCode: meetingCodeOption,
}: CreateAppOptions): Promise<KakiApp> {
  assertSafeBind(host, auth !== undefined);
  assertSafeMattermost(auth !== undefined);
  if (devRoutes && auth !== undefined) {
    throw new Error(
      'kaki server: KAKI_DEV_ROUTES=1 cannot be combined with KAKI_AUTH=1; the dev routes are a local-only tool. Unset one of them.',
    );
  }
  const routes = buildRouteTable({ auth });
  const meetingCode = meetingCodeOption ?? createMeetingCodeSource();
  const meetingCodeAttempts =
    auth?.meetingCodeLimiter ??
    createAttemptLimiter({
      limit: MEETING_CODE_FAILURE_LIMIT,
      windowMs: MEETING_CODE_WINDOW_MS,
    });
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  const fullScenario = {
    ...scenario,
    agenda: [...scenario.agenda],
    roles: [...scenario.roles],
    attendees: [...scenario.attendees],
    ...(scenario.npcs === undefined ? {} : { npcs: [...scenario.npcs] }),
  };
  const pickedAgenda = agendaPick ? resolveAgendaPick(fullScenario, agendaPick) : undefined;
  // The draft the setup screen starts from, rebuilt from the packaged scenario for every new meeting.
  const defaultSetup = defaultMeetingSetup(fullScenario);
  // Validate the whole saved meeting before any part of it is applied. A started meeting keeps the
  // sealed setup it ran with, even once it has ended, so its roles are the ones tasks may name.
  const savedMeeting = persistence?.saved;
  let restoredRoles: Scenario['roles'] | undefined;
  if (savedMeeting !== undefined) {
    // A malformed save must give the friendly message before its roles are derived from it.
    assertReadableSavedSetup(savedMeeting, fullScenario);
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
    assertReadableSavedMeeting(savedMeeting, { ...fullScenario, roles: validationRoles });
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
  const meeting = { id: savedMeeting?.meetingId ?? randomUUID() };
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
    // A started meeting keeps the sealed setup it ran with, in the order it was actually using.
    return meetingScenario({
      meetingTitle: sealed.title,
      roles: restoredRoles ?? fullScenario.roles,
      npcs: setupAiCast(fullScenario, sealed),
      agenda: meetingAgendaFromSetup(sealed, fullScenario, sealed.agenda.map((item) => item.title)),
      allowPlain: true,
    });
  }
  const initialScenario = bootScenario();
  const memory: MeetingMemoryEntry[] = [];
  const rejoin = createRejoinGuard({ graceMs: rejoinGraceMs ?? rejoinGraceMsFromEnv() });
  const reservations = createSeatReservations(admissionReservationMs);
  const admit = createAdmissionQueue();
  // The pack owns the reserved names for the whole meeting, whatever cast is active right now.
  const packNpcNames = (fullScenario.npcs ?? []).map((npc) => npc.attendee.toLowerCase());
  let watchedRoom: string | undefined;
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
  const roomPoll = createRoomPoll({
    guard: rejoin,
    // Someone joined (even before Start), or the meeting is running: keep watching the room.
    hasMeeting: () =>
      !session.abandoned() && (session.holders().length > 0 || session.phase() === 'running'),
    roster: roomRoster,
    roomName: () => watchedRoom,
    isHuman: (name) => !packNpcNames.includes(name.toLowerCase()),
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
  const server = createServer((request, response) => {
    void handleRequest(request, response, { hub, tasks, memory, fullScenario, pickedAgenda, devRoutes, auth, serviceToken, routes, calendar, calendarFetch, actionTools, roomRoster, meetingCode, meetingCodeAttempts, rejoin, meeting, session, startMeeting, reservations, admit, watchRoom, meetingElapsedSeconds, meetingAgendaIndex, meetingPaused, runnerStateChanged: () => publishRunnerState(), seating, visibleScenario, setupLocked, scheduleSave: () => persistence?.scheduleSave() });
  });
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
  const runnerMayUseAudience = (audience: string): boolean =>
    aiVoiceRoles().has(audience) && !isHumanSeat(audience);
  /** One WebSocket authorization path: the runner token first, then the same session principal as HTTP. */
  const authorizeUpgrade = async (
    request: IncomingMessage,
    audience: ClientAudience,
  ): Promise<Awaited<ReturnType<Auth['authorize']>>> => {
    const runnerRequest =
      serviceTokenConfigured && tokenMatches(bearerToken(request), serviceToken ?? '');
    // A configured service token always gates the service channel, even when user sign-in is off.
    if (audience === 'service') {
      if (serviceTokenConfigured) {
        return runnerRequest
          ? { ok: true, runner: true, principal: { kind: 'service' } }
          : { ok: false, message: 'Service sign-in required' };
      }
      // No credential configured: only a direct local peer may use the service channel.
      if (auth === undefined) return isLoopbackAddress(request.socket.remoteAddress)
        ? { ok: true, principal: { kind: 'service' } }
        : { ok: false, message: 'Service sign-in required' };
      return auth.authorize(request, audience);
    }
    if (runnerRequest) {
      if (audience === 'screen') {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      if (audience === 'lifecycle') {
        return { ok: false, message: 'The AI runner does not follow the lifecycle feed' };
      }
      if (runnerMayUseAudience(audience)) {
        return { ok: true, runner: true, principal: { kind: 'service' } };
      }
      return { ok: false, message: 'The AI runner may not act as a human seat' };
    }
    if (auth === undefined) return { ok: true };
    return auth.authorize(request, audience);
  };
  const hub = createHub(server, () => session.active(), {
    authorize: authorizeUpgrade,
    closeUnknownRoleAfterUpgrade: auth === undefined && !serviceTokenConfigured,
    isHumanSeat,
  });
  auth?.bindMeetingIdentity(() => meeting.id);
  auth?.bindOfferedSeats(() => joinSeatRoles(visibleScenario()).map((role) => role.id));
  auth?.onSessionEnded((sessionTokenHash) => hub.endSession?.(sessionTokenHash));
  const tasks = createTaskStore({ hub, scenario: () => session.active() });
  hub.onCommand(tasks.handleCommand);

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

  function waitForRunner(attempt: string, meetingId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        runnerWaiters.delete(attempt);
        reject(new Error('no acknowledgement from the AI attendees'));
      }, Math.max(1, startAckTimeoutMs));
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
    // Host screen/lifecycle feeds stay; the runner's own sockets stay.
    if (auth !== undefined || !meetingCode.fixed) hub.endRoleSessions?.(MEETING_ENDED_MESSAGE);
    void auth?.releaseMeeting(previousMeetingId);
    cancelPendingStart('the meeting was reset while it was starting');
    meeting.id = randomUUID();
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
    persistence,
  });
  // The task store belongs to the meeting, so a reset forgets its cards too. The session clears
  // every retained key (including 'task:') after these hooks run.
  session.onReset(() => {
    tasks.reset();
    roomPoll.reset();
  });

  // The AI runner reads exactly this snapshot, through the service-only endpoint and RUNNER_STATE.
  // Its version moves only when a field a runner can see changes, so a reconnect can fence old reads.
  // The version is a server-incarnation fence: `epoch` is made once for this process, ordered by the
  // boot time and identified by a random id, and `seq` only increases across every meeting. A
  // restarted server therefore starts a newer epoch instead of having to continue a persisted
  // revision it may never have managed to save.
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
  hub.subscribe((event) => {
    if (event.type === 'MEETING_RESET') {
      // A reset always yields a newer snapshot, even when it keeps the meeting id and every visible
      // field (the runner cleared its copy and must be able to adopt the republished version).
      runnerStateSignature = undefined;
      publishRunnerState();
      return;
    }
    if (event.type === 'MEETING_STARTED' || event.type === 'MEETING_RECORD_UPDATED') {
      publishRunnerState();
    }
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
    const roomName = watchedRoom ?? demoRoomName(session.active());
    void roomRoster(roomName)
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
        const humans = roster.filter((person) => !packNpcNames.includes(person.name.toLowerCase()));
        if (humans.length > 0) {
          // The poll lagged: someone is still there, so keep the meeting open.
          rejoin.occupied();
          return;
        }
        // A token was just issued but LiveKit has not shown the person yet: keep their seat.
        if (reservations.active(roster.map((person) => person.name)).length > 0) return;
        session.pruneHolders();
        publishRunnerState();
        if (session.phase() === 'running') session.abandon();
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
    watchedRoom = demoRoomName(session.active());
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
    return {
      // The live view keeps its title and cast; its roles and offered seats follow the owner's setup,
      // so a renamed or newly added role is shown (and admitted) by its canonical id.
      scenario: { ...active, roles: setupScenarioRoles(fullScenario, setup), joinSeats },
      admissionScenario: scenarioFromSetup(setup),
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

  /** True when the sealed meeting carries no demo-pack content, so its facts must stay out of it. */
  function packFree(): boolean {
    const setup = session.sealed();
    return setup !== undefined && isPackFreeMeeting(setup, fullScenario);
  }

  /**
   * The setup an untouched draft seals: the meeting admission already shaped (its active agenda and
   * the admitted person's seat), not the full pack. The owner's pack title, roles and pace still apply.
   */
  function untouchedSetup(): MeetingSetup {
    const agenda: MeetingSetup['agenda'] = session.active().agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: item.ownerRole,
    }));
    const humanSeat = holderPersonSeat();
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
  }: {
    attempt: string;
    meetingId: string;
    generation: number;
    activeAi: boolean;
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
          if (
            hub.requestStart?.({
              requestId: attempt,
              attempt,
              meetingId,
              startedAt,
              agendaIndex: 0,
              resumed: false,
            }) !== true
          ) {
            return failed(
              {
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
          try {
            await waitForRunner(attempt, meetingId);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // A reset cancels the waiter on purpose: say that, instead of blaming the runner.
            if (meeting.id !== meetingId || session.generation() !== generation || session.phase() !== 'starting') {
              console.warn(`[start] meeting ${meetingId} was reset while it was starting: ${reason}`);
              return resetDuringStart();
            }
            console.warn(`[start] the AI attendees did not prepare the meeting: ${reason}`);
            return failed(
              {
                status: 503,
                body: {
                  error: 'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
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

  function startTimeoutOutcome(): StartOutcome {
    return {
      status: 503,
      body: {
        error: 'The AI attendees did not open the meeting. Check that npm run npc is running, then try again.',
        retryable: true,
      },
    };
  }

  function startMeeting(): Promise<StartOutcome> {
    // The meeting this Start was requested for: a reset while it waits for the admission queue must
    // refuse it rather than let it start the replacement meeting.
    const requestedMeetingId = meeting.id;
    const requestedGeneration = session.generation();
    // The one Start timeout covers the queue wait as well as the runner acknowledgement. A Start
    // still waiting when it expires never runs later.
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
    const queued = admit(
      async (): Promise<StartOutcome | (() => Promise<StartOutcome>)> => {
        if (cancelled) return startTimeoutOutcome();
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
        // Re-validate the whole draft before anything is applied or the runner is asked, so a bad edit
        // made outside the setup screen fails Start loudly and leaves the meeting untouched.
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
        const sealed = session.draftTouched() ? parsed.value : untouchedSetup();
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
        const roleIds = new Set(sealed.roles.map((role) => role.id));
        const missingRoles = fullScenario.attendees
          .filter((attendee) => !roleIds.has(attendee.role))
          .map((attendee) => attendee.role);
        if (missingRoles.length > 0) {
          return {
            status: 422,
            body: {
              error: 'The meeting setup is not valid, so the meeting was not started. Fix the setup and try again.',
              errors: [
                { field: 'roles', message: `Every seat's role must remain: ${[...new Set(missingRoles)].join(', ')}.` },
              ],
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
        const candidate = derived.scenario;
        const activeAi = (candidate.npcs ?? []).length > 0;
        const attempt = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const meetingId = requestedMeetingId;
        const generation = requestedGeneration;
        session.beginStart(candidate, sealed);
        return () => runStart({ attempt, meetingId, generation, activeAi });
      },
    ).then((result) => (typeof result === 'function' ? result() : result));
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
      } catch (error) {
        closeRejoin();
        hub.close();
        await closeAuth();
        await closePersistence();
        throw error;
      }
    }
  }
  async function closeAuth(): Promise<void> {
    if (auth === undefined) return;
    await auth.close().catch((error: unknown) =>
      console.error('kaki server: the auth feature failed to stop', error),
    );
  }

  async function closePersistence(): Promise<void> {
    if (persistence === undefined) return;
    await persistence.close().catch((error: unknown) =>
      console.error('kaki server: the meeting persistence failed to stop', error),
    );
  }

  try {
    await listen(server, port, host);
  } catch (error) {
    closeRejoin();
    hub.close();
    await closeServer(server).catch(() => undefined);
    await closeAuth();
    await closePersistence();
    throw error;
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
        persistence,
        meetingId: () => meeting.id,
        resetMeeting: (options) => session.reset(options),
        onReset: session.onReset,
        session,
        packFree,
        meetingDetails: () => session.snapshot(),
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
      hub.close();
      await closeServer(server);
      await closeAuth();
      await closePersistence();
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
  // Keep the runner snapshot available to a runner that starts after the server (and before Start).
  publishRunnerState();

  let closed = false;

  return {
    server,
    hub,
    tasks,
    session,
    memory,
    routes,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (error) {
          console.error('kaki server: a module failed to stop', error);
        }
      }
      closeRejoin();
      hub.close();
      await closeServer(server);
      await closeAuth();
      await closePersistence();
    },
  };
}
