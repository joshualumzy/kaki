import {
  calendarEventApiPath,
  errorMessage,
  eventBodies,
  eventProperties,
  unescapeIcalText,
  unfoldIcalLines,
} from '@kaki/shared';
import type { ChatMessage, LlmClient } from '../services/llm';
import type { KakiModule } from '../core/modules';
import type { WorkspaceTools } from '../workspace/tools';
import { basicAuthHeaders } from './basicAuth';
import { draftString, parseDraftObject } from './draft';
import { acceptedDecisionBlock, memorySourceBlock } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule } from './runner';
import type { TaskCalendarLifecycle } from '../meeting/taskCalendarEvents';

const DEFAULT_TIMEOUT_MS = 10_000;
const CONNECTION_MESSAGE = 'The calendar is not connected for this workspace.';

/** The setup message shown when the calendar action has no CalDAV address. */
export const CALENDAR_CONFIG_MESSAGE = 'The calendar is not configured: set CALDAV_URL';

/** The local mock CalDAV server (Radicale) and where people open an event; built from the environment. */
export interface CalendarSettings {
  /** Radicale's address, e.g. http://127.0.0.1:5232 */
  caldavUrl: string;
  /** Where this server is reached by people, e.g. http://127.0.0.1:3001 */
  viewBaseUrl: string;
  user?: string;
  /** The CalDAV password, kept apart from the URL and never sent back to a browser. */
  password?: string;
  calendar?: string;
}

/** Options for the calendar action module; tests inject fakes here. */
export interface CalendarModuleOptions {
  llm?: LlmClient;
  calendar?: CalendarSettings;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Today as YYYY-MM-DD; tests fix it. */
  today?: () => string;
  /** The durable per-event lifecycle used by the running app for approved follow-ups. */
  events?: TaskCalendarLifecycle;
  /** The workspace this module's meeting belongs to, so a follow-up is found by its deletion. */
  workspaceId?: string;
}

/** An event as the draft carries it: floating local time, no time zone. */
interface EventTimes {
  start: string; // YYYY-MM-DD HH:MM
  durationMinutes: number;
}

const START_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One workspace calendar's CalDAV collection. */
export function calendarCollectionUrl({
  caldavUrl,
  user = 'user',
  calendar = 'calendar',
}: CalendarSettings): string {
  return `${caldavUrl.replace(/\/+$/, '')}/${user}/${calendar}/`;
}

/** The headers for one calendar request; its password travels in Basic auth, never in the URL. */
export function calendarRequestHeaders(settings: CalendarSettings): Record<string, string> {
  return basicAuthHeaders(settings.user, settings.password);
}


/** The address of one saved event file inside its calendar collection. */
export function calendarEventUrl(settings: CalendarSettings, eventId: string): string {
  return `${calendarCollectionUrl(settings)}${eventId}.ics`;
}

/** The result of writing one event: failure carries the plain sentence a person sees. */
export type CalendarWriteResult = { ok: true } | { ok: false; message: string };

/**
 * Create the calendar collection when it is missing, then write one event file by id.
 * A retry overwrites the same file, so it can never leave a second copy of one event.
 */
