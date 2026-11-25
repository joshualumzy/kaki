import type { AgendaItem } from './agenda';
import { writeCalendarEvent, type CalendarSettings } from '../action/calendar';
import type { WorkspaceToolSource } from '../workspace/tools';
import {
  openStoredCalendar,
  sealCalendarBinding,
  type CalendarCancellationStore,
  type CalendarBinding,
} from './calendarCancellations';
import type { EncryptedSecret } from '../workspace/secrets';

/** How one meeting's workspace calendar event stands right now. */
export type MeetingCalendarState = 'not_connected' | 'synced' | 'error';

/** The calendar event state kept with one meeting, so a failure is never silently dropped. */
export interface MeetingCalendarEventState {
  /** The stable UID derived from the meeting id; every copy of the event shares it. */
  uid: string;
  /** Bumped on every edit and on cancellation, so a client replaces rather than duplicates. */
  sequence: number;
  /** The calendar resource this event lives in; a selected event keeps its own resource. */
  fileId?: string;
  state: MeetingCalendarState;
  /** The plain sentence a person sees when the last sync failed. */
  error: string | null;
  syncedAt: string | null;
}

/** The calendar destination kept with a meeting, so a failed cancellation can still be retried. */
export interface StoredCalendarBinding {
  binding: CalendarBinding;
  secret: EncryptedSecret | null;
}

