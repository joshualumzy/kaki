import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { ActionError, createActionModule, isObject, messageOf, plainReason } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

const CONFIG_MESSAGE = 'The calendar is not configured: set CALDAV_URL';

/** The local mock CalDAV server (Radicale) and where people open an event; built from the environment. */
export interface CalendarSettings {
  /** Radicale's address, e.g. http://127.0.0.1:5232 */
  caldavUrl: string;
  /** Where this server is reached by people, e.g. http://127.0.0.1:3001 */
  viewBaseUrl: string;
  user?: string;
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
}

/** An event as the draft carries it: floating local time, no time zone. */
export interface EventTimes {
  start: string; // YYYY-MM-DD HH:MM
  durationMinutes: number;
}

const START_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function collectionUrl({ caldavUrl, user = 'user', calendar = 'calendar' }: CalendarSettings): string {
  return `${caldavUrl.replace(/\/+$/, '')}/${user}/${calendar}/`;
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

/** A minimal iCalendar event. Times are floating (no zone), so every viewer shows the clock time as written. */
export function buildIcs(uid: string, title: string, times: EventTimes, notes: string, now: Date): string {
  const start = parseStart(times.start);
  const end = new Date(start.getTime() + times.durationMinutes * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(now)}Z`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${escapeText(title)}`,
    ...(notes === '' ? [] : [`DESCRIPTION:${escapeText(notes)}`]),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function unescapeText(text: string): string {
  return text.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** The fields the viewer page shows, read from a .ics file. */
export function parseIcs(ics: string): { title: string; start?: string; end?: string; description: string; people: string[] } {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const fields = new Map<string, string>();
  const people: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).split(';')[0]!.toUpperCase();
    const value = line.slice(colon + 1);
    if (name === 'ATTENDEE' || name === 'ORGANIZER') {
      const cn = /CN="?([^";:]+)"?/i.exec(line.slice(0, colon));
      people.push(cn?.[1] ?? value.replace(/^mailto:/i, ''));
    } else if (!fields.has(name)) {
      fields.set(name, value);
    }
  }
  const readTime = (value: string | undefined): string | undefined => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(value ?? '');
    return m === null ? undefined : `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  };
  const start = readTime(fields.get('DTSTART'));
  const end = readTime(fields.get('DTEND'));
  return {
    title: unescapeText(fields.get('SUMMARY') ?? 'Untitled event'),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    description: unescapeText(fields.get('DESCRIPTION') ?? ''),
    people,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small, readable page for one event, so the link a person gets can be opened and understood. */
export function renderEventPage(ics: string, downloadHref: string): string {
  const event = parseIcs(ics);
  const when = event.start === undefined ? '' : event.end === undefined ? event.start : `${event.start} to ${event.end.slice(11)}`;
  const rows = [
    when === '' ? '' : `<p class="when">${escapeHtml(when)}</p>`,
    event.people.length === 0 ? '' : `<p><strong>With:</strong> ${escapeHtml(event.people.join(', '))}</p>`,
    event.description === '' ? '' : `<p class="notes">${escapeHtml(event.description).replace(/\n/g, '<br>')}</p>`,
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(event.title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f;background:#fff}
.card{border:1px solid #d6d6dc;border-radius:12px;padding:1.25rem}h1{margin:.2rem 0 .6rem;font-size:1.4rem}
.when{font-size:1.1rem;font-weight:600}.kicker{color:#666;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em}
a{color:#2457d6}</style></head>
<body><div class="card"><div class="kicker">Calendar event (Kaki)</div><h1>${escapeHtml(event.title)}</h1>
${rows}
<p><a href="${escapeHtml(downloadHref)}">Add to my calendar (.ics file)</a></p></div></body></html>`;
}

/** What the viewer route needs back: a status, a content type and a body. */
export interface EventView {
  status: number;
  contentType: string;
  body: string;
  filename?: string;
}

