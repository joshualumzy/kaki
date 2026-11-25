import { ErrorText } from './ErrorText';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type { MeetingPace } from '@kaki/shared';
import { useSignInGuard } from '../auth/useSignInGuard';
import { SIGN_IN_ENDED } from '../net/plainFailure';
import {
  Button,
  Card,
  localZoneAbbreviation,
  useDocumentTitle,
} from '../ui';
import {
  createMeeting,
  createWorkspace,
  getWorkspace,
  listWorkspaceCalendar,
  listWorkspaces,
  syncMeetingCalendar,
  tellKaki,
  type AgendaPayload,
  type MeetingCreated,
  type WorkspaceCalendarEvent,
  type WorkspaceSummary,
} from './api';
import { AppBar } from './AppBar';
import './product.css';

const DRAFT_KEY = 'kaki.new-meeting-draft.v1';
const CREATE_OPTION = '__create_workspace__';

interface DraftAgendaItem {
  id: string;
  title: string;
  minutes: string;
  ownerUserId?: string;
}

interface StoredDraft {
  workspaceId?: string;
  title?: string;
  agenda?: DraftAgendaItem[];
  pace?: MeetingPace;
}

const DEFAULT_PACE: MeetingPace = { quietCheckAfter: 120, comingUpBefore: 60 };

type Method = 'type' | 'calendar' | 'kaki';

let agendaCounter = 0;
function makeAgendaId(): string {
  agendaCounter += 1;
  return `agenda-${agendaCounter}`;
}

function readDraft(): StoredDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const agenda = Array.isArray(record.agenda)
      ? record.agenda.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const item = entry as Record<string, unknown>;
          if (typeof item.id !== 'string' || typeof item.title !== 'string') return [];
          return [
            {
              id: item.id,
              title: item.title,
              minutes: typeof item.minutes === 'string' ? item.minutes : '',
              ...(typeof item.ownerUserId === 'string' ? { ownerUserId: item.ownerUserId } : {}),
            },
          ];
        })
      : [];
    const pace = record.pace;
    let storedPace: MeetingPace | undefined;
    if (typeof pace === 'object' && pace !== null && !Array.isArray(pace)) {
      const quiet = (pace as Record<string, unknown>).quietCheckAfter;
      const coming = (pace as Record<string, unknown>).comingUpBefore;
      if (typeof quiet === 'number' && typeof coming === 'number') {
        storedPace = { quietCheckAfter: quiet, comingUpBefore: coming };
      }
    }
    return {
      ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(agenda.length === 0 ? {} : { agenda }),
      ...(storedPace === undefined ? {} : { pace: storedPace }),
    };
  } catch {
    return {};
  }
}

function writeDraft(draft: StoredDraft): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A browser that blocks storage still keeps the form usable in memory.
  }
}

function clearDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

function workspaceLabel(workspace: WorkspaceSummary): string {
  return workspace.kind === 'personal' ? 'My workspace' : workspace.name;
}

function agendaRows(items: AgendaPayload[]): DraftAgendaItem[] {
  return items.map((item) => ({
    id: makeAgendaId(),
    title: item.title,
    minutes: item.minutes === undefined ? '' : String(item.minutes),
    ...(item.ownerUserId === undefined ? {} : { ownerUserId: item.ownerUserId }),
  }));
}

function agendaPayload(items: DraftAgendaItem[]): AgendaPayload[] {
  return items.flatMap((item) => {
    const title = item.title.trim();
    if (title === '') return [];
    const minutes = item.minutes.trim();
    return [
      {
        title,
        ...(minutes === '' ? {} : { minutes: Number(minutes) }),
        ...(item.ownerUserId === undefined ? {} : { ownerUserId: item.ownerUserId }),
      },
    ];
  });
}

