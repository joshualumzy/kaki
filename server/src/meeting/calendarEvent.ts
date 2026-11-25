import type { AgendaItem } from './agenda';
import { writeCalendarEvent, type CalendarSettings } from '../action/calendar';
import type { WorkspaceToolSource } from '../workspace/tools';

/** How one meeting's workspace calendar event stands right now. */
export type MeetingCalendarState = 'not_connected' | 'synced' | 'error';

/** The calendar event state kept with one meeting, so a failure is never silently dropped. */
export interface MeetingCalendarEventState {
  /** The stable UID derived from the meeting id; every copy of the event shares it. */
  uid: string;
  /** Bumped on every edit and on cancellation, so a client replaces rather than duplicates. */
  sequence: number;
  state: MeetingCalendarState;
  /** The plain sentence a person sees when the last sync failed. */
  error: string | null;
  syncedAt: string | null;
}

/** The two per-meeting calendar state operations a meeting store can offer. */
export interface MeetingCalendarEventStore {
  calendarEventFor?(meetingId: string): Promise<MeetingCalendarEventState | undefined>;
  saveCalendarEvent?(meetingId: string, event: MeetingCalendarEventState): Promise<void>;
}

/** The meeting facts one calendar event needs. */
export interface MeetingCalendarSubject {
  id: string;
  workspaceId: string;
  title: string;
  scheduledFor: string | null;
  agenda: readonly AgendaItem[];
}

/** Why a cancelled meeting's event could not be removed, or null when it was. */
export interface CalendarCancelOutcome {
  warning: string | null;
}

/** What one sync attempt left behind. */
export interface CalendarSyncOutcome {
  state: MeetingCalendarEventState;
  warning: string | null;
}

/** The calendar write path the meeting registry and the retry route both use. */
export interface MeetingCalendarSync {
  syncMeeting(
    meeting: MeetingCalendarSubject,
    options?: { bumpSequence?: boolean },
  ): Promise<CalendarSyncOutcome>;
  cancelMeeting(meeting: MeetingCalendarSubject): Promise<CalendarCancelOutcome>;
}

