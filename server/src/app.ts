import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { codeProblem, defaultMeetingSetup, demoPackNpcProfileIds, humanAttendeeForRole, isKakiEvent, isMeetingMemoryEntries, isSuggestInput, KOPITIAM_INVITE_UID, meetingAgendaFromSetup, parseMeetingInvite, parseMeetingSetup, resolveAgendaPick, seatProblem, setMeetingAgenda, setupAiCast, setupScenarioRoles, shuffleAgendaForRole, type MeetingMemoryEntry, type MeetingSetup, type Scenario, type Task } from '@kaki/shared';
import { assertReadableSavedMeeting, assertReadableSavedSetup, resolveSavedAgenda } from './persist/state';
import { CALENDAR_CONFIG_MESSAGE, CalendarFetchError, fetchCalendarIcs, viewEvent, type CalendarSettings } from './action/calendar';
import { actionToolStatus, isActionToolKind, probeActionTool, type ActionToolOptions } from './action/tools';
import type { Auth } from './auth/module';
import { createAttemptLimiter, type AttemptLimiter } from './attemptLimiter';
import { CommandError, createHub, type Hub } from './hub';
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
import { createRejoinGuard, createRoomPoll, rejoinGraceMsFromEnv, type RejoinGuard } from './rejoin';
import { createTaskStore, type TaskStore } from './tasks';
import { ADMISSION_RESERVATION_MS, createAdmissionQueue, createRoomToken, createSeatReservations, JoinError, livekitPublicUrl, livekitRoster, type RoomRoster, type SeatReservations } from './livekit';

/** Options for creating the Kaki server; port 0 picks a free port for tests. */
export interface CreateAppOptions {
  port?: number;
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
  /** Keeps the meeting, notetaker and tasks across a restart; absent means memory only. */
  persistence?: MeetingPersistence;
  /** How long an empty meeting is kept for the same person to return; defaults to KAKI_REJOIN_GRACE_MS or 2 minutes. */
  rejoinGraceMs?: number;
  /** How often the app server checks who is in the room; defaults to 5 seconds. */
  rejoinPollMs?: number;
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
  memory: readonly MeetingMemoryEntry[];
  close(): Promise<void>;
}

interface RequestContext {
  hub: Hub;
  tasks: TaskStore;
  memory: MeetingMemoryEntry[];
  scenario: Scenario;
  fullScenario: Scenario;
  /** A fixed agenda order from KAKI_AGENDA_PICK, used instead of the random draw. */
  pickedAgenda?: Scenario['agenda'];
  devRoutes: boolean;
  auth?: Auth;
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
  /** The one server-owned lifecycle state: the meeting's identity and whether it has started. */
  meeting: { id: string; started: boolean; startedAt?: string };
  /** Start a new meeting identity; returns it for the MEETING_RESET payload and cancels any Start in flight. */
  rotateMeeting(options?: { rotateCode?: boolean }): string;
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
  /** The pre-Start setup draft; saved with the meeting and reset with it. */
  setupDraft: { current: MeetingSetup };
  /** The setup Start sealed for this meeting; separate from the draft until the meeting resets. */
  sealedSetup: { current: MeetingSetup | undefined };
  /** Whether the owner changed the draft since the last reset; untouched drafts follow the live meeting. */
  draftTouched: { current: boolean };
  /**
   * The scenario people see, plus the one admission resolves seats against. An owner-edited draft
   * marks the person seats it names; otherwise both are the live meeting scenario.
   */
  seating(): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup };
  /** Shape an untouched draft's live agenda for the person in `seat`, or restore the pack order. */
  shapeUntouchedAgenda(seat: string | undefined): void;
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

