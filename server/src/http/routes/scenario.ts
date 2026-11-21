import { parseScenario, type Scenario } from '@kaki/shared';
import { viewEvent } from '../../action/calendar';
import { projectScenario } from '../../meeting/scenarioProjection';
import { publicUrlIsHttps } from '../access';
import { sendJson } from '../http';
import type { RouteCall } from '../routeCall';

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

/**
 * Hand a scenario to a client only if it parses. An invalid one is a server bug: log it loudly
 * and return undefined, so the caller decides what to refuse or fall back to — never silently
 * substituting another pack for the meeting people are actually in.
 */
function servableScenario(scenario: Scenario, label: string): Scenario | undefined {
  try {
    return parseScenario(scenario, { requireOrganisation: false });
  } catch (error) {
    console.error(`kaki scenario: ${label} is invalid; refusing to serve it`, error);
    return undefined;
  }
}

export async function handleScenario(call: RouteCall): Promise<void> {
  const { response, context, principal, url } = call;
  const requestedView = url.searchParams.get('kind');
  if (requestedView !== null && requestedView !== 'practice') {
    sendJson(response, 400, { error: "kind must be 'practice' when given." });
    return;
  }
  // The practice picker follows the pack, never the owner's real-meeting draft: practice
  // admission validates exactly these roles, so the two can never disagree. Everyone but the
  // owner also never sees an unopened draft: they get the pack until the room is opened, then
  // the plan frozen at that moment, and the sealed meeting once it is running.
  const active =
    requestedView === 'practice'
      ? context.session.kind() === 'practice'
        ? context.session.active()
        : context.fullScenario
      : context.auth === undefined
        ? context.visibleScenario(principal.kind === 'service')
        : principal.kind === 'host' || principal.kind === 'service'
          ? context.session.phase() === 'ended' && context.session.reviewingEndedTeamMeeting()
            ? // The owner is still reviewing the meeting that just ran: show that meeting, never
              // the next meeting's draft or the pack it was never built from.
              context.session.active()
            : context.visibleScenario(principal.kind === 'service')
          : context.session.kind() === 'practice'
            ? context.session.active()
            : context.session.phase() === 'running' || context.session.phase() === 'starting'
              ? context.visibleScenario(false)
              : context.publicScenario();
  // A seat holder sees that seat, whether a participant or the host playing it.
  const seat =
    principal.kind === 'seat'
      ? principal.role
      : principal.kind === 'host'
        ? principal.seat
        : principal.kind === 'practice'
          ? context.session.practiceSeat()
          : undefined;
  // With sign-in off the trusted demo keeps the whole scenario, as it always did.
  const visible =
    context.auth === undefined || principal.kind === 'service'
      ? active
      : projectScenario(active, seat);
  // A broken scenario is a server bug: refuse it (the browser shows its error card with a way
  // to setup) rather than serving an unprojected pack whose private fields would leak.
  const served = servableScenario(visible, 'the meeting scenario');
  if (served === undefined) {
    sendJson(response, 500, { error: 'The meeting scenario is broken; the owner must fix the setup.' });
    return;
  }
  sendJson(response, 200, served);
  return;
}

export async function handleScenarioFull(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // The runner prepares the sealed candidate while Start is in flight; everyone else sees the live one.
  const phase = context.session.phase();
  const active =
    phase === 'starting'
      ? context.session.candidate() ?? context.session.active()
      : phase === 'running'
        ? context.session.active()
        : context.seating().scenario;
  // The runner keeps the room alive on the pack if the live scenario broke; it is a service
  // caller and the pack carries nothing it must not see.
  sendJson(
    response,
    200,
    servableScenario(active, 'the runner scenario') ?? context.fullScenario,
  );
  return;
}

export async function handleCalendarEvent(call: RouteCall): Promise<void> {
  const { request, response, context, path } = call;
  const eventMatch = /^\/api\/calendar\/([^/]+)$/.exec(path);
  if (eventMatch === null || context.calendar === undefined) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
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

export async function handleMattermostOpen(call: RouteCall): Promise<void> {
  const { response, url } = call;
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