export async function writeCalendarEvent(
  settings: CalendarSettings,
  eventId: string,
  ics: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CalendarWriteResult> {
  const collection = calendarCollectionUrl(settings);
  const request = async (url: string, init: RequestInit): Promise<Response | undefined> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        headers: { ...calendarRequestHeaders(settings), ...(init.headers as Record<string, string> | undefined) },
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    } catch {
      return undefined;
    }
  };
  // "Already there" answers are fine; a real failure to create the collection shows up on the PUT.
  const root = collection.replace(/[^/]+\/$/, '');
  await request(root, { method: 'MKCOL' });
  await request(collection, { method: 'MKCALENDAR' });
  const response = await request(calendarEventUrl(settings, eventId), {
    method: 'PUT',
    headers: { 'content-type': 'text/calendar; charset=utf-8' },
    body: ics,
  });
  if (response === undefined) {
    return {
      ok: false,
      message: 'The calendar server is not answering. Check that it is running, then try again.',
    };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
    return {
      ok: false,
      message: `The calendar returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
    };
  }
  return { ok: true };
}

/** A calendar read failed in a way the setup import can report as 404 (missing) or 502 (unreachable). */
export class CalendarFetchError extends Error {
  constructor(
    readonly status: 404 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarFetchError';
  }
}

/**
 * Read the whole calendar so an invite can be found by UID. The timeout is bounded
 * and the error says which side failed; it never carries calendar credentials.
 */
export async function fetchCalendarIcs(
  settings: CalendarSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(calendarCollectionUrl(settings), {
      headers: calendarRequestHeaders(settings),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CalendarFetchError(502, 'The calendar server is not answering. Check that it is running, then try again.');
  }
  if (response.status === 404) {
    throw new CalendarFetchError(404, 'No calendar was found. Check CALDAV_URL, then try again.');
  }
  if (!response.ok) {
    throw new CalendarFetchError(502, `The calendar server returned HTTP ${response.status}.`);
  }
  return response.text();
}

/** XML-unescape the text inside a calendar-data element, where a server escapes the iCalendar. */
function xmlUnescape(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A safe resource file id for a selected event whose listing did not expose its own href. */
export function calendarFileIdForUid(uid: string): string {
  const clean = uid
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean === '' ? 'kaki-imported-event' : clean;
}

/** The resource file a CalDAV href names, without its `.ics` suffix. */
function fileIdFromHref(href: string): string | undefined {
  const trimmed = href.trim().replace(/\/+$/, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (name === '') return undefined;
  const decoded = decodeURIComponent(name);
  return decoded.endsWith('.ics') ? decoded.slice(0, -4) : decoded;
}

/**
 * Read the calendar's events together with the resource file each one lives in. A CalDAV REPORT
 * gives both; a plain collection GET is kept as the fallback for servers (and test fakes) that do
 * not implement REPORT, and those events simply carry no resource id.
 */
export async function fetchCalendarEvents(
  settings: CalendarSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CalendarEvent[]> {
  const query = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">',
    '  <d:prop><d:getetag/><c:calendar-data/></d:prop>',
    '</c:calendar-query>',
  ].join('');
  try {
    const response = await fetchImpl(calendarCollectionUrl(settings), {
      method: 'REPORT',
      headers: {
        ...calendarRequestHeaders(settings),
        depth: '1',
        'content-type': 'application/xml; charset=utf-8',
      },
      body: query,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const xml = await response.text();
      const resources: CalendarEvent[] = [];
      const blocks = xml.match(/<(?:(?:\w+):)?response\b[\s\S]*?<\/(?:(?:\w+):)?response>/gi) ?? [];
      for (const block of blocks) {
        const href = /<(?:(?:\w+):)?href[^>]*>([\s\S]*?)<\/(?:(?:\w+):)?href>/i.exec(block)?.[1];
        const data = /<(?:(?:\w+):)?calendar-data[^>]*>([\s\S]*?)<\/(?:(?:\w+):)?calendar-data>/i.exec(block)?.[1];
        if (href === undefined || data === undefined) continue;
        const fileId = fileIdFromHref(xmlUnescape(href));
        for (const event of parseEvents(xmlUnescape(data))) {
          resources.push(fileId === undefined ? event : { ...event, fileId });
        }
      }
      if (resources.length > 0) return resources;
    }
  } catch {
    // Fall through to the collection GET: the calendar is still readable the old way.
  }
  return parseEvents(await fetchCalendarIcs(settings, fetchImpl, timeoutMs));
}

/** Checks the CalDAV collection can be read and looks like a calendar. */
export async function probeCalendar(
  settings: CalendarSettings,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ToolProbeResult> {
  const outcome = await probeFetch(
    fetchImpl,
    calendarCollectionUrl(settings),
    { method: 'GET', headers: calendarRequestHeaders(settings) },
    'The calendar',
    timeoutMs,
  );
  if (!outcome.ok) return outcome.result;
  if (!outcome.response.ok) return responseProblem(outcome.response, 'The calendar');
  const ics = await outcome.response.text().catch(() => undefined);
  if (ics === undefined || (ics.trim() !== '' && !/BEGIN:VCALENDAR/i.test(ics))) {
    return probeFailed('unexpected response', 'The calendar answered with something that is not a calendar.');
  }
  return probeOk('The calendar answered and can be read.');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The draft body: the times on the first two lines (editable by the person), then the notes. */
export function formatBody({ start, durationMinutes }: EventTimes, notes: string): string {
  return `Start: ${start}\nDuration: ${durationMinutes} minutes\n\n${notes}`.trimEnd();
}

/** Read the times and notes back out of a draft body, or say what is wrong with it. */
export function parseBody(body: string): { times: EventTimes; notes: string } {
  const startMatch = /^\s*Start:\s*(.+)$/im.exec(body);
  const start = startMatch?.[1]?.trim() ?? '';
  if (!START_PATTERN.test(start)) {
    throw new ActionError('The draft needs a first line like "Start: 2026-11-13 10:00"');
  }
  const durationMatch = /^\s*Duration:\s*(\d{1,4})/im.exec(body);
  const durationMinutes = durationMatch === null ? 30 : Number(durationMatch[1]);
  if (durationMinutes < 1) throw new ActionError('The duration must be at least 1 minute');
  const notes = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(Start|Duration):/i.test(line))
    .join('\n')
    .trim();
  return { times: { start: start.replace('T', ' '), durationMinutes }, notes };
}

function icsStamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00`;
}

function parseStart(start: string): Date {
  const match = START_PATTERN.exec(start);
  if (match === null) throw new ActionError(`"${start}" is not a date and time like 2026-11-13 10:00`);
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCHours() !== h) {
    throw new ActionError(`"${start}" is not a real date and time`);
  }
  return date;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** What a follow-up event should look like when it is written or cancelled. */
export interface FollowUpIcsOptions {
  sequence?: number;
  cancelled?: boolean;
}

/** A minimal iCalendar event. Times are floating (no zone), so every viewer shows the clock time as written. */
export function buildIcs(
  uid: string,
  title: string,
  times: EventTimes,
  notes: string,
  now: Date,
  options: FollowUpIcsOptions = {},
): string {
  const start = parseStart(times.start);
  const end = new Date(start.getTime() + times.durationMinutes * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    // CalDAV calendar-object resources must not carry METHOD; STATUS and SEQUENCE say what this is.
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(now)}Z`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SEQUENCE:${options.sequence ?? 0}`,
    `STATUS:${options.cancelled === true ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeText(title)}`,
    ...(notes === '' ? [] : [`DESCRIPTION:${escapeText(notes)}`]),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** One event as the calendar page and the meeting picker show it. */
export interface CalendarEvent {
  uid: string;
  title: string;
  date: string; // YYYY-MM-DD, in the event's own time zone
  time: string; // HH:MM, in the event's own time zone
  endTime?: string;
  /** The real instant when the event carries Z or TZID; absent for a floating clock time. */
  start?: string;
  /** The event's own zone name (UTC or an IANA TZID), when it has one. */
  timeZone?: string;
  status?: string;
  description: string;
  people: string[];
  /** The CalDAV resource file this event lives in, when the calendar listing exposes it. */
  fileId?: string;
}

interface ParsedTime {
  date: string;
  time: string;
  start?: string;
  timeZone?: string;
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour')) % 24;
  const minute = Number(values.get('minute'));
  const second = Number(values.get('second'));
  return Date.UTC(year, month - 1, day, hour, minute, second) - instant;
}

/** Turn a wall-clock time in an IANA zone into the real instant, using that zone's own offset. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date | undefined {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    let instant = wall - zoneOffsetMs(wall, timeZone);
    const corrected = wall - zoneOffsetMs(instant, timeZone);
    if (corrected !== instant) instant = corrected;
    return new Date(instant);
  } catch {
    return undefined;
  }
}

function readTime(value: string | undefined, head = ''): ParsedTime | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec((value ?? '').trim());
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? '0');
  const utc = m[7] === 'Z';
  const tzid = /TZID="?([^";:]+)"?/i.exec(head)?.[1];
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  if (utc) {
    const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return { date, time, start: instant.toISOString(), timeZone: 'UTC' };
  }
  if (tzid !== undefined) {
    const instant = zonedTimeToUtc(year, month, day, hour, minute, second, tzid);
    if (instant !== undefined) {
      return { date, time, start: instant.toISOString(), timeZone: tzid };
    }
  }
  return { date, time };
}

/** Every event in an iCalendar text (one event file, or a whole calendar). Events without a start time are skipped. */
export function parseEvents(ics: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const body of eventBodies(unfoldIcalLines(ics))) {
    const fields = new Map<string, string>();
    const heads = new Map<string, string>();
    const people: string[] = [];
    for (const { name, head, value } of eventProperties(body)) {
      if (name === 'ATTENDEE' || name === 'ORGANIZER') {
        const cn = /CN="?([^";:]+)"?/i.exec(head);
        const person = cn?.[1] ?? value.replace(/^mailto:/i, '');
        if (!people.includes(person)) people.push(person);
      } else if (!fields.has(name)) {
        fields.set(name, value);
        heads.set(name, head);
      }
    }
    const start = readTime(fields.get('DTSTART'), heads.get('DTSTART'));
    if (start === undefined) continue;
    const end = readTime(fields.get('DTEND'), heads.get('DTEND'));
    events.push({
      uid: fields.get('UID') ?? '',
      title: unescapeIcalText(fields.get('SUMMARY') ?? 'Untitled event'),
      date: start.date,
      time: start.time,
      ...(end === undefined || end.date !== start.date ? {} : { endTime: end.time }),
      ...(start.start === undefined ? {} : { start: start.start }),
      ...(start.timeZone === undefined ? {} : { timeZone: start.timeZone }),
      ...(fields.get('STATUS') === undefined
        ? {}
        : { status: fields.get('STATUS')!.trim().toUpperCase() }),
      description: unescapeIcalText(fields.get('DESCRIPTION') ?? ''),
      people,
    });
  }
  return events;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/**
 * The team calendar as a month grid with the linked event highlighted and described below it.
 * Server-rendered and read-only: it is the mock calendar people look at, not a file to download.
 */
