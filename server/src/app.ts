import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { codeProblem, humanAttendeeForRole, isKakiEvent, isMeetingMemoryEntries, isSuggestInput, resolveAgendaPick, seatProblem, setMeetingAgenda, shuffleAgendaForRole, type MeetingMemoryEntry, type Scenario, type Task } from '@kaki/shared';
import { assertReadableSavedMeeting, resolveSavedAgenda } from './persist/state';
import { viewEvent, type CalendarSettings } from './action/calendar';
import type { Auth } from './auth/module';
import { CommandError, createHub, type Hub } from './hub';
import { resolveJoinBaseUrl } from './joinInfo';
import type { KakiModule } from './modules';
import type { MeetingPersistence } from './persist/persistence';
import { createMeetingCodeSource, MEETING_ENDED_MESSAGE, type MeetingCodeSource } from './meetingCode';
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
  roomRoster: RoomRoster;
  /** The one code the second person and phone sign-in need; renewed with the meeting (or fixed by KAKI_MEETING_CODE). */
  meetingCode: MeetingCodeSource;
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
}

const MAX_BODY_BYTES = 1_000_000;

type JsonBody = { ok: true; value: unknown } | { ok: false; status: number; error: string };

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
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
      const seat = humanAttendeeForRole(context.scenario, wantedRole);
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
          const npcNames = (context.scenario.npcs ?? []).map((npc) => npc.attendee);
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
          const problem = seatProblem(context.scenario, present, seatId, maxHumans);
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
            if (npcNames.length > 0 && context.fullScenario.agenda.length > 1) {
              const maxAgendaItems = Number(process.env.KAKI_AGENDA_ITEMS) || 2;
              const reordered = context.pickedAgenda ?? shuffleAgendaForRole(
                context.fullScenario,
                seatId,
                Math.random,
                maxAgendaItems,
              );
              setMeetingAgenda(context.scenario, context.fullScenario, reordered);
            }
            context.hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId } });
          }
          const codeError = codeProblem(present.length, context.meetingCode.value, typeof join.meetingCode === 'string' ? join.meetingCode : undefined);
          if (codeError !== undefined) {
            sendJson(response, 403, { error: codeError, needsCode: true });
            return;
          }
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
      sendJson(response, 200, context.scenario);
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
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  const pickedAgenda = agendaPick ? resolveAgendaPick(scenario, agendaPick) : undefined;
  const fullScenario = { ...scenario, agenda: [...scenario.agenda] };
  // Validate the whole saved meeting before any part of it is applied, then put its agenda back in
  // place so the restored agenda index still names the topic the room was discussing.
  const savedMeeting = persistence?.saved;
  if (savedMeeting !== undefined) {
    assertReadableSavedMeeting(savedMeeting, scenario);
    setMeetingAgenda(scenario, fullScenario, resolveSavedAgenda(savedMeeting, scenario));
  }
  // A meeting saved while it was running is already started: the first person back joins it directly.
  const restoredStarted = savedMeeting?.state.clock.started === true && savedMeeting.state.clock.ended !== true;
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
  const reservations = createSeatReservations(admissionReservationMs);
  const admit = createAdmissionQueue();
  const npcNames = (scenario.npcs ?? []).map((npc) => npc.attendee.toLowerCase());
  let watchedRoom: string | undefined;
  const roomPoll = createRoomPoll({
    guard: rejoin,
    roster: roomRoster,
    roomName: () => watchedRoom,
    isHuman: (name) => !npcNames.includes(name.toLowerCase()),
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
    void handleRequest(request, response, { hub, tasks, memory, scenario, fullScenario, pickedAgenda, devRoutes, auth, calendar, roomRoster, meetingCode, rejoin, meeting, rotateMeeting, startMeeting, reservations, admit, watchRoom, meetingElapsedSeconds, meetingAgendaIndex });
  });
  const hub = createHub(server, scenario, {
    ...(auth === undefined ? {} : { authorize: auth.authorize }),
    ...(serviceToken === undefined || serviceToken === '' ? {} : { serviceToken }),
  });
  const tasks = createTaskStore({ hub, scenario });
  hub.onCommand(tasks.handleCommand);

  // The AI runner must confirm it prepared the meeting before Start succeeds. Without that
  // acknowledgement a guest would sit on "Starting..." forever while nobody speaks.
  const hasAi = (scenario.npcs?.length ?? 0) > 0;
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

  function startMeeting(): Promise<StartOutcome> {
    if (meeting.started) {
      return Promise.resolve({ status: 200, body: { started: true, alreadyStarted: true } });
    }
    // A Start for the same meeting joins the attempt already in flight. A new meeting never inherits it.
    if (starting !== undefined && starting.meetingId === meeting.id) return starting.promise;
    const attempt = `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const meetingId = meeting.id;
    const generation = meetingGeneration;
    const outcome = (async (): Promise<StartOutcome> => {
      const startedAt = new Date().toISOString();
      if (hasAi) {
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
          return {
            status: 503,
            body: {
              error:
                'The AI attendees are not connected, so the meeting cannot open yet. Start the runner with npm run npc, then try again.',
              retryable: true,
            },
          };
        }
        try {
          await waitForRunner(attempt, meetingId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[start] the AI attendees did not prepare the meeting: ${reason}`);
          return {
            status: 503,
            body: {
              error: `The AI attendees did not open the meeting (${reason}). Check that npm run npc is running, then try again.`,
              retryable: true,
            },
          };
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
      // The owner may start before anyone joins (for example from setup); the first arrival carries it on.
      if (!rejoin.hasMeeting()) rejoin.startedBeforeAnyoneJoined();
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