/** Options for the sync service; tests inject a fake calendar and clock. */
export interface MeetingCalendarSyncOptions {
  store: MeetingCalendarEventStore;
  tools: WorkspaceToolSource;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_MEETING_MINUTES = 30;
const MIN_MEETING_MINUTES = 1;

/** The stable UID one Kaki meeting's calendar event carries everywhere. */
export function meetingCalendarUid(meetingId: string): string {
  return `kaki-meeting-${meetingId}@kaki.local`;
}

/** The file name that holds one meeting's event inside the workspace calendar. */
export function meetingCalendarFileId(meetingId: string): string {
  return `kaki-meeting-${meetingId}`;
}

/** A meeting's length: the agenda's own minutes when it has any, otherwise half an hour. */
export function meetingDurationMinutes(agenda: readonly AgendaItem[]): number {
  const total = agenda.reduce(
    (sum, item) => sum + (item.minutes === undefined ? 0 : item.minutes),
    0,
  );
  return total >= MIN_MEETING_MINUTES ? total : DEFAULT_MEETING_MINUTES;
}

/** The description one meeting's event carries: its agenda, one plain line per item. */
export function meetingDescription(agenda: readonly AgendaItem[]): string {
  const items = agenda.filter((item) => item.title.trim() !== '');
  if (items.length === 0) return '';
  return [
    'Agenda:',
    ...items.map((item) =>
      item.minutes === undefined ? `- ${item.title}` : `- ${item.title} (${item.minutes} min)`,
    ),
  ].join('\n');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function utcStamp(value: Date): string {
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(
    value.getUTCHours(),
  )}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

/** Escape one RFC 5545 TEXT value: backslash, semicolon, comma and newlines. */
export function escapeIcalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold one content line at 75 octets, with a leading space on each continuation line. */
function foldLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const character of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (current !== '' && Buffer.byteLength(current + character, 'utf8') > limit) {
      parts.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`));
}

/** The body of one meeting event. Times are the stored instant, written in UTC. */
export interface MeetingIcsInput {
  uid: string;
  sequence: number;
  title: string;
  /** The agenda as plain text, already unescaped. */
  description: string;
  /** The meeting's scheduled start as an ISO instant. */
  start: string;
  durationMinutes: number;
  cancelled?: boolean;
  now: Date;
}

/** Build one RFC 5545 event for a Kaki meeting. */
export function buildMeetingIcs(input: MeetingIcsInput): string {
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) throw new Error('The meeting time is not a valid date.');
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.cancelled === true ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${utcStamp(input.now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SEQUENCE:${input.sequence}`,
    `STATUS:${input.cancelled === true ? 'CANCELLED' : 'CONFIRMED'}`,
    `SUMMARY:${escapeIcalText(input.title)}`,
    ...(input.description === '' ? [] : [`DESCRIPTION:${escapeIcalText(input.description)}`]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.flatMap(foldLine).join('\r\n')}\r\n`;
}

function plainReason(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'The workspace calendar could not be read.';
}

/** One workspace's calendar, when it can be written to. */
function writableCalendar(tools: Awaited<ReturnType<WorkspaceToolSource['toolsFor']>>):
  | CalendarSettings
  | undefined {
  if (tools.readOnly) return undefined;
  return tools.calendar;
}

/**
 * Create the service that keeps one workspace calendar event per Kaki meeting. The meeting is
 * always saved first; a calendar failure is recorded on the meeting so a person can retry it.
 */
export function createMeetingCalendarSync({
  store,
  tools,
  fetchImpl = fetch,
  timeoutMs,
  now = Date.now,
}: MeetingCalendarSyncOptions): MeetingCalendarSync {
  async function load(meetingId: string): Promise<MeetingCalendarEventState | undefined> {
    return store.calendarEventFor?.(meetingId);
  }

  async function save(meetingId: string, state: MeetingCalendarEventState): Promise<void> {
    await store.saveCalendarEvent?.(meetingId, state);
  }

  function notConnectedState(
    uid: string,
    sequence: number,
    existing: MeetingCalendarEventState | undefined,
  ): MeetingCalendarEventState {
    const wasSynced =
      existing !== undefined && existing.state !== 'not_connected';
    return {
      uid,
      sequence,
      state: wasSynced ? 'error' : 'not_connected',
      error: wasSynced
        ? 'The workspace calendar is not connected, so this meeting could not be updated.'
        : null,
      syncedAt: existing?.syncedAt ?? null,
    };
  }

  return {
    async syncMeeting(meeting, options = {}) {
      const existing = await load(meeting.id);
      const uid = existing?.uid ?? meetingCalendarUid(meeting.id);
      const sequence = (existing?.sequence ?? 0) + (options.bumpSequence === true ? 1 : 0);

      if (meeting.scheduledFor === null) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          state: 'not_connected',
          error: null,
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: null };
      }

      let settings: CalendarSettings | undefined;
      try {
        settings = writableCalendar(await tools.toolsFor(meeting.workspaceId));
      } catch (error) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          state: 'error',
          error: plainReason(error),
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: state.error };
      }
      if (settings === undefined) {
        const state = notConnectedState(uid, sequence, existing);
        await save(meeting.id, state);
        return { state, warning: state.error };
      }

      let ics: string;
      try {
        ics = buildMeetingIcs({
          uid,
          sequence,
          title: meeting.title,
          description: meetingDescription(meeting.agenda),
          start: new Date(meeting.scheduledFor).toISOString(),
          durationMinutes: meetingDurationMinutes(meeting.agenda),
          now: new Date(now()),
        });
      } catch (error) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          state: 'error',
          error: plainReason(error),
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: state.error };
      }
      const written = await writeCalendarEvent(
        settings,
        meetingCalendarFileId(meeting.id),
        ics,
        fetchImpl,
        timeoutMs,
      );
      if (!written.ok) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          state: 'error',
          error: written.message,
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: written.message };
      }
      const state: MeetingCalendarEventState = {
        uid,
        sequence,
        state: 'synced',
        error: null,
        syncedAt: new Date(now()).toISOString(),
      };
      await save(meeting.id, state);
      return { state, warning: null };
    },

    async cancelMeeting(meeting) {
      const existing = await load(meeting.id);
      // Nothing was ever written, so there is nothing to take back.
      if (existing === undefined || existing.state === 'not_connected') {
        return { warning: null };
      }
      if (meeting.scheduledFor === null) return { warning: null };

      let settings: CalendarSettings | undefined;
      try {
        settings = writableCalendar(await tools.toolsFor(meeting.workspaceId));
      } catch (error) {
        return {
          warning: `The workspace calendar could not be read, so its event was not cancelled: ${plainReason(
            error,
          )}`,
        };
      }
      if (settings === undefined) {
        return {
          warning:
            'The workspace calendar is not connected, so this meeting could not be removed from it.',
        };
      }

      let ics: string;
      try {
        ics = buildMeetingIcs({
          uid: existing.uid,
          sequence: existing.sequence + 1,
          title: meeting.title,
          description: meetingDescription(meeting.agenda),
          start: new Date(meeting.scheduledFor).toISOString(),
          durationMinutes: meetingDurationMinutes(meeting.agenda),
          cancelled: true,
          now: new Date(now()),
        });
      } catch (error) {
        return { warning: `The calendar event could not be cancelled: ${plainReason(error)}` };
      }
      const written = await writeCalendarEvent(
        settings,
        meetingCalendarFileId(meeting.id),
        ics,
        fetchImpl,
        timeoutMs,
      );
      return written.ok
        ? { warning: null }
        : { warning: `The calendar event could not be cancelled: ${written.message}` };
    },
  };
}

/**
 * The Round 2 hook: remove the calendar event Kaki created for a cancelled meeting. A meeting
 * that has no calendar, or never reached one, has nothing to remove.
 */
export function removeCalendarEventForCancelledMeeting(
  meeting: MeetingCalendarSubject,
  calendar: MeetingCalendarSync | undefined,
): Promise<CalendarCancelOutcome> {
  if (calendar === undefined) return Promise.resolve({ warning: null });
  return calendar.cancelMeeting(meeting);
}