function renderCalendarPage(events: CalendarEvent[], focus: CalendarEvent, month: string, baseHref: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(year, mon - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const byDay = new Map<string, Array<{ event: CalendarEvent; index: number }>>();
  events.forEach((event, index) => byDay.set(event.date, [...(byDay.get(event.date) ?? []), { event, index }]));

  const cells: string[] = [];
  for (let i = 0; i < lead; i += 1) cells.push('<div class="cell empty"></div>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${month}-${pad(day)}`;
    const chips = (byDay.get(key) ?? [])
      .sort((a, b) => a.event.time.localeCompare(b.event.time))
      .map(({ event: e, index }) => `<button type="button" class="chip${index === 0 ? ' focus' : ''}" data-i="${index}"><b>${escapeHtml(e.time)}</b> ${escapeHtml(e.title)}</button>`)
      .join('');
    cells.push(`<div class="cell${key === focus.date ? ' marked' : ''}"><span class="num">${day}</span>${chips}</div>`);
  }

  const when = focus.endTime === undefined ? focus.time : `${focus.time} to ${focus.endTime}`;
  const detail = [
    `<p class="when">${escapeHtml(focus.date)}, ${escapeHtml(when)}</p>`,
    focus.people.length === 0 ? '' : `<p><strong>With:</strong> ${escapeHtml(focus.people.join(', '))}</p>`,
    focus.description === '' ? '' : `<p class="notes">${escapeHtml(focus.description).replace(/\n/g, '<br>')}</p>`,
  ].join('');

  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team calendar: ${escapeHtml(focus.title)}</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:64rem;margin:1.5rem auto;padding:0 1rem;color:#1b1b1f;background:#fff}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}h1{font-size:1.3rem;margin:0}
nav a{color:#2457d6;text-decoration:none;padding:.25rem .6rem;border:1px solid #d6d6dc;border-radius:8px;margin-left:.3rem}
.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:#d6d6dc;border:1px solid #d6d6dc;margin:1rem 0}
.dow{background:#f3f3f6;padding:.3rem;text-align:center;font-size:.8rem;color:#555}
.cell{background:#fff;min-height:5.5rem;padding:.25rem;overflow:hidden}.cell.empty{background:#fafafc}.num{font-size:.8rem;color:#666}
.cell.marked{background:#f1f6ff}.chip{display:block;width:100%;text-align:left;border:0;font:inherit;cursor:pointer;margin-top:.2rem;padding:.1rem .3rem;border-radius:5px;background:#e9ebf1;font-size:.75rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip:hover{background:#d5d9e6}.chip.focus,.chip.focus:hover{background:#2457d6;color:#fff}.card{border:1px solid #d6d6dc;border-radius:12px;padding:1rem 1.25rem}.card h2{margin:.1rem 0 .5rem;font-size:1.2rem}
.kicker{color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}.when{font-weight:600}
@media (max-width:640px){.cell{min-height:3.2rem}.chip{font-size:.65rem}}</style></head>
<body><header><h1>Team calendar &middot; ${MONTH_NAMES[mon - 1]} ${year}</h1>
<nav><a href="${escapeHtml(baseHref)}?month=${shiftMonth(month, -1)}">&larr; Previous</a><a href="${escapeHtml(baseHref)}?month=${shiftMonth(month, 1)}">Next &rarr;</a></nav></header>
<div class="grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
<div class="card" id="detail"><div class="kicker">Event (click any event in the grid)</div><h2>${escapeHtml(focus.title)}</h2>${detail}</div>
<script>
var EVENTS=${JSON.stringify(events.map((e) => ({ title: e.title, date: e.date, time: e.time, endTime: e.endTime ?? '', description: e.description, people: e.people }))).replace(/</g, '\\u003c')};
document.addEventListener('click',function(ev){var b=ev.target.closest&&ev.target.closest('.chip');if(!b)return;
var e=EVENTS[+b.getAttribute('data-i')];if(!e)return;
document.querySelectorAll('.chip.focus').forEach(function(c){c.classList.remove('focus')});b.classList.add('focus');
var d=document.getElementById('detail');d.textContent='';
function add(tag,text,cls){var n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;d.appendChild(n);}
add('div','Event','kicker');add('h2',e.title);add('p',e.date+', '+e.time+(e.endTime?' to '+e.endTime:''),'when');
if(e.people.length)add('p','With: '+e.people.join(', '));if(e.description)add('p',e.description);});
</script></body></html>`;
}

/** What the viewer route needs back: a status, a content type and a body. */
interface EventView {
  status: number;
  contentType: string;
  body: string;
  filename?: string;
}

/**
 * The calendar page for one event: the whole team calendar as a month grid, the event highlighted.
 * `download` returns the raw .ics instead, for anyone who wants it.
 */
export async function viewEvent(
  settings: CalendarSettings,
  id: string,
  options: { download?: boolean; month?: string; baseHref?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<EventView> {
  const plain = (status: number, body: string): EventView => ({ status, contentType: 'text/plain; charset=utf-8', body });
  if (!ID_PATTERN.test(id)) return plain(404, 'No such event');
  const get = async (url: string): Promise<Response> =>
    fetchImpl(url, {
      headers: calendarRequestHeaders(settings),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await get(`${calendarCollectionUrl(settings)}${id}.ics`);
  } catch {
    return plain(502, 'The calendar server is not answering. Check that it is running, then reload.');
  }
  if (response.status === 404) return plain(404, 'No such event');
  if (!response.ok) return plain(502, `The calendar server returned HTTP ${response.status}`);
  const ics = await response.text();
  if (options.download === true) {
    return { status: 200, contentType: 'text/calendar; charset=utf-8', body: ics, filename: `${id}.ics` };
  }

  const focus = parseEvents(ics)[0];
  if (focus === undefined) return plain(502, 'The event could not be read');
  // The rest of the calendar is context; if it cannot be read the page still shows this event.
  let events: CalendarEvent[] = [focus];
  try {
    const all = await get(calendarCollectionUrl(settings));
    if (all.ok) {
      const others = parseEvents(await all.text()).filter((e) => e.uid === '' || e.uid !== focus.uid);
      events = [focus, ...others];
    }
  } catch {
    // keep just the one event
  }
  const month = options.month !== undefined && MONTH_PATTERN.test(options.month) ? options.month : focus.date.slice(0, 7);
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: renderCalendarPage(events, focus, month, options.baseHref ?? `/api/calendar/${id}`),
  };
}

/** Today and the next 21 days, each as "Tuesday 2026-11-03", so the model looks dates up instead of counting. */
export function upcomingDays(date: string, count = 22): string[] {
  const base = new Date(`${date}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(base.getTime() + i * 86_400_000);
    const weekday = day.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    return `${weekday} ${day.toISOString().slice(0, 10)}`;
  });
}

// Strictly one JSON object with a title and a valid start; anything else is unusable.
function parseDraft(reply: string): { title: string; times: EventTimes; notes: string } | undefined {
  const value = parseDraftObject(reply);
  if (value === undefined) return undefined;
  const title = draftString(value, 'title').trim();
  const start = draftString(value, 'start').trim().replace('T', ' ');
  if (title === '' || !START_PATTERN.test(start)) return undefined;
  const minutes = typeof value.durationMinutes === 'number' && value.durationMinutes >= 5 ? Math.round(value.durationMinutes) : 30;
  const notes = draftString(value, 'description').trim();
  return { title, times: { start, durationMinutes: minutes }, notes };
}

/** Create the module that drafts a calendar event and saves it to the calendar once the assignee approves. */
export function createCalendarModule({
  llm,
  calendar,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }),
  events,
  workspaceId,
}: CalendarModuleOptions = {}): KakiModule {
  function settingsFrom(tools: WorkspaceTools | undefined): CalendarSettings | undefined {
    return calendar ?? tools?.calendar;
  }

  function requireSettings(tools: WorkspaceTools | undefined): CalendarSettings {
    const settings = settingsFrom(tools);
    if (settings === undefined) throw new ActionError(CONNECTION_MESSAGE);
    return settings;
  }

  return createActionModule({
    name: 'action-calendar',
    kind: 'calendar_event',
    unconfiguredReason: (tools) => (settingsFrom(tools) === undefined ? CONNECTION_MESSAGE : undefined),
    async draft(task, signal, _scenario, _visitorName, memory, tools) {
      requireSettings(tools);
      if (llm === undefined) throw new ActionError('The LLM is not configured, so the event cannot be drafted');

      const date = today();
      const upcoming = upcomingDays(date);
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            `You turn a team task into a calendar event. Today is ${upcoming[0]}. The next days are: ${upcoming.slice(1).join('; ')}. Reply with one JSON object and nothing else: ` +
            '{"title": "...", "start": "YYYY-MM-DD HH:MM", "durationMinutes": 30, "description": "..."}. ' +
            'Work out the date from the task by looking it up in the list of days above, never by counting yourself (for a weekday such as "Friday", take the first one in the list after today). If no time is given use 10:00. ' +
            'The description is one or two plain sentences. Use only what is in the task and its context; do not invent names, places, attendees or details. Keep the words of the task title in the title.',
        },
        {
          role: 'user',
          content: `Task: ${task.title}\n\nContext:\n${task.context}${acceptedDecisionBlock(task.decisionSource)}${memorySourceBlock(memory)}`,
        },
      ];

      let reply: string;
      try {
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the event: ${errorMessage(error)}`);
      }
      const draft = parseDraft(reply);
      if (draft === undefined) throw new ActionError('The LLM did not return usable JSON with a title and a start time');
      return { target: 'Team calendar', subject: draft.title, body: formatBody(draft.times, draft.notes) };
    },
    async run(task, signal, _scenario, _visitorName, tools, meetingId) {
      const settings = requireSettings(tools);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to save');

      const { times, notes } = parseBody(draft.body);
      if (events !== undefined && workspaceId !== undefined) {
        try {
          const saved = await events.run({
            taskId: task.id,
            meetingId,
            workspaceId,
            title: draft.subject,
            notes,
            start: times.start,
            durationMinutes: times.durationMinutes,
            settings,
          });
          return `${settings.viewBaseUrl.replace(/\/+$/, '')}${calendarEventApiPath(
            meetingId,
            saved.fileId,
          )}`;
        } catch (error) {
          throw new ActionError(errorMessage(error));
        }
      }
      const ics = buildIcs(`kaki-${task.id}@kaki.local`, draft.subject, times, notes, new Date());

      // The file name is the task id, so a retry overwrites the same event instead of adding a second one.
      const written = await writeCalendarEvent(settings, task.id, ics, fetchImpl, timeoutMs, signal);
      if (!written.ok) throw new ActionError(written.message);
      // The viewer belongs to this meeting's routes, so the browser needs that meeting in the path.
      return `${settings.viewBaseUrl.replace(/\/+$/, '')}${calendarEventApiPath(meetingId, task.id)}`;
    },
  });
}