/** Fetch one event from the calendar server and render it, or its raw .ics when `download` is set. */
export async function viewEvent(
  settings: CalendarSettings,
  id: string,
  download: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<EventView> {
  const plain = (status: number, body: string): EventView => ({ status, contentType: 'text/plain; charset=utf-8', body });
  if (!ID_PATTERN.test(id)) return plain(404, 'No such event');
  let response: Response;
  try {
    response = await fetchImpl(`${collectionUrl(settings)}${id}.ics`, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch {
    return plain(502, 'The calendar server is not answering. Check that it is running, then reload.');
  }
  if (response.status === 404) return plain(404, 'No such event');
  if (!response.ok) return plain(502, `The calendar server returned HTTP ${response.status}`);
  const ics = await response.text();
  if (download) {
    return { status: 200, contentType: 'text/calendar; charset=utf-8', body: ics, filename: `${id}.ics` };
  }
  return { status: 200, contentType: 'text/html; charset=utf-8', body: renderEventPage(ics, `/api/calendar/${id}?download=1`) };
}

// Strictly one JSON object with a title and a valid start; anything else is unusable.
function parseDraft(reply: string): { title: string; times: EventTimes; notes: string } | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const start = typeof value.start === 'string' ? value.start.trim().replace('T', ' ') : '';
  if (title === '' || !START_PATTERN.test(start)) return undefined;
  const minutes = typeof value.durationMinutes === 'number' && value.durationMinutes >= 5 ? Math.round(value.durationMinutes) : 30;
  const notes = typeof value.description === 'string' ? value.description.trim() : '';
  return { title, times: { start, durationMinutes: minutes }, notes };
}

/** Create the module that drafts a calendar event and saves it to the calendar once the assignee approves. */
export function createCalendarModule({
  llm,
  calendar,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  today = () => new Date().toISOString().slice(0, 10),
}: CalendarModuleOptions = {}): KakiModule {
  async function call(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.any([timeout, signal]) });
    } catch (error) {
      throw new ActionError(
        timeout.aborted
          ? `The calendar timed out after ${timeoutMs} ms; check the calendar before retrying`
          : `could not reach the calendar: ${plainReason(error, 'The calendar')}`,
      );
    }
  }

  return createActionModule({
    name: 'action-calendar',
    kind: 'calendar_event',
    async draft(task, signal) {
      if (calendar === undefined) throw new ActionError(CONFIG_MESSAGE);
      if (llm === undefined) throw new ActionError('The LLM is not configured, so the event cannot be drafted');

      const date = today();
      const weekday = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            `You turn a team task into a calendar event. Today is ${weekday} ${date}. Reply with one JSON object and nothing else: ` +
            '{"title": "...", "start": "YYYY-MM-DD HH:MM", "durationMinutes": 30, "description": "..."}. ' +
            'Work out the date from the task, for example "next Friday". If no time is given use 10:00. ' +
            'The description is one or two plain sentences. Use only what is in the task and its context; do not invent names or details.',
        },
        { role: 'user', content: `Task: ${task.title}\n\nContext:\n${task.context}` },
      ];

      let reply: string;
      try {
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the event: ${messageOf(error)}`);
      }
      const draft = parseDraft(reply);
      if (draft === undefined) throw new ActionError('The LLM did not return usable JSON with a title and a start time');
      return { target: 'Team calendar', subject: draft.title, body: formatBody(draft.times, draft.notes) };
    },
    async run(task, signal) {
      if (calendar === undefined) throw new ActionError(CONFIG_MESSAGE);
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to save');

      const { times, notes } = parseBody(draft.body);
      const ics = buildIcs(`kaki-${task.id}@kaki.local`, draft.subject, times, notes, new Date());
      const collection = collectionUrl(calendar);

      // Make sure the calendar exists; "already there" answers are fine, real failures show up on the PUT.
      const root = collection.replace(/[^/]+\/$/, '');
      await call(root, { method: 'MKCOL' }, signal).catch(() => undefined);
      await call(collection, { method: 'MKCALENDAR' }, signal).catch(() => undefined);

      // The file name is the task id, so a retry overwrites the same event instead of adding a second one.
      const response = await call(
        `${collection}${task.id}.ics`,
        { method: 'PUT', headers: { 'content-type': 'text/calendar; charset=utf-8' }, body: ics },
        signal,
      );
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
        throw new ActionError(`The calendar returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
      }
      return `${calendar.viewBaseUrl.replace(/\/+$/, '')}/api/calendar/${task.id}`;
    },
  });
}
