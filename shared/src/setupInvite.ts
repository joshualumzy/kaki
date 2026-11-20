import { eventBodies, eventProperties, unescapeIcalText, unfoldIcalLines } from './ical';
import { MAX_AGENDA_MINUTES, type SetupFieldError } from './setup';

/** The stable UID of the seeded Kopitiam meeting invite. */
export const KOPITIAM_INVITE_UID = 'kopitiam-opening-meeting@kaki.local';

/** One agenda item read from or written into a meeting invite. */
interface MeetingInviteAgendaItem {
  title: string;
  minutes: number;
  /** An attendee display name or a demo-pack role label. */
  owner: string;
}

/** A meeting invite: the title, agenda and people the calendar carries. */
export interface MeetingInvite {
  uid: string;
  title: string;
  agenda: MeetingInviteAgendaItem[];
  people: string[];
}

interface ParseMeetingInviteOptions {
  /** Select this event when the text is a whole calendar rather than one event. */
  uid?: string;
  /** Role ids and labels from the demo pack, so an owner can be a role as well as an attendee. */
  knownOwners?: readonly string[];
}

type MeetingInviteParseResult =
  | { ok: true; value: MeetingInvite }
  | { ok: false; errors: SetupFieldError[] };

interface MeetingInviteTimes {
  /** Local floating time, "YYYY-MM-DD HH:MM". */
  start: string;
  /** Local floating time; defaults to 30 minutes after the start. */
  end?: string;
  /** UTC stamp for DTSTAMP, "YYYYMMDDTHHMMSSZ"; fixed by default so the seed is stable. */
  stamp?: string;
}

const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const MINUTES_PATTERN = /^(\d+)\s*(?:min|mins|minute|minutes)?$/i;

function error(errors: SetupFieldError[], field: string, message: string): void {
  errors.push({ field, message });
}

function addUnique(list: string[], value: string): void {
  if (value !== '' && !list.includes(value)) list.push(value);
}

interface RawEvent {
  fields: Map<string, string>;
  people: string[];
  uid: string;
}