function fullLink(link: string): string {
  try {
    return new URL(link, window.location.origin).toString();
  } catch {
    return link;
  }
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** The viewer's local date and clock for one real instant. */
function localClock(iso: string): { date: string; time: string } {
  const when = new Date(iso);
  return {
    date: `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}`,
    time: `${two(when.getHours())}:${two(when.getMinutes())}`,
  };
}

/** A picker row's time: the event's own clock, or the viewer's clock when it carries an instant. */
function calendarEventWhen(event: WorkspaceCalendarEvent): string {
  if (event.start === undefined) {
    return `${event.date}, ${event.time}${event.endTime === undefined ? '' : `–${event.endTime}`}`;
  }
  const local = localClock(event.start);
  const zone = localZoneAbbreviation(new Date(event.start));
  return `${local.date}, ${local.time}${zone === '' ? '' : ` (${zone})`}`;
}

/** New meeting: only the title is required; the agenda is optional and can come three ways. */
export function NewMeetingPage() {
  useDocumentTitle('New meeting · Kaki');
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const guard = useSignInGuard({
    next: '/new',
    reloadKey,
    onRetry: () => setReloadKey((key) => key + 1),
  });
  const signedIn = guard.status === 'ready';
  const [initialDraft] = useState(readDraft);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialDraft.workspaceId ?? '');
  const [title, setTitle] = useState(initialDraft.title ?? '');
  const [agenda, setAgenda] = useState<DraftAgendaItem[]>(initialDraft.agenda ?? []);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [quietCheck, setQuietCheck] = useState(
    String((initialDraft.pace ?? DEFAULT_PACE).quietCheckAfter),
  );
  const [comingUp, setComingUp] = useState(
    String((initialDraft.pace ?? DEFAULT_PACE).comingUpBefore),
  );
  const [method, setMethod] = useState<Method | null>(null);
  const [tellText, setTellText] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<WorkspaceCalendarEvent[] | null>(null);
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarReload, setCalendarReload] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<{
    uid: string;
    fileId?: string;
    start?: string;
  } | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<'start' | 'schedule' | 'calendar' | 'kaki' | null>(null);
  const [created, setCreated] = useState<MeetingCreated | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    setWorkspaces(null);
    setLoadError(null);
    listWorkspaces()
      .then((list) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((workspaceError: unknown) => {
        if (cancelled) return;
        setLoadError(
          workspaceError instanceof Error ? workspaceError.message : 'Could not load your workspaces.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, signedIn]);

  useEffect(() => {
    if (workspaces === null) return;
    setSelectedId((current) => {
      if (workspaces.some((workspace) => workspace.id === current)) return current;
      const fallback =
        workspaces.find((workspace) => workspace.kind === 'personal') ??
        workspaces.find((workspace) => workspace.kind !== 'sample') ??
        workspaces[0];
      return fallback?.id ?? '';
    });
  }, [workspaces]);

  useEffect(() => {
    let cancelled = false;
    setPeople([]);
    setPeopleError(null);
    if (!signedIn) return undefined;
    if (selectedId === '') return undefined;
    getWorkspace(selectedId)
      .then((workspace) => {
        if (cancelled) return;
        const memberIds = new Set(workspace.people.map((person) => person.id));
        setPeople(workspace.people.map((person) => ({ id: person.id, name: person.name })));
        // Agenda owners belong to the selected workspace: never keep an id it does not contain.
        setAgenda((current) => {
          const next = current.map((item) =>
            item.ownerUserId !== undefined && !memberIds.has(item.ownerUserId)
              ? { id: item.id, title: item.title, minutes: item.minutes }
              : item,
          );
          return next.some((item, index) => item !== current[index]) ? next : current;
        });
      })
      .catch((peopleFailure: unknown) => {
        if (cancelled) return;
        setPeopleError(
          peopleFailure instanceof Error
            ? peopleFailure.message
            : 'Could not load the people in this workspace.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, signedIn]);

  useEffect(() => {
    if (method !== 'calendar' || selectedId === '') return undefined;
    let cancelled = false;
    setCalendarLoading(true);
    setCalendarError(null);
    setCalendarEvents(null);
    setCalendarConnected(null);
    listWorkspaceCalendar(selectedId)
      .then(({ connected, events }) => {
        if (cancelled) return;
        setCalendarConnected(connected);
        setCalendarEvents(events);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCalendarError(
          error instanceof Error ? error.message : 'Could not read the workspace calendar.',
        );
      })
      .finally(() => {
        if (!cancelled) setCalendarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [method, selectedId, calendarReload]);

  useEffect(() => {
    if (created !== null) return;
    writeDraft({
      ...(selectedId === '' ? {} : { workspaceId: selectedId }),
      title,
      ...(agenda.length === 0 ? {} : { agenda }),
      pace: {
        quietCheckAfter: Number(quietCheck),
        comingUpBefore: Number(comingUp),
      },
    });
  }, [selectedId, title, agenda, quietCheck, comingUp, created]);

  if (guard.status !== 'ready') return guard.fallback;

  // A dead error card under a still-working menu is worse than a clear trip to sign-in.
  if (loadError === SIGN_IN_ENDED) {
    return <Navigate to={`/signin?next=${encodeURIComponent('/new')}`} replace />;
  }

  const user = guard.user;
  const selected = workspaces?.find((workspace) => workspace.id === selectedId);
  const isSample = selected?.kind === 'sample';
  const loadingWorkspaces = workspaces === null && loadError === null;

  function updateAgenda(id: string, patch: Partial<DraftAgendaItem>): void {
    setAgenda((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addAgendaItem(): void {
    setAgenda((current) => [...current, { id: makeAgendaId(), title: '', minutes: '' }]);
  }

  function removeAgendaItem(id: string): void {
    setAgenda((current) => current.filter((item) => item.id !== id));
  }

  function chooseCalendarEvent(event: WorkspaceCalendarEvent): void {
    setTitle(event.title);
    // Keep the event's own instant. The date and time inputs show that instant in the viewer's
    // local zone; scheduling sends the instant itself, so the server never sees a shifted clock.
    const local = event.start === undefined ? undefined : localClock(event.start);
    setDate(local?.date ?? event.date);
    setTime(local?.time ?? event.time);
    setSelectedEvent({
      uid: event.uid,
      ...(event.fileId === undefined ? {} : { fileId: event.fileId }),
      ...(event.start === undefined ? {} : { start: event.start }),
    });
    // The event's notes become the agenda: one plain item per line, with list markers removed.
    const lines = event.description
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((line) => line !== '' && !/^agenda:?$/i.test(line))
      .slice(0, 20);
    if (lines.length > 0) {
      setAgenda(lines.map((line) => ({ id: makeAgendaId(), title: line, minutes: '' })));
    }
    setMethod(null);
    const zone = localZoneAbbreviation(event.start === undefined ? new Date() : new Date(event.start));
    setNote(
      event.start === undefined
        ? 'Loaded from the workspace calendar. Check the title, time and agenda before scheduling.'
        : `Loaded from the workspace calendar. Times are shown in your time zone (${
            zone === '' ? 'your local time' : zone
          })${event.timeZone === undefined ? '.' : `; the event is in ${event.timeZone}.`}`,
    );
  }

  async function retryCalendar(meeting: MeetingCreated): Promise<void> {
    if (pending !== null) return;
    setPending('calendar');
    setError(null);
    setNote(null);
    try {
      const outcome = await syncMeetingCalendar(meeting.id);
      setCreated((current) =>
        current === null || current.id !== meeting.id
          ? current
          : { ...current, calendar: outcome.calendar },
      );
      if (outcome.warning !== null) setError(outcome.warning);
      else setNote('The meeting is back on the workspace calendar.');
    } catch (calendarFailure) {
      setError(
        calendarFailure instanceof Error
          ? calendarFailure.message
          : 'Could not put the meeting on the calendar.',
      );
    } finally {
      setPending(null);
    }
  }

  async function askKaki(): Promise<void> {
    if (pending !== null || tellText.trim() === '') return;
    setPending('kaki');
    setError(null);
    setNote(null);
    try {
      const draft = await tellKaki(tellText);
      if (draft.title !== null) setTitle(draft.title);
      setAgenda(agendaRows(draft.agenda));
      setNote('Kaki drafted this. Check it before creating the meeting.');
    } catch (kakiError) {
      setError(kakiError instanceof Error ? kakiError.message : 'Could not ask Kaki to draft the agenda.');
    } finally {
      setPending(null);
    }
  }

  async function addWorkspace(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (savingWorkspace) return;
    const name = newName.trim();
    if (name === '') return;
    setSavingWorkspace(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(name);
      setWorkspaces((current) => (current === null ? [workspace] : [...current, workspace]));
      setSelectedId(workspace.id);
      setCreating(false);
      setNewName('');
    } catch (workspaceError) {
      setCreateError(
        workspaceError instanceof Error ? workspaceError.message : 'Could not create the workspace.',
      );
    } finally {
      setSavingWorkspace(false);
    }
  }

  async function submit(scheduled: boolean): Promise<void> {
    if (pending !== null) return;
    if (title.trim() === '') {
      setError('Give the meeting a title.');
      return;
    }
    if (selected === undefined) {
      setError('Choose a workspace for the meeting.');
      return;
    }
    const quietSeconds = Number(quietCheck);
    const comingUpSeconds = Number(comingUp);
    if (
      !Number.isInteger(quietSeconds) ||
      quietSeconds < 10 ||
      quietSeconds > 600 ||
      !Number.isInteger(comingUpSeconds) ||
      comingUpSeconds < 10 ||
      comingUpSeconds > 600
    ) {
      setError('Pace warnings must be whole seconds between 10 and 600.');
      return;
    }
    let scheduledFor: string | undefined;
    if (scheduled) {
      if (date === '' || time === '') {
        setError('Choose a date and time for the meeting.');
        return;
      }
      const when =
        selectedEvent?.start === undefined
          ? new Date(`${date}T${time}`)
          : new Date(selectedEvent.start);
      if (Number.isNaN(when.getTime())) {
        setError('Enter a valid date and time.');
        return;
      }
      if (when.getTime() <= Date.now()) {
        setError('Choose a time in the future.');
        return;
      }
      scheduledFor = when.toISOString();
    }

    setPending(scheduled ? 'schedule' : 'start');
    setError(null);
    setNote(null);
    try {
      const items = agendaPayload(agenda);
      const meeting = await createMeeting({
        workspaceId: selected.id,
        title: title.trim(),
        ...(items.length === 0 ? {} : { agenda: items }),
        pace: { quietCheckAfter: quietSeconds, comingUpBefore: comingUpSeconds },
        ...(scheduledFor === undefined ? {} : { scheduledFor }),
        ...(scheduled && selectedEvent !== null
          ? {
              calendarEvent: {
                uid: selectedEvent.uid,
                ...(selectedEvent.fileId === undefined ? {} : { fileId: selectedEvent.fileId }),
              },
            }
          : {}),
      });
      clearDraft();
      // The meeting exists now: stop the draft writer so a late people load cannot recreate the draft.
      setCreated(meeting);
      if (scheduled) {
        setCopied(null);
        return;
      }
      // Start now goes straight into the room: the meeting begins as soon as its owner is in.
      navigate(`/m/${encodeURIComponent(meeting.id)}/room?start=1`);
    } catch (createErrorValue) {
      setError(
        createErrorValue instanceof Error ? createErrorValue.message : 'Could not create the meeting.',
      );
    } finally {
      setPending(null);
    }
  }

  async function copyLink(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('Link copied.');
    } catch {
      setCopied('Could not copy automatically. Select the link to copy it.');
    }
  }

  function createAnother(): void {
    setCreated(null);
    setTitle('');
    setAgenda([]);
    setQuietCheck(String(DEFAULT_PACE.quietCheckAfter));
    setComingUp(String(DEFAULT_PACE.comingUpBefore));
    setMethod(null);
    setTellText('');
    setCalendarEvents(null);
    setCalendarConnected(null);
    setCalendarError(null);
    setSelectedEvent(null);
    setDate('');
    setTime('');
    setNote(null);
    setError(null);
    setCopied(null);
  }

  const full = created === null ? '' : fullLink(created.link);

  return (
    <>
      <AppBar user={user} workspaces={workspaces ?? []} />
      <main className="page product-page product-page-narrow">
        <header className="page-header">
          <h1>New meeting</h1>
          <p className="page-subtitle">A title, and an agenda if it helps.</p>
        </header>

        {loadError === null ? null : (
          <Card title="Could not load your workspaces">
            <p className="connection-banner" role="alert">
              <ErrorText text={loadError} />
            </p>
            <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </Button>
          </Card>
        )}

        {loadingWorkspaces ? (
          <p className="empty-state" role="status">
            Loading your workspaces…
          </p>
        ) : null}

        {created !== null ? (
          <section className="card product-section">
            <h2 className="product-section-title">The meeting is ready</h2>
            <p className="product-hint">Share this link with the people joining.</p>
            <div className="product-invite-row">
              <p className="product-invite-link">
                <a href={created.link} title={full}>
                  {full.replace(/^https?:\/\//, '')}
                </a>
              </p>
              <Button variant="ghost" onClick={() => void copyLink(full)}>
                Copy
              </Button>
            </div>
            <div className="product-row-actions">
              <Link className="product-open" to={created.link}>
                Open meeting
              </Link>
            </div>
            {created.calendar?.state === 'error' ? (
              <div>
                <p className="product-error" role="alert">
                  <ErrorText text={created.calendar.error ?? 'The meeting is not on the workspace calendar.'} />
                </p>
                <Button
                  variant="ghost"
                  onClick={() => void retryCalendar(created)}
                  disabled={pending !== null}
                >
                  {pending === 'calendar' ? 'Retrying…' : 'Retry calendar'}
                </Button>
              </div>
            ) : null}
            {created.calendar?.state === 'not_connected' ? (
              <p className="product-hint">
                This meeting is not on a calendar. Connect the workspace calendar in its tools to
                add it.
              </p>
            ) : null}
            {created.calendar?.state === 'synced' ? (
              <p className="product-note">The meeting is on the workspace calendar.</p>
            ) : null}
            {copied === null ? null : (
              <p className="product-note" role="status">
                {copied}
              </p>
            )}
            <button type="button" className="product-link" onClick={createAnother}>
              Create another meeting
            </button>
          </section>
        ) : null}

        {created === null && loadError === null && !loadingWorkspaces ? (
          <section className="card product-section">
            <div className="product-field">
              <label className="product-label" htmlFor="new-meeting-workspace">
                Workspace
              </label>
              <select
                id="new-meeting-workspace"
                className="product-input"
                value={creating ? CREATE_OPTION : selectedId}
                onChange={(event) => {
                  if (event.target.value === CREATE_OPTION) {
                    setCreating(true);
                    return;
                  }
                  setSelectedId(event.target.value);
                  setCreating(false);
                }}
              >
                {workspaces?.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspaceLabel(workspace)}
                  </option>
                ))}
                <option value={CREATE_OPTION}>+ Create a workspace</option>
              </select>
              <p className="product-hint">
                A workspace holds your meetings, minutes and connected tools. The Nanyang Kopi
                sample is read-only and has its tools ready.
              </p>
            </div>

            {creating ? (
              <form className="product-inline-form" onSubmit={(event) => void addWorkspace(event)}>
                <label className="product-field">
                  <span>New workspace name</span>
                  <input
                    className="product-input"
                    value={newName}
                    placeholder="Research"
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </label>
                <div className="product-row-actions">
                  <Button type="submit" disabled={newName.trim() === '' || savingWorkspace}>
                    {savingWorkspace ? 'Creating…' : 'Create'}
                  </Button>
                  <button
                    type="button"
                    className="product-link"
                    onClick={() => {
                      setCreating(false);
                      setNewName('');
                      setCreateError(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {createError === null ? null : (
                  <p className="product-error" role="alert">
                    <ErrorText text={createError} />
                  </p>
                )}
              </form>
            ) : null}

            {isSample ? (
              <div className="product-sample">
                <p className="product-sample-title">
                  The sample workspace can hold this meeting; practice is one click away.
                </p>
                <Link className="product-open" to="/practice">
                  Try a practice meeting
                </Link>
              </div>
            ) : null}

            <form
                className="product-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(false);
                }}
                noValidate
              >
                <div className="product-field">
                  <label className="product-label" htmlFor="new-meeting-title">
                    Meeting title
                  </label>
                  <input
                    id="new-meeting-title"
                    className="product-input product-title-input"
                    placeholder="Weekly sync with Lucie"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <p className="product-hint">
                    Only the title is required. People join from the invite link.
                  </p>
                </div>

                <div className="product-field">
                  <h2 className="product-subhead">
                    Agenda <span className="product-optional">(optional)</span>
                  </h2>
                  <p className="product-methods-label">Ways to add the agenda</p>
                  <div className="product-methods" role="group" aria-label="How to add the agenda">
                    <button
                      type="button"
                      className="product-method"
                      data-active={method === 'type'}
                      onClick={() => setMethod(method === 'type' ? null : 'type')}
                    >
                      Type it
                    </button>
                    <button
                      type="button"
                      className="product-method"
                      data-active={method === 'calendar'}
                      onClick={() => setMethod(method === 'calendar' ? null : 'calendar')}
                    >
                      From calendar
                    </button>
                    <button
                      type="button"
                      className="product-method"
                      data-active={method === 'kaki'}
                      onClick={() => setMethod(method === 'kaki' ? null : 'kaki')}
                    >
                      Tell Kaki
                    </button>
                  </div>

                  {method === 'type' ? (
                    <div className="product-method-panel">
                      <Button variant="ghost" onClick={addAgendaItem}>
                        Add an item
                      </Button>
                    </div>
                  ) : null}

                  {method === 'calendar' ? (
                    <div className="product-method-panel">
                      {calendarLoading ? (
                        <p className="product-hint" role="status">
                          Reading the workspace calendar…
                        </p>
                      ) : null}
                      {calendarError === null ? null : (
                        <div>
                          <p className="product-error" role="alert">
                            <ErrorText text={calendarError} />
                          </p>
                          <Button
                            variant="ghost"
                            onClick={() => setCalendarReload((count) => count + 1)}
                          >
                            Try again
                          </Button>
                        </div>
                      )}
                      {!calendarLoading && calendarError === null && calendarConnected === false ? (
                        <p className="product-hint">
                          This workspace has no connected calendar.{' '}
                          {selected === undefined ? null : (
                            <Link className="product-link" to={`/workspaces/${encodeURIComponent(selected.id)}`}>
                              Connect one in its tools
                            </Link>
                          )}{' '}
                          and try again.
                        </p>
                      ) : null}
                      {!calendarLoading &&
                      calendarError === null &&
                      calendarConnected === true &&
                      calendarEvents !== null &&
                      calendarEvents.length === 0 ? (
                        <p className="product-hint">
                          No upcoming events in the workspace calendar.
                        </p>
                      ) : null}
                      {calendarEvents === null || calendarEvents.length === 0 ? null : (
                        <ul className="product-calendar-events">
                          {calendarEvents.map((event) => (
                            <li key={`${event.uid}-${event.date}-${event.time}`}>
                              <button
                                type="button"
                                className="product-calendar-event"
                                onClick={() => chooseCalendarEvent(event)}
                              >
                                <span className="product-row-title">{event.title}</span>
                                <span className="product-hint">
                                  {calendarEventWhen(event)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  {method === 'kaki' ? (
                    <div className="product-method-panel">
                      <label className="product-label" htmlFor="new-meeting-tell">
                        Describe the meeting in a sentence
                      </label>
                      <textarea
                        id="new-meeting-tell"
                        className="product-textarea"
                        rows={3}
                        placeholder="Weekly sync with Lucie: demo video, env files, bugs from the last test"
                        value={tellText}
                        onChange={(event) => setTellText(event.target.value)}
                      />
                      <Button
                        variant="ghost"
                        onClick={() => void askKaki()}
                        disabled={pending !== null || tellText.trim() === ''}
                      >
                        {pending === 'kaki' ? 'Kaki is drafting…' : 'Ask Kaki to draft it'}
                      </Button>
                    </div>
                  ) : null}

                  {agenda.length === 0 ? null : (
                    <ol className="product-agenda">
                      {agenda.map((item, index) => (
                        <li key={item.id} className="product-agenda-row">
                          <input
                            className="product-input"
                            aria-label={`Agenda item ${index + 1}`}
                            placeholder="Item"
                            value={item.title}
                            onChange={(event) => updateAgenda(item.id, { title: event.target.value })}
                          />
                          <input
                            className="product-input product-minutes"
                            aria-label={`Minutes for item ${index + 1}`}
                            type="number"
                            min={1}
                            max={240}
                            placeholder="min"
                            value={item.minutes}
                            onChange={(event) => updateAgenda(item.id, { minutes: event.target.value })}
                          />
                          {people.length === 0 ? null : (
                            <select
                              className="product-input product-agenda-owner"
                              aria-label={`Owner for item ${index + 1}`}
                              value={item.ownerUserId ?? ''}
                              onChange={(event) =>
                                updateAgenda(item.id, {
                                  ...(event.target.value === ''
                                    ? { ownerUserId: undefined }
                                    : { ownerUserId: event.target.value }),
                                })
                              }
                            >
                              <option value="">Everyone (no owner)</option>
                              {people.map((person) => (
                                <option key={person.id} value={person.id}>
                                  {person.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <button
                            type="button"
                            className="product-link"
                            aria-label={`Remove item ${index + 1}`}
                            onClick={() => removeAgendaItem(item.id)}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                  {peopleError === null ? null : (
                    <p className="product-error" role="alert">
                      <ErrorText text={peopleError} />
                    </p>
                  )}
                </div>

                <div className="product-field">
                  <h2 className="product-subhead">
                    Pace <span className="product-optional">(optional)</span>
                  </h2>
                  <p className="product-hint">
                    How Kaki warns the room during each item. Leave these as they are unless you
                    want a different rhythm.
                  </p>
                  <div className="product-schedule">
                    <label className="product-field">
                      <span>Check quiet people after (seconds into an item)</span>
                      <input
                        className="product-input"
                        type="number"
                        min={10}
                        max={600}
                        value={quietCheck}
                        onChange={(event) => setQuietCheck(event.target.value)}
                      />
                    </label>
                    <label className="product-field">
                      <span>Warn the next owner (seconds before the item ends)</span>
                      <input
                        className="product-input"
                        type="number"
                        min={10}
                        max={600}
                        value={comingUp}
                        onChange={(event) => setComingUp(event.target.value)}
                      />
                    </label>
                  </div>
                </div>

                <aside className="product-notice" role="note">
                  <strong>Kaki transcribes this meeting</strong>
                  <span>Everyone's words become the minutes and to-dos.</span>
                </aside>

                {error === null ? null : (
                  <p className="product-error" role="alert">
                    <ErrorText text={error} />
                  </p>
                )}
                {note === null ? null : (
                  <p className="product-note" role="status">
                    {note}
                  </p>
                )}

                <div className="product-actions-row">
                  <Button type="submit" disabled={pending !== null}>
                    {pending === 'start' ? 'Starting…' : 'Start now'}
                  </Button>
                </div>

                <fieldset className="product-schedule-group">
                  <legend>Schedule for later</legend>
                  <p className="product-hint">
                    {`Times are in your local zone (${localZoneAbbreviation() || 'your local time'}).`}
                  </p>
                  <div className="product-schedule">
                    <label className="product-field">
                      <span>Date</span>
                      <input
                        className="product-input"
                        type="date"
                        value={date}
                        onChange={(event) => {
                          setDate(event.target.value);
                          setSelectedEvent((current) =>
                            current === null ? current : { ...current, start: undefined },
                          );
                        }}
                      />
                    </label>
                    <label className="product-field">
                      <span>Time</span>
                      <input
                        className="product-input"
                        type="time"
                        value={time}
                        onChange={(event) => {
                          setTime(event.target.value);
                          setSelectedEvent((current) =>
                            current === null ? current : { ...current, start: undefined },
                          );
                        }}
                      />
                    </label>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => void submit(true)}
                    disabled={pending !== null}
                  >
                    {pending === 'schedule' ? 'Scheduling…' : 'Schedule for later'}
                  </Button>
                </fieldset>
              </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