/** The per-meeting calendar state and destination a meeting store can offer. */
export interface MeetingCalendarEventStore {
  calendarEventFor?(meetingId: string): Promise<MeetingCalendarEventState | undefined>;
  saveCalendarEvent?(meetingId: string, event: MeetingCalendarEventState): Promise<void>;
  /** The destination captured by the last successful or attempted sync. */
  calendarBindingFor?(meetingId: string): Promise<StoredCalendarBinding | undefined>;
  saveCalendarBinding?(meetingId: string, binding: StoredCalendarBinding): Promise<void>;
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

/** A calendar event that already exists; a meeting may bind to it instead of creating a second one. */
export interface SelectedCalendarEvent {
  uid: string;
  fileId: string;
}

/** Who asked for a cancellation, so a durable retry can be shown back to them. */
export interface CalendarCancelRequest {
  workspaceName?: string | null;
  requestedBy?: string | null;
}

/** The calendar write path the meeting registry and the retry route both use. */
export interface MeetingCalendarSync {
  syncMeeting(
    meeting: MeetingCalendarSubject,
    options?: { bumpSequence?: boolean; selected?: SelectedCalendarEvent },
  ): Promise<CalendarSyncOutcome>;
  cancelMeeting(
    meeting: MeetingCalendarSubject,
    request?: CalendarCancelRequest,
  ): Promise<CalendarCancelOutcome>;
}

/** Options for the sync service; tests inject a fake calendar and clock. */
export interface MeetingCalendarSyncOptions {
  store: MeetingCalendarEventStore;
  tools: WorkspaceToolSource;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Keep a failed cancellation durably, so an admin can retry it after the meeting is gone. */
  cancellations?: CalendarCancellationStore;
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
    // CalDAV calendar-object resources must not carry METHOD; STATUS and SEQUENCE say what this is.
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
  cancellations,
}: MeetingCalendarSyncOptions): MeetingCalendarSync {
  async function load(meetingId: string): Promise<MeetingCalendarEventState | undefined> {
    return store.calendarEventFor?.(meetingId);
  }

  async function save(meetingId: string, state: MeetingCalendarEventState): Promise<void> {
    await store.saveCalendarEvent?.(meetingId, state);
  }

  /** Keep the destination while it is readable, so a later cancellation has something to retry. */
  async function rememberBinding(
    meetingId: string,
    settings: CalendarSettings | undefined,
  ): Promise<void> {
    if (settings === undefined || store.saveCalendarBinding === undefined) return;
    try {
      await store.saveCalendarBinding(meetingId, sealCalendarBinding(settings));
    } catch {
      // A missing server key must not stop the meeting itself from syncing.
    }
  }

  /** The live calendar when connected, otherwise the destination captured by the last sync. */
  async function calendarFor(
    meetingId: string,
    workspaceId: string,
  ): Promise<CalendarSettings | undefined> {
    const stored = await store.calendarBindingFor?.(meetingId);
    try {
      const live = writableCalendar(await tools.toolsFor(workspaceId));
      if (live !== undefined) return live;
    } catch (error) {
      // A readable destination from the last sync still lets a cancellation be retried.
      if (stored === undefined) throw error;
    }
    if (stored === undefined) return undefined;
    return openStoredCalendar(stored.binding, stored.secret);
  }

  function notConnectedState(
    uid: string,
    sequence: number,
    fileId: string,
    existing: MeetingCalendarEventState | undefined,
  ): MeetingCalendarEventState {
    const wasSynced =
      existing !== undefined && existing.state !== 'not_connected';
    return {
      uid,
      sequence,
      fileId,
      state: wasSynced ? 'error' : 'not_connected',
      error: wasSynced
        ? 'The workspace calendar is not connected, so this meeting could not be updated.'
        : null,
      syncedAt: existing?.syncedAt ?? null,
    };
  }

  /** Keep the failed cancellation so a retry is possible even after the meeting row is gone. */
  async function rememberCancellation(
    meeting: MeetingCalendarSubject,
    existing: MeetingCalendarEventState,
    settings: CalendarSettings | undefined,
    request: CalendarCancelRequest,
    error: string,
  ): Promise<void> {
    if (cancellations === undefined || settings === undefined) return;
    let sealed: { binding: CalendarBinding; secret: EncryptedSecret | null };
    try {
      sealed = sealCalendarBinding(settings);
    } catch {
      // Without the server key the password cannot be kept; still keep the rest of the intent.
      const { password: _password, ...binding } = settings;
      sealed = { binding, secret: null };
    }
    await cancellations.add({
      workspaceId: meeting.workspaceId,
      workspaceName: request.workspaceName ?? null,
      meetingId: meeting.id,
      source: 'meeting',
      uid: existing.uid,
      sequence: existing.sequence + 1,
      fileId: existing.fileId ?? meetingCalendarFileId(meeting.id),
      title: meeting.title,
      description: meetingDescription(meeting.agenda),
      start: new Date(meeting.scheduledFor ?? new Date().toISOString()).toISOString(),
      durationMinutes: meetingDurationMinutes(meeting.agenda),
      binding: sealed.binding,
      secret: sealed.secret,
      error,
      requestedBy: request.requestedBy ?? null,
    });
  }

  return {
    async syncMeeting(meeting, options = {}) {
      const existing = await load(meeting.id);
      const selected = existing === undefined ? options.selected : undefined;
      const uid = existing?.uid ?? selected?.uid ?? meetingCalendarUid(meeting.id);
      const fileId =
        existing?.fileId ?? selected?.fileId ?? meetingCalendarFileId(meeting.id);
      const sequence = (existing?.sequence ?? 0) + (options.bumpSequence === true ? 1 : 0);

      if (meeting.scheduledFor === null) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          fileId,
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
          fileId,
          state: 'error',
          error: plainReason(error),
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: state.error };
      }
      if (settings === undefined) {
        const state = notConnectedState(uid, sequence, fileId, existing);
        await save(meeting.id, state);
        return { state, warning: state.error };
      }
      await rememberBinding(meeting.id, settings);

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
          fileId,
          state: 'error',
          error: plainReason(error),
          syncedAt: existing?.syncedAt ?? null,
        };
        await save(meeting.id, state);
        return { state, warning: state.error };
      }
      const written = await writeCalendarEvent(settings, fileId, ics, fetchImpl, timeoutMs);
      if (!written.ok) {
        const state: MeetingCalendarEventState = {
          uid,
          sequence,
          fileId,
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
        fileId,
        state: 'synced',
        error: null,
        syncedAt: new Date(now()).toISOString(),
      };
      await save(meeting.id, state);
      return { state, warning: null };
    },

    async cancelMeeting(meeting, request = {}) {
      const existing = await load(meeting.id);
      // Nothing was ever written, so there is nothing to take back.
      if (existing === undefined || existing.state === 'not_connected') {
        return { warning: null };
      }
      if (meeting.scheduledFor === null) return { warning: null };

      let settings: CalendarSettings | undefined;
      try {
        settings = await calendarFor(meeting.id, meeting.workspaceId);
      } catch (error) {
        const warning = `The workspace calendar could not be read, so its event was not cancelled: ${plainReason(
          error,
        )}`;
        await rememberCancellation(meeting, existing, undefined, request, warning);
        return { warning };
      }
      if (settings === undefined) {
        const warning =
          'The workspace calendar is not connected, so this meeting could not be removed from it.';
        await rememberCancellation(meeting, existing, undefined, request, warning);
        return { warning };
      }
      await rememberBinding(meeting.id, settings);

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
        const warning = `The calendar event could not be cancelled: ${plainReason(error)}`;
        await rememberCancellation(meeting, existing, settings, request, warning);
        return { warning };
      }
      const written = await writeCalendarEvent(
        settings,
        existing.fileId ?? meetingCalendarFileId(meeting.id),
        ics,
        fetchImpl,
        timeoutMs,
      );
      if (written.ok) return { warning: null };
      const warning = `The calendar event could not be cancelled: ${written.message}`;
      await rememberCancellation(meeting, existing, settings, request, warning);
      return { warning };
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
  request?: CalendarCancelRequest,
): Promise<CalendarCancelOutcome> {
  if (calendar === undefined) return Promise.resolve({ warning: null });
  return calendar.cancelMeeting(meeting, request);
}
