import { ErrorText } from './ErrorText';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card } from '../ui';
import {
  agendaFromCalendar,
  createMeeting,
  createWorkspace,
  listWorkspaces,
  tellKaki,
  type AgendaPayload,
  type MeetingCreated,
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
}

interface StoredDraft {
  workspaceId?: string;
  title?: string;
  agenda?: DraftAgendaItem[];
}

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
            },
          ];
        })
      : [];
    return {
      ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(agenda.length === 0 ? {} : { agenda }),
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
  }));
}

function agendaPayload(items: DraftAgendaItem[]): AgendaPayload[] {
  return items.flatMap((item) => {
    const title = item.title.trim();
    if (title === '') return [];
    const minutes = item.minutes.trim();
    return [{ title, ...(minutes === '' ? {} : { minutes: Number(minutes) }) }];
  });
}

function fullLink(link: string): string {
  try {
    return new URL(link, window.location.origin).toString();
  } catch {
    return link;
  }
}

/** New meeting: only the title is required; the agenda is optional and can come three ways. */
export function NewMeetingPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe(reloadKey);
  const [initialDraft] = useState(readDraft);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialDraft.workspaceId ?? '');
  const [title, setTitle] = useState(initialDraft.title ?? '');
  const [agenda, setAgenda] = useState<DraftAgendaItem[]>(initialDraft.agenda ?? []);
  const [method, setMethod] = useState<Method | null>(null);
  const [tellText, setTellText] = useState('');
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
  }, [reloadKey]);

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
    if (created !== null) return;
    writeDraft({
      ...(selectedId === '' ? {} : { workspaceId: selectedId }),
      title,
      ...(agenda.length === 0 ? {} : { agenda }),
    });
  }, [selectedId, title, agenda, created]);

  if (auth.status === 'loading') {
    return (
      <main className="page product-page">
        <p className="empty-state" role="status">
          Checking sign-in…
        </p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="page product-page">
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
          <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (!auth.me.authEnabled || auth.me.kind !== 'user') {
    return <Navigate to={`/signin?next=${encodeURIComponent('/new')}`} replace />;
  }

  const user = auth.me.user;
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

  async function fillFromCalendar(): Promise<void> {
    if (pending !== null) return;
    setPending('calendar');
    setError(null);
    setNote(null);
    try {
      const invite = await agendaFromCalendar();
      setTitle(invite.title);
      setAgenda(agendaRows(invite.agenda));
      setMethod(null);
      setNote('Loaded from your calendar. Check it before creating the meeting.');
    } catch (calendarError) {
      setError(calendarError instanceof Error ? calendarError.message : 'Could not read your calendar.');
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
    let scheduledFor: string | undefined;
    if (scheduled) {
      if (date === '' || time === '') {
        setError('Choose a date and time for the meeting.');
        return;
      }
      const when = new Date(`${date}T${time}`);
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
        ...(scheduledFor === undefined ? {} : { scheduledFor }),
      });
      clearDraft();
      setCreated(meeting);
      setCopied(null);
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
    setMethod(null);
    setTellText('');
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
            <p className="product-invite-link">
              <a href={created.link}>{full}</a>
            </p>
            <div className="product-row-actions">
              <Button variant="ghost" onClick={() => void copyLink(full)}>
                Copy
              </Button>
              <Link className="product-open" to={created.link}>
                Open meeting
              </Link>
            </div>
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
                      <p className="product-hint">Use the meeting invite already in your calendar.</p>
                      <Button
                        variant="ghost"
                        onClick={() => void fillFromCalendar()}
                        disabled={pending !== null}
                      >
                        {pending === 'calendar' ? 'Reading calendar…' : 'Load from calendar'}
                      </Button>
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
                </div>

                <p className="product-notice">Kaki transcribes this meeting</p>

                <div className="product-schedule">
                  <label className="product-field">
                    <span>Date</span>
                    <input
                      className="product-input"
                      type="date"
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <label className="product-field">
                    <span>Time</span>
                    <input
                      className="product-input"
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                </div>

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
                  <Button
                    variant="ghost"
                    onClick={() => void submit(true)}
                    disabled={pending !== null}
                  >
                    {pending === 'schedule' ? 'Scheduling…' : 'Schedule for later'}
                  </Button>
                </div>
              </form>
          </section>
        ) : null}
      </main>
    </>
  );
}