/** The setup role a person names, by id or label. */
function setupRoleFor(setup: MeetingSetup, wanted: string): MeetingSetup['roles'][number] | undefined {
  const key = wanted.trim().toLowerCase();
  return setup.roles.find((role) => role.id.toLowerCase() === key || role.label.toLowerCase() === key);
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Dev routes are for this machine only: phones on the same Wi-Fi must not reach them. The Vite
 * proxy makes every request look local, so the raw URL must itself start with /dev/: a path like
 * /api/../dev/emit would otherwise be normalised into a dev route after it passed the /api proxy.
 */
function devRoutesOpen(request: IncomingMessage, context: { devRoutes: boolean }): boolean {
  return (
    context.devRoutes &&
    LOOPBACK.has(request.socket.remoteAddress ?? '') &&
    (request.url ?? '').startsWith('/dev/')
  );
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
  if (mmUrl) {
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
          body: JSON.stringify({ login_id: loginId, password: process.env.MATTERMOST_PASSWORD || 'demo' }),
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
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'POST' && path === '/api/livekit/token') {
      const codeIp = request.socket.remoteAddress ?? 'unknown';
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
        typeof join.roomName !== 'string' ||
        typeof join.participantName !== 'string' ||
        (join.participantRole !== undefined && typeof join.participantRole !== 'string')
      ) {
        sendJson(response, 400, { error: 'roomName and participantName are required' });
        return;
      }
      const roomName = join.roomName;
      const participantName = join.participantName.trim();
      const wantedRole = typeof join.participantRole === 'string' ? join.participantRole.trim() : '';
      if (wantedRole.length === 0) {
        sendJson(response, 400, { error: 'participantRole is required: pick the seat you are taking.' });
        return;
      }
      // An owner-edited draft admits only the person seats it names; an untouched draft stays open.
      const seating = context.seating();
      const setupRole = seating.setup === undefined ? undefined : setupRoleFor(seating.setup, wantedRole);
      if (seating.setup !== undefined) {
        const isPersonSeat =
          setupRole !== undefined &&
          seating.setup.seats.some((candidate) => candidate.kind === 'person' && candidate.roleId === setupRole.id);
        if (!isPersonSeat) {
          sendJson(response, 409, {
            error: `This meeting's setup has no place for ${setupRole?.label ?? wantedRole}; the owner set the seats.`,
          });
          return;
        }
      }
      const seat = humanAttendeeForRole(seating.admissionScenario, wantedRole);
      if (seat === undefined) {
        sendJson(response, 400, {
          error: `"${wantedRole}" is not a human seat in this meeting. Pick one of the roles offered when you join.`,
        });
        return;
      }
      // The canonical role id is what the roster and transcript use, whatever the person typed.
      const seatId = seat.role;
      try {
        await context.admit(async () => {
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
          const requestedMax = Number(process.env.NPC_MAX_HUMANS);
          const maxHumans = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : undefined;
          const problem = seatProblem(seating.admissionScenario, present, seatId, maxHumans);
          if (problem !== undefined) {
            sendJson(response, 409, { error: problem });
            return;
          }
          // The first person into an empty room starts a new meeting with a new code; later people must know it.
          // A person returning within the grace window keeps the meeting, its code, agenda, tasks and NPC conversation;
          // a different person arriving in that empty room starts a fresh meeting instead.
          const meetingWasRunning = context.rejoin.hasBegun() || context.meeting.started;
          const meetingExisted = context.rejoin.hasMeeting() || context.meeting.started;
          const rejoin = present.length === 0 ? context.rejoin.admit(participantName, seatId) : undefined;
          if (rejoin?.reset === true) {
            // The first arrival starts this app's first meeting; the code it already shows stays valid.
            const meetingId = context.rotateMeeting({ rotateCode: meetingExisted });
            context.tasks.reset();
            context.hub.clearRetained('meeting:started');
            context.hub.clearRetained('record');
            context.hub.clearRetained('host:opening');
            context.hub.clearRetained('fact:');
            context.hub.clearRetained('nudge:');
            context.hub.clearRetained('meeting:restored');
            // The reset puts the whole pack back first; an untouched draft is then shaped for the visitor.
            context.hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId } });
            if (!context.draftTouched.current) context.shapeUntouchedAgenda(seatId);
          }
          const codeError = codeProblem(present.length, context.meetingCode.value, typeof join.meetingCode === 'string' ? join.meetingCode : undefined);
          if (codeError !== undefined) {
            context.meetingCodeAttempts.recordFailure(codeIp);
            sendJson(response, 403, { error: codeError, needsCode: true });
            return;
          }
          context.meetingCodeAttempts.clear(codeIp);
          if (present.some((person) => person.name.toLowerCase() === joiningName)) {
            sendJson(response, 409, {
              error: `"${participantName}" is already in the meeting. Pick another name.`,
            });
            return;
          }
          const token = await createRoomToken(
            { roomName: roomName, participantName, participantRole: seatId },
            npcNames,
          );
          context.reservations.add({ participantName, seatId });
          if (rejoin !== undefined) context.rejoin.joined(participantName, rejoin, seatId);
          else context.rejoin.remember(participantName, seatId);
          // Seat holders are part of the meeting: save them so a restart recognises the same people.
          context.scheduleSave();
          context.watchRoom(roomName);
          void syncDemoVisitorProfile(participantName);
          const resumed = meetingWasRunning && rejoin?.reset !== true;
          const started = context.meeting.started;
          console.log(`[join] ${participantName} (${seatId}) room=${roomName} reset=${rejoin?.reset === true} resumed=${resumed} started=${started}`);
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

    // The authoritative lifecycle state, for a browser that reconnects after a reset or a restart.
    if (request.method === 'GET' && path === '/api/meeting/state') {
      const agendaIndex = context.meetingAgendaIndex?.();
      sendJson(response, 200, {
        meetingId: context.meeting.id,
        started: context.meeting.started,
        ...(context.meeting.startedAt === undefined ? {} : { startedAt: context.meeting.startedAt }),
        ...(agendaIndex === undefined ? {} : { agendaIndex }),
      });
      return;
    }

    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && path === '/api/mattermost/open') {
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const rawTarget = query.get('url')?.trim() ?? '';
      let parsedTarget: URL;
      try {
        parsedTarget = new URL(rawTarget);
      } catch {
        sendJson(response, 400, { error: 'Valid target url is required' });
        return;
      }
      if (
        (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') ||
        (parsedTarget.port !== '8083' &&
          !parsedTarget.pathname.includes('/nanyang-kopitiam/') &&
          !parsedTarget.pathname.includes('/kopitiam/'))
      ) {
        sendJson(response, 400, { error: 'Target must be a Mattermost link' });
        return;
      }
      const mmUrl = (process.env.MATTERMOST_URL?.trim() || 'http://127.0.0.1:8083').replace(/\/+$/, '');
      const setCookies: string[] = [];
      try {
        let loginResp: Response | undefined;
        for (const loginId of ['demo@nanyangkopitiam.example', 'demo']) {
          const resp = await fetch(`${mmUrl}/api/v4/users/login`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-requested-with': 'XMLHttpRequest',
            },
            body: JSON.stringify({ login_id: loginId, password: process.env.MATTERMOST_PASSWORD || 'demo' }),
          });
          if (resp.ok) {
            loginResp = resp;
            break;
          }
        }
        if (loginResp?.ok) {
          const rawCookies = loginResp.headers.getSetCookie?.() ?? [];
          for (const cookie of rawCookies) {
            setCookies.push(cookie.replace(/;\s*Secure/gi, ''));
          }
          if (setCookies.length === 0) {
            const sessionToken = loginResp.headers.get('Token');
            const userObj = (await loginResp.json().catch(() => undefined)) as { id?: string } | undefined;
            if (sessionToken) {
              setCookies.push(`MMAUTHTOKEN=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
              setCookies.push(`MMCSRF=${sessionToken}; Path=/; Max-Age=2592000; SameSite=Lax`);
            }
            if (userObj?.id) {
              setCookies.push(`MMUSERID=${userObj.id}; Path=/; Max-Age=2592000; SameSite=Lax`);
            }
          }
        }
      } catch {
        // Proceed with redirect even if auto-login fails.
      }
      response.writeHead(302, {
        Location: parsedTarget.toString(),
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

    if (request.method === 'GET' && path === '/api/scenario') {
      sendJson(response, 200, context.seating().scenario);
      return;
    }

    if (request.method === 'GET' && path === '/api/setup') {
      if (context.auth !== undefined && (await context.auth.sessionKind(request)) === undefined) {
        sendJson(response, 401, { error: 'Sign in to see the meeting setup.', authEnabled: true });
        return;
      }
      sendJson(response, 200, {
        setup: context.sealedSetup.current ?? context.setupDraft.current,
        started: context.meeting.started,
      });
      return;
    }

    if (request.method === 'GET' && path === '/api/setup/tools') {
      if (context.auth !== undefined && (await context.auth.sessionKind(request)) !== 'host') {
        sendJson(response, 403, { error: 'Only the meeting owner can check the tools.' });
        return;
      }
      sendJson(response, 200, { tools: actionToolStatus(context.actionTools.env) });
      return;
    }

    const toolTestMatch = /^\/api\/setup\/tools\/([^/]+)\/test$/.exec(path);
    if (request.method === 'POST' && toolTestMatch !== null) {
      if (context.auth !== undefined && (await context.auth.sessionKind(request)) !== 'host') {
        sendJson(response, 403, { error: 'Only the meeting owner can test the tools.' });
        return;
      }
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
      if (context.auth !== undefined && (await context.auth.sessionKind(request)) !== 'host') {
        sendJson(response, 403, { error: 'Only the meeting owner can change the setup.' });
        return;
      }
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
      context.setupDraft.current = parsed.value;
      context.draftTouched.current = true;
      // An ended meeting's saved seal is now superseded by the owner's fresh draft.
      context.sealedSetup.current = undefined;
      context.scheduleSave();
      sendJson(response, 200, { setup: parsed.value, started: false });
      return;
    }

    if (request.method === 'POST' && path === '/api/setup/import-calendar') {
      // Only the meeting owner edits setup; everyone else gets the read-only join view.
      if (context.auth !== undefined && (await context.auth.sessionKind(request)) !== 'host') {
        sendJson(response, 403, { error: 'Only the meeting owner can change the setup.' });
        return;
      }
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

      context.setupDraft.current = parsed.value;
      context.draftTouched.current = true;
      // An ended meeting's saved seal is now superseded by the owner's fresh draft.
      context.sealedSetup.current = undefined;
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

    if (request.method === 'POST' && path === '/dev/emit' && devRoutesOpen(request, context)) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isKakiEvent(body.value, context.scenario)) {
        sendJson(response, 400, { error: 'Body must be a valid KakiEvent' });
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

    if (request.method === 'POST' && path === '/dev/suggest-task' && devRoutesOpen(request, context)) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isSuggestInput(body.value, context.scenario)) {
        sendJson(response, 400, { error: 'Body must be a valid task suggestion' });
        return;
      }
      sendJson(response, 200, context.tasks.suggest(body.value));
      return;
    }

    if (request.method === 'POST' && path === '/dev/meeting-memory' && devRoutesOpen(request, context)) {
      const body = await readJsonBody(request);
      if (!body.ok) { sendJson(response, body.status, { error: body.error }); return; }
      if (!isMeetingMemoryEntries(body.value, context.scenario.agenda.map((item) => item.title))) {
        sendJson(response, 400, { error: 'Invalid meeting memory' }); return;
      }
      context.memory.splice(0, context.memory.length, ...body.value);
      sendJson(response, 200, { ok: true });
      return;
    }

    // The live demo's engine locked the visitor's decision on an agenda item: create its follow-up and release
    // whatever was held for that item, in one request so the two can never disagree.
    if (request.method === 'POST' && path === '/dev/settle-topic' && devRoutesOpen(request, context)) {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (!isSuggestInput(body.value, context.scenario)) {
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

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
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
  persistence,
  rejoinGraceMs,
  rejoinPollMs,
  admissionReservationMs = ADMISSION_RESERVATION_MS,
  startAckTimeoutMs = 6_000,
  serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim(),
  meetingCode: meetingCodeOption,
}: CreateAppOptions): Promise<KakiApp> {
  const meetingCode = meetingCodeOption ?? createMeetingCodeSource();
  const meetingCodeAttempts =
    auth?.meetingCodeLimiter ??
    createAttemptLimiter({
      limit: MEETING_CODE_FAILURE_LIMIT,
      windowMs: MEETING_CODE_WINDOW_MS,
    });
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  const pickedAgenda = agendaPick ? resolveAgendaPick(scenario, agendaPick) : undefined;
  const fullScenario = {
    ...scenario,
    agenda: [...scenario.agenda],
    roles: [...scenario.roles],
    attendees: [...scenario.attendees],
    npcs: [...(scenario.npcs ?? [])],
  };
  // The draft the setup screen starts from, rebuilt from the packaged scenario for every new meeting.
  const defaultSetup = defaultMeetingSetup(fullScenario);
  // Validate the whole saved meeting before any part of it is applied, then put its agenda back in
  // place so the restored agenda index still names the topic the room was discussing.
  const savedMeeting = persistence?.saved;
  // A saved meeting that had started keeps the sealed setup it ran with, even once it has ended.
  let restoredApplied = false;
  let savedEnded = false;
  let restoredRoles: Scenario['roles'] | undefined;
  if (savedMeeting !== undefined) {
    // A malformed save must give the friendly message before its roles are derived from it.
    assertReadableSavedSetup(savedMeeting, fullScenario);
    const savedClock = (savedMeeting.state as { clock?: { started?: unknown; ended?: unknown } }).clock;
    restoredApplied = savedClock?.started === true;
    savedEnded = savedClock?.ended === true;
    restoredRoles = restoredApplied ? setupScenarioRoles(fullScenario, savedMeeting.setup) : undefined;
    // Tasks and talk time may name a role the owner added, so validate against both registries.
    const validationRoles =
      restoredRoles === undefined
        ? scenario.roles
        : [
            ...scenario.roles,
            ...restoredRoles.filter((role) => !scenario.roles.some((packRole) => packRole.id === role.id)),
          ];
    assertReadableSavedMeeting(savedMeeting, { ...scenario, roles: validationRoles });
    if (restoredApplied) {
      // A started meeting keeps the sealed setup it ran with, in the order it was actually using.
      if (restoredRoles !== undefined) scenario.roles = restoredRoles;
      scenario.meetingTitle = savedMeeting.setup.title;
      setMeetingAgenda(
        scenario,
        fullScenario,
        meetingAgendaFromSetup(savedMeeting.setup, fullScenario, savedMeeting.state.agenda),
        { allowPlain: true },
      );
      scenario.npcs = setupAiCast(fullScenario, savedMeeting.setup);
    } else {
      setMeetingAgenda(scenario, fullScenario, resolveSavedAgenda(savedMeeting, scenario));
    }
    if (meetingCode.fixed) {
      if (savedMeeting.meetingCode !== meetingCode.value) {
        console.log('kaki persist: KAKI_MEETING_CODE replaced the saved meeting code');
      }
    } else {
      meetingCode.restore(savedMeeting.meetingCode);
    }
  }
  // A meeting saved while it was running is already started: the first person back joins it directly.
  const restoredStarted = restoredApplied && !savedEnded;
  // A pre-Start setup draft comes back exactly as it was left; a new meeting starts from the pack.
  const setupDraft = { current: savedMeeting?.setup ?? defaultSetup };
  // The sealed setup is what the running meeting actually uses; it stays apart from the draft.
  const sealedSetup = { current: restoredApplied ? savedMeeting?.setup : undefined };
  // A started meeting's sealed setup is effectively owner-shaped; a pre-Start draft keeps its edit mark.
  const draftTouched = { current: restoredApplied ? true : savedMeeting?.draftTouched === true };
  const restoredAgendaIndex = restoredStarted ? (savedMeeting?.state.clock.agendaIndex ?? 0) : 0;
  const meeting = {
    id: savedMeeting?.state.meetingId ?? randomUUID(),
    started: restoredStarted,
    startedAt: restoredStarted ? savedMeeting?.startedAt : undefined,
  };
  /** Bumped whenever the meeting identity changes, so an acknowledgement for the old one can be refused. */
  let meetingGeneration = 0;
  const memory: MeetingMemoryEntry[] = [];
  const rejoin = createRejoinGuard({ graceMs: rejoinGraceMs ?? rejoinGraceMsFromEnv() });
  // Saved seat holders are known before anyone reconnects, so a stranger cannot take their seat.
  if (savedMeeting !== undefined) rejoin.restoreIdentities(savedMeeting.seats);
  const reservations = createSeatReservations(admissionReservationMs);
  const admit = createAdmissionQueue();
  // The pack owns the reserved names for the whole meeting, whatever cast is active right now.
  const packNpcNames = (fullScenario.npcs ?? []).map((npc) => npc.attendee.toLowerCase());
  let watchedRoom: string | undefined;
  const roomPoll = createRoomPoll({
    guard: rejoin,
    roster: roomRoster,
    roomName: () => watchedRoom,
    isHuman: (name) => !packNpcNames.includes(name.toLowerCase()),
    intervalMs: rejoinPollMs,
  });
  const watchRoom = (roomName: string): void => {
    watchedRoom = roomName;
    roomPoll.start();
  };
  const closeRejoin = (): void => {
    roomPoll.close();
    rejoin.close();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, { hub, tasks, memory, scenario, fullScenario, pickedAgenda, devRoutes, auth, calendar, calendarFetch, actionTools, roomRoster, meetingCode, meetingCodeAttempts, rejoin, meeting, rotateMeeting, startMeeting, reservations, admit, watchRoom, meetingElapsedSeconds, meetingAgendaIndex, setupDraft, sealedSetup, draftTouched, seating, shapeUntouchedAgenda, setupLocked, scheduleSave: () => persistence?.scheduleSave() });
  });
  const hub = createHub(server, scenario, {
    ...(auth === undefined ? {} : { authorize: auth.authorize }),
    ...(serviceToken === undefined || serviceToken === '' ? {} : { serviceToken }),
  });
  const tasks = createTaskStore({ hub, scenario });
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

  /** Start a new meeting identity; the reset event carries the id every client and runner must adopt. */
  function rotateMeeting({ rotateCode = true }: { rotateCode?: boolean } = {}): string {
    meetingGeneration += 1;
    if (rotateCode) {
      meetingCode.rotate();
      // The old code is gone, so its phone sessions cannot follow this meeting any more.
      if (!meetingCode.fixed) hub.endRoleSessions?.(MEETING_ENDED_MESSAGE);
    }
    cancelPendingStart('the meeting was reset while it was starting');
    meeting.id = randomUUID();
    meeting.started = false;
    meeting.startedAt = undefined;
    return meeting.id;
  }

  /** Setup writes are refused from the moment Start begins until it commits or fails. */
  function setupLocked(): 'starting' | 'started' | undefined {
    if (meeting.started) return 'started';
    if (starting !== undefined) return 'starting';
    return undefined;
  }

  /** The pre-Start agenda order while Start prepares, so a save cannot persist the sealed agenda early. */
  let preCommitStart: { agendaTitles: string[] } | undefined;

  function personSeatRoles(setup: MeetingSetup): string[] {
    return setup.seats.filter((seat) => seat.kind === 'person').map((seat) => seat.roleId);
  }

  /** The scenario an owner-edited setup describes, with its AI seats treated as AI-only. */
  function scenarioFromSetup(setup: MeetingSetup): Scenario {
    const agenda = meetingAgendaFromSetup(setup, fullScenario);
    const titles = new Set(agenda.map((item) => item.title));
    const pairs = fullScenario.excludedPairs?.filter(([left, right]) => titles.has(left) && titles.has(right));
    const base: Scenario = { ...fullScenario };
    delete base.excludedPairs;
    return {
      ...base,
      meetingTitle: setup.title,
      roles: setupScenarioRoles(fullScenario, setup),
      agenda,
      ...(pairs === undefined || pairs.length === 0 ? {} : { excludedPairs: pairs }),
      // An AI seat is never a human seat, even when the pack marks its character playable.
      npcs: setupAiCast(fullScenario, setup).map((npc) => ({ ...npc, playable: false })),
      joinSeats: personSeatRoles(setup),
    };
  }

  /**
   * The scenario people see, plus the one admission resolves seats against. An owner-edited draft
   * narrows the offered seats and, before Start, resolves seats against its own cast; an untouched
   * draft follows the live pack. Once started, the live scenario is already sealed.
   */
  function seating(): { scenario: Scenario; admissionScenario: Scenario; setup?: MeetingSetup } {
    if (!draftTouched.current) return { scenario, admissionScenario: scenario };
    const setup = sealedSetup.current ?? setupDraft.current;
    const sealed = sealedSetup.current !== undefined;
    return {
      // The live view keeps its title, roles and cast; only the seats people may join change.
      scenario: { ...scenario, joinSeats: personSeatRoles(setup) },
      admissionScenario: sealed ? scenario : scenarioFromSetup(setup),
      setup,
    };
  }

  /**
   * Shape an untouched draft's agenda for the person in `seat`: the role's two-topic pick, or the
   * pack order when nobody is seated or the scenario has no AI attendees.
   */
  function shapeUntouchedAgenda(seat: string | undefined): void {
    const hasAi = (fullScenario.npcs ?? []).length > 0;
    if (seat !== undefined && hasAi && fullScenario.agenda.length > 1) {
      const maxAgendaItems = Number(process.env.KAKI_AGENDA_ITEMS) || 2;
      const reordered = pickedAgenda ?? shuffleAgendaForRole(fullScenario, seat, Math.random, maxAgendaItems);
      setMeetingAgenda(scenario, fullScenario, reordered);
      return;
    }
    setMeetingAgenda(scenario, fullScenario, fullScenario.agenda);
  }

  /**
   * The setup an untouched draft seals: the meeting admission already shaped (its active agenda and
   * the admitted person's seat), not the full pack. The owner's pack title, roles and pace still apply.
   */
  function untouchedSetup(): MeetingSetup {
    const agenda: MeetingSetup['agenda'] = scenario.agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: item.ownerRole,
    }));
    const humanSeat = rejoin.identities().at(-1)?.seat;
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

  function startMeeting(): Promise<StartOutcome> {
    if (meeting.started) {
      return Promise.resolve({ status: 200, body: { started: true, alreadyStarted: true } });
    }
    // A Start for the same meeting joins the attempt already in flight. A new meeting never inherits it.
    if (starting !== undefined && starting.meetingId === meeting.id) return starting.promise;
    // Re-validate the whole draft before anything is applied or the runner is asked, so a bad edit
    // made outside the setup screen fails Start loudly and leaves the meeting untouched.
    const parsed = parseMeetingSetup(setupDraft.current, {
      npcProfileIds: demoPackNpcProfileIds(fullScenario),
    });
    if (!parsed.ok) {
      return Promise.resolve({
        status: 422,
        body: {
          error: 'The meeting setup is not valid, so the meeting was not started. Fix the setup and try again.',
          errors: parsed.errors,
        },
      });
    }
    // Start needs someone in the meeting: an owner cannot open an empty room.
    if (rejoin.identities().length === 0) {
      return Promise.resolve({ status: 409, body: { error: 'Join the meeting before pressing Start.' } });
    }
    // An untouched draft follows the live meeting; an owner-edited one is applied exactly as written.
    const sealed = draftTouched.current ? parsed.value : untouchedSetup();
    const roleIds = new Set(sealed.roles.map((role) => role.id));
    const missingRoles = fullScenario.attendees
      .filter((attendee) => !roleIds.has(attendee.role))
      .map((attendee) => attendee.role);
    if (missingRoles.length > 0) {
      return Promise.resolve({
        status: 422,
        body: {
          error: 'The meeting setup is not valid, so the meeting was not started. Fix the setup and try again.',
          errors: [{ field: 'roles', message: `Every seat's role must remain: ${[...new Set(missingRoles)].join(', ')}.` }],
        },
      });
    }
    // The active scenario exactly as it was, so a failed Start can put it back.
    const before = {
      title: scenario.meetingTitle,
      agenda: [...scenario.agenda],
      roles: [...scenario.roles],
      npcs: [...(scenario.npcs ?? [])],
      excludedPairs: scenario.excludedPairs?.map((pair) => [pair[0], pair[1]] as [string, string]),
    };
    // Until Start commits, the saved meeting is still the pre-Start draft in its old agenda order.
    preCommitStart = { agendaTitles: before.agenda.map((item) => item.title) };
    // Make the sealed setup the active meeting before the runner prepares: the clock, /api/scenario
    // and the runner's scenario re-read all see the same title, agenda, roles and cast.
    scenario.meetingTitle = sealed.title;
    scenario.roles = setupScenarioRoles(fullScenario, sealed);
    const activeCast = setupAiCast(fullScenario, sealed);
    setMeetingAgenda(scenario, fullScenario, meetingAgendaFromSetup(sealed, fullScenario), {
      allowPlain: true,
    });
    scenario.npcs = activeCast;
    const activeAi = activeCast.length > 0;
    const attempt = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const meetingId = meeting.id;
    const generation = meetingGeneration;
    /** Put the meeting back exactly as Start found it; a reset has already replaced it, so skip then. */
    const rollback = (): void => {
      if (meeting.id !== meetingId || meetingGeneration !== generation) return;
      preCommitStart = undefined;
      sealedSetup.current = undefined;
      scenario.meetingTitle = before.title;
      scenario.agenda.splice(0, scenario.agenda.length, ...before.agenda);
      scenario.roles = before.roles;
      scenario.npcs = before.npcs;
      if (before.excludedPairs === undefined) delete scenario.excludedPairs;
      else scenario.excludedPairs = before.excludedPairs.map((pair) => [pair[0], pair[1]]);
      persistence?.scheduleSave();
    };
    const failed = (outcome: StartOutcome): StartOutcome => {
      rollback();
      return outcome;
    };
    const outcome = (async (): Promise<StartOutcome> => {
      const startedAt = new Date().toISOString();
      try {
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
            return failed({
              status: 503,
              body: {
                error:
                  'The AI attendees are not connected, so the meeting cannot open yet. Start the runner with npm run npc, then try again.',
                retryable: true,
              },
            });
          }
          try {
            await waitForRunner(attempt, meetingId);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[start] the AI attendees did not prepare the meeting: ${reason}`);
            return failed({
              status: 503,
              body: {
                error: `The AI attendees did not open the meeting (${reason}). Check that npm run npc is running, then try again.`,
                retryable: true,
              },
            });
          }
        }
        // A reset during preparation must never let this old attempt start the replacement meeting.
        if (meeting.id !== meetingId || meetingGeneration !== generation) {
          console.warn(`[start] refused to start meeting ${meetingId}: the meeting changed while it was starting`);
          return {
            status: 503,
            body: {
              error: 'The meeting was reset while it was starting. Press Start again for the new meeting.',
              retryable: true,
            },
          };
        }
        if (meeting.started) {
          return { status: 200, body: { started: true, alreadyStarted: true } };
        }
        // A person is already admitted; a restored meeting with saved seats still needs its guard marked.
        if (!rejoin.hasMeeting()) rejoin.startedBeforeAnyoneJoined();
        // Start commits here: only now does the draft become the meeting's seal and the sealed
        // agenda become what a save may persist.
        sealedSetup.current = sealed;
        preCommitStart = undefined;
        meeting.started = true;
        meeting.startedAt = startedAt;
        rejoin.began();
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
        if (meeting.id === meetingId && meetingGeneration === generation) {
          rollback();
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
  hub.subscribe((event) => {
    if (event.type !== 'MEETING_RESET') return;
    // A publisher owned by the server rotates before publishing. Anything else (a module or a test)
    // still gets a coherent identity: adopt the id it announced and cancel any Start for the old meeting.
    if (event.payload.meetingId !== meeting.id) {
      meetingGeneration += 1;
      cancelPendingStart('the meeting was reset while it was starting');
      meeting.id = event.payload.meetingId;
      // A publisher that is not the server's own reset still starts a new meeting: rotate its code too.
      if (!meetingCode.fixed) {
        meetingCode.rotate();
        hub.endRoleSessions?.(MEETING_ENDED_MESSAGE);
      }
    }
    memory.splice(0);
    meeting.started = false;
    meeting.startedAt = undefined;
    // The reset ends the current meeting. Only a draft that a Start consumed is done with: an
    // owner-edited draft that no Start has used yet belongs to the next meeting and is kept.
    const consumed = sealedSetup.current !== undefined;
    preCommitStart = undefined;
    sealedSetup.current = undefined;
    if (consumed) {
      draftTouched.current = false;
      setupDraft.current = defaultSetup;
    }
    // A new meeting starts from the whole pack, then an untouched draft follows the seated visitor.
    scenario.meetingTitle = fullScenario.meetingTitle;
    scenario.roles = fullScenario.roles;
    scenario.npcs = fullScenario.npcs;
    if (draftTouched.current) {
      setMeetingAgenda(scenario, fullScenario, fullScenario.agenda);
    } else {
      shapeUntouchedAgenda(rejoin.identities().at(-1)?.seat);
    }
    hub.clearRetained('meeting:started');
    // A restored meeting that is replaced before anyone reconnects is gone; the next arrival starts fresh.
    rejoin.forgetRestored();
  });
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
        // A meeting that was still running is already in progress: someone coming back resumes it.
        if (persistence.saved.state.clock.started && !persistence.saved.state.clock.ended) rejoin.restored();
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
  hub.subscribe((event) => {
    // Only speech proves the meeting began; record heartbeats and task updates can fire without anyone talking.
    if (event.type === 'TRANSCRIPT_CHUNK' || event.type === 'HOST_SPEECH_TRIGGERED') rejoin.began();
    if (event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING') rejoin.ended();
  });

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
    await listen(server, port);
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
        scenario,
        memory,
        draftOnly,
        persistence,
        meetingId: () => meeting.id,
        resetMeetingIdentity: rotateMeeting,
        meetingDetails: () => ({
          // Until Start commits, the saved meeting is the draft in its pre-Start agenda order; only
          // then is the sealed setup and its agenda what a save may persist.
          setup: preCommitStart === undefined ? (sealedSetup.current ?? setupDraft.current) : setupDraft.current,
          draftTouched: draftTouched.current,
          ...(preCommitStart === undefined ? {} : { agendaTitles: preCommitStart.agendaTitles }),
          meetingCode: meetingCode.value,
          seats: rejoin.identities(),
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
  if (meeting.started && meeting.startedAt !== undefined) {
    hub.publish(
      {
        type: 'MEETING_STARTED',
        audience: { kind: 'all' },
        payload: {
          meetingId: meeting.id,
          startedAt: meeting.startedAt,
          agendaIndex: restoredAgendaIndex,
          resumed: true,
        },
      },
      { retainKey: 'meeting:started' },
    );
  }

  let closed = false;

  return {
    server,
    hub,
    tasks,
    memory,
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