function unescapeParam(text: string): string {
  return text.replace(/\\([\\",;])/g, '$1');
}

function readPersonName(head: string, value: string): string {
  const match = /(?:^|;)CN=(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(head);
  const raw = match?.[1] ?? match?.[2] ?? value.replace(/^mailto:/i, '');
  return unescapeParam(raw).trim();
}

function readEvent(body: string): RawEvent {
  const fields = new Map<string, string>();
  const people: string[] = [];
  for (const { name, head, value } of eventProperties(body)) {
    if (name === 'ATTENDEE') {
      addUnique(people, readPersonName(head, value));
    } else if (!fields.has(name)) {
      fields.set(name, value);
    }
  }
  return { fields, people, uid: (fields.get('UID') ?? '').trim() };
}

function readAgenda(
  rawDescription: string | undefined,
  people: string[],
  knownOwners: readonly string[],
  errors: SetupFieldError[],
): MeetingInviteAgendaItem[] {
  if (rawDescription === undefined) {
    error(errors, 'agenda', 'The invite has no agenda. Add one line per item as "title | minutes | owner".');
    return [];
  }

  const known = new Set([...people, ...knownOwners].map((owner) => owner.trim().toLowerCase()));
  const text = unescapeIcalText(rawDescription);
  const agenda: MeetingInviteAgendaItem[] = [];
  let index = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || /^agenda:?$/i.test(trimmed)) continue;
    const itemLine = /^[-*]\s+(.+)$/.exec(trimmed);
    if (itemLine === null) continue;

    const parts = itemLine[1]!.split('|').map((part) => part.trim());
    if (parts.length < 3) {
      error(errors, `agenda[${index}]`, 'Write each agenda item as "title | minutes | owner".');
      index += 1;
      continue;
    }

    const owner = parts.pop() ?? '';
    const minutesText = parts.pop() ?? '';
    const title = parts.join(' | ').trim();
    const field = `agenda[${index}]`;

    if (title === '') error(errors, `${field}.title`, 'Enter an agenda item title.');

    const minutesMatch = MINUTES_PATTERN.exec(minutesText);
    const minutes = minutesMatch === null ? Number.NaN : Number(minutesMatch[1]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_AGENDA_MINUTES) {
      error(
        errors,
        `${field}.minutes`,
        `Minutes must be a whole number greater than 0 and no more than ${MAX_AGENDA_MINUTES}.`,
      );
    }

    if (owner === '') {
      error(errors, `${field}.owner`, 'Enter who owns this agenda item.');
    } else if (!known.has(owner.toLowerCase())) {
      error(errors, `${field}.owner`, `"${owner}" is not an attendee in the invite or a role in the demo pack.`);
    }

    if (title !== '' && Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_AGENDA_MINUTES && owner !== '') {
      agenda.push({ title, minutes, owner });
    }
    index += 1;
  }

  if (index === 0) {
    error(errors, 'agenda', 'The invite has no agenda. Add one line per item as "title | minutes | owner".');
  }
  return agenda;
}

/** Read one meeting invite, selecting by UID when the text holds more than one event. */
export function parseMeetingInvite(
  ics: string,
  options: ParseMeetingInviteOptions = {},
): MeetingInviteParseResult {
  const errors: SetupFieldError[] = [];
  const events = eventBodies(unfoldIcalLines(ics.replace(/^\uFEFF/, ''))).map(readEvent);
  const wanted = options.uid?.trim();
  const event =
    wanted === undefined
      ? events[0]
      : events.find((candidate) => candidate.uid === wanted);

  if (event === undefined) {
    error(
      errors,
      'invite',
      wanted === undefined
        ? 'The calendar text has no meeting invite.'
        : `No calendar invite with UID "${wanted}" was found.`,
    );
    return { ok: false, errors };
  }

  const title = unescapeIcalText(event.fields.get('SUMMARY') ?? '').trim();
  if (title === '') error(errors, 'title', 'The invite has no title.');

  const agenda = readAgenda(event.fields.get('DESCRIPTION'), event.people, options.knownOwners ?? [], errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { uid: event.uid, title, agenda, people: event.people } };
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** The human-readable agenda written into a seeded invite's DESCRIPTION. */
function formatInviteAgenda(items: readonly MeetingInviteAgendaItem[]): string {
  return ['Agenda', ...items.map((item) => `- ${oneLine(item.title)} | ${item.minutes} min | ${oneLine(item.owner)}`)].join('\n');
}

/** Escape a text property value for iCalendar. */
function escapeIcalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function escapeParam(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

/** Fold one iCalendar line at 75 UTF-8 octets, as RFC 5545 asks. */
function foldIcalLine(line: string): string {
  const chunks: string[] = [];
  let current = '';
  let octets = 0;

  for (const char of line) {
    const size = utf8Length(char);
    if (octets + size > 75 && current !== '') {
      chunks.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

function compactTime(value: string): string {
  const match = TIME_PATTERN.exec(value.trim());
  if (match === null) throw new Error(`"${value}" is not a date and time like 2026-11-11 07:30`);
  const [, y, mo, d, h, mi] = match;
  return `${y}${mo}${d}T${h}${mi}00`;
}

function defaultEnd(start: string): string {
  const match = TIME_PATTERN.exec(start.trim());
  if (match === null) throw new Error(`"${start}" is not a date and time like 2026-11-11 07:30`);
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const end = new Date(Date.UTC(y, mo - 1, d, h, mi) + 30 * 60_000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())} ${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`;
}

/**
 * A complete meeting invite: one event with the agenda in DESCRIPTION and one
 * ATTENDEE line per person. Lines are escaped and folded the standard way.
 */
export function buildMeetingInviteIcs(invite: MeetingInvite, times: MeetingInviteTimes): string {
  const start = compactTime(times.start);
  const end = compactTime(times.end ?? defaultEnd(times.start));
  const stamp = times.stamp ?? '20261111T000000Z';
  const description = formatInviteAgenda(invite.agenda);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcalText(invite.title)}`,
    `DESCRIPTION:${escapeIcalText(description)}`,
    ...invite.people.map(
      (person, index) =>
        `ATTENDEE;CN="${escapeParam(person)}";ROLE=REQ-PARTICIPANT:mailto:person-${index + 1}@kaki.local`,
    ),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(foldIcalLine).join('\r\n')}\r\n`;
}
