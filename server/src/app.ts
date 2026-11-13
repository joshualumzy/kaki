import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { codeProblem, DEFAULT_MAX_HUMANS, isKakiEvent, isMeetingMemoryEntries, isSuggestInput, newMeetingCode, resolveAgendaPick, seatProblem, setMeetingAgenda, shuffleAgendaForRole, type MeetingMemoryEntry, type Scenario, type Task } from '@kaki/shared';
import { viewEvent, type CalendarSettings } from './action/calendar';
import type { Auth } from './auth/module';
import { CommandError, createHub, type Hub } from './hub';
import { resolveJoinBaseUrl } from './joinInfo';
import type { KakiModule } from './modules';
import { createTaskStore, type TaskStore } from './tasks';
import { createRoomToken, JoinError, livekitPublicUrl, livekitRoster, type RoomRoster } from './livekit';

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
  /** The code the second and later people need to join; renewed whenever the room is empty (or fixed by KAKI_MEETING_CODE). */
  meetingCode: { value: string; fixed: boolean };
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
      try {
        const npcNames = (context.scenario.npcs ?? []).map((npc) => npc.attendee);
        const joiningName = join.participantName.trim().toLowerCase();
        const roster = await context.roomRoster(join.roomName);
        const present = (roster ?? []).filter(
          (person) => !npcNames.some((npc) => npc.toLowerCase() === person.name.toLowerCase()),
        );
        const maxHumans = Number(process.env.NPC_MAX_HUMANS) || DEFAULT_MAX_HUMANS;
        const problem = seatProblem(context.scenario, present, join.participantRole, maxHumans);
        if (problem !== undefined) {
          sendJson(response, 409, { error: problem });
          return;
        }
        // The first person into an empty room starts a new meeting with a new code; later people must know it.
        // If LiveKit cannot be asked, nobody can be told apart from an empty room, so the gate stays open.
        if (roster !== undefined) {
          if (present.length === 0) {
            if (!context.meetingCode.fixed) context.meetingCode.value = newMeetingCode();
            if (npcNames.length > 0 && context.fullScenario.agenda.length > 1) {
              context.tasks.reset();
              context.hub.clearRetained('record');
              context.hub.clearRetained('host:opening');
              context.hub.clearRetained('fact:');
              context.hub.clearRetained('nudge:');
              const maxAgendaItems = Number(process.env.KAKI_AGENDA_ITEMS) || 2;
              const reordered = context.pickedAgenda ?? shuffleAgendaForRole(
                context.fullScenario,
                join.participantRole,
                Math.random,
                maxAgendaItems,
              );
              setMeetingAgenda(context.scenario, context.fullScenario, reordered);
              context.hub.publish({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: {} });
            }
          }
          const codeError = codeProblem(present.length, context.meetingCode.value, typeof join.meetingCode === 'string' ? join.meetingCode : undefined);
          if (codeError !== undefined) {
            sendJson(response, 403, { error: codeError, needsCode: true });
            return;
          }
          if (present.some((person) => person.name.toLowerCase() === joiningName)) {
            sendJson(response, 409, {
              error: `"${join.participantName.trim()}" is already in the meeting. Pick another name.`,
            });
            return;
          }
        }
        const token = await createRoomToken(
          { roomName: join.roomName, participantName: join.participantName, participantRole: join.participantRole },
          npcNames,
        );
        void syncDemoVisitorProfile(join.participantName);
        sendJson(response, 200, { token, url: livekitPublicUrl(), meetingCode: context.meetingCode.value });
      } catch (error) {
        if (error instanceof JoinError) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        throw error;
      }
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
          ? context.tasks.suggest(followUp)
          : context.tasks.reviseSuggested(suggested[0].id, followUp));
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
}: CreateAppOptions): Promise<KakiApp> {
  const fixedCode = process.env.KAKI_MEETING_CODE?.trim();
  const meetingCode = { value: fixedCode || newMeetingCode(), fixed: Boolean(fixedCode) };
  const agendaPick = process.env.KAKI_AGENDA_PICK?.trim();
  const pickedAgenda = agendaPick ? resolveAgendaPick(scenario, agendaPick) : undefined;
  const fullScenario = { ...scenario, agenda: [...scenario.agenda] };
  const memory: MeetingMemoryEntry[] = [];
  const server = createServer((request, response) => {
    void handleRequest(request, response, { hub, tasks, memory, scenario, fullScenario, pickedAgenda, devRoutes, auth, calendar, roomRoster, meetingCode });
  });
  const hub = createHub(server, scenario, auth === undefined ? {} : { authorize: auth.authorize });
  const tasks = createTaskStore({ hub, scenario });
  hub.onCommand(tasks.handleCommand);
  hub.subscribe((event) => { if (event.type === 'MEETING_RESET') memory.splice(0); });

  async function closeAuth(): Promise<void> {
    if (auth === undefined) return;
    await auth.close().catch((error: unknown) =>
      console.error('kaki server: the auth feature failed to stop', error),
    );
  }

  try {
    await listen(server, port);
  } catch (error) {
    hub.close();
    await closeServer(server).catch(() => undefined);
    await closeAuth();
    throw error;
  }

  const cleanups: Array<() => void> = [];

  for (const feature of modules) {
    try {
      const stop = feature.start({ hub, tasks, scenario, memory, draftOnly });
      if (typeof stop === 'function') cleanups.push(stop);
    } catch (error) {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch (cleanupError) {
          console.error('kaki server: a module failed to stop after startup failed', cleanupError);
        }
      }
      hub.close();
      await closeServer(server);
      await closeAuth();
      throw new Error(
        `kaki server: module "${feature.name}" failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
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
      hub.close();
      await closeServer(server);
      await closeAuth();
    },
  };
}
