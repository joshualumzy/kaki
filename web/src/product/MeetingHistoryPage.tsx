import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card } from '../ui';
import {
  getMeetingMinutes,
  getWorkspace,
  listWorkspaces,
  setMeetingTodoDone,
  type MeetingMinutes,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from './api';
import { AppBar } from './AppBar';
import './product.css';

function whenText(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

function downloadMarkdown(title: string, minutes: string): void {
  const blob = new Blob([minutes], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'meeting-notes'}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Kaki's own copy of one ended meeting: its minutes, its to-dos, and Copy / Download. */
export function MeetingHistoryPage() {
  const { id = '', meetingId = '' } = useParams();
  const [authKey, setAuthKey] = useState(0);
  const auth = useMe(authKey);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [savingTodo, setSavingTodo] = useState<string | null>(null);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [minutesAttempts, setMinutesAttempts] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMinutes(null);
    setMinutesAttempts(0);
    setError(null);
    setNotFound(false);
    Promise.all([listWorkspaces(), getWorkspace(id), getMeetingMinutes(id, meetingId)])
      .then(([list, loadedWorkspace, loadedMinutes]) => {
        if (cancelled) return;
        setWorkspaces(list);
        setWorkspace(loadedWorkspace);
        setMinutes(loadedMinutes);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        const status =
          typeof failure === 'object' && failure !== null && 'status' in failure
            ? (failure as { status: unknown }).status
            : undefined;
        if (status === 404) {
          setNotFound(true);
          return;
        }
        setError(failure instanceof Error ? failure.message : 'Could not load these minutes.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, meetingId]);

  // Kaki keeps its copy of the minutes a moment after the meeting ends. A page opened in that
  // window would otherwise keep saying "still being prepared" until someone reloaded by hand.
  useEffect(() => {
    if (minutes === null || minutes.minutes !== null || minutesAttempts >= 15) return;
    const timer = window.setTimeout(() => {
      getMeetingMinutes(id, meetingId)
        .then((next) => {
          setMinutes(next);
          setMinutesAttempts((count) => count + 1);
        })
        .catch(() => setMinutesAttempts((count) => count + 1));
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [id, meetingId, minutes, minutesAttempts]);

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
          <Button variant="ghost" onClick={() => setAuthKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (!auth.me.authEnabled || auth.me.kind !== 'user') {
    return <Navigate to={`/signin?next=${encodeURIComponent(`/workspaces/${id}/meetings/${meetingId}`)}`} replace />;
  }

  async function copyMinutes(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote('Minutes copied.');
    } catch {
      setCopyNote('Could not copy automatically. Select the minutes to copy them.');
    }
  }

  async function toggleTodo(taskId: string, done: boolean): Promise<void> {
    if (minutes === null || savingTodo !== null) return;
    setSavingTodo(taskId);
    setTodoError(null);
    try {
      const todos = await setMeetingTodoDone(id, meetingId, taskId, done);
      setMinutes((current) => (current === null ? current : { ...current, todos }));
    } catch (failure) {
      setTodoError(failure instanceof Error ? failure.message : 'Could not save the to-do.');
    } finally {
      setSavingTodo(null);
    }
  }

  const hasConnectedTool = workspace?.tools.some((tool) => tool.connected) ?? false;

  return (
    <>
      <AppBar user={auth.me.user} workspaces={workspaces ?? []} />
      <main className="page product-page product-page-wide">
        {notFound ? (
          <Card title="Meeting not found">
            <p className="product-hint">This meeting does not exist, has not ended, or is not in this workspace.</p>
            <Link className="product-open" to={`/workspaces/${encodeURIComponent(id)}`}>
              Back to the workspace
            </Link>
          </Card>
        ) : null}

        {error === null ? null : (
          <Card title="Could not load these minutes">
            <p className="connection-banner" role="alert">
              {error}
            </p>
          </Card>
        )}

        {error === null && !notFound && minutes === null ? (
          <p className="empty-state" role="status">
            Loading these minutes…
          </p>
        ) : null}

        {minutes === null ? null : (
          <>
            <header className="page-header">
              <Link className="product-link product-back" to={`/workspaces/${encodeURIComponent(id)}`}>
                ← Back to the workspace
              </Link>
              <div className="product-heading">
                <h1>{minutes.title}</h1>
              </div>
              <p className="page-subtitle">{minutes.date === '' ? 'Ended' : `Ended ${whenText(minutes.date)}`}</p>
            </header>

            <div className="product-grid">
              <section className="card product-section" aria-label="To-dos">
                <div className="product-tile-head">
                  <h2 className="product-section-title">To-dos</h2>
                  <span className="product-pill">{minutes.todos.length}</span>
                </div>
                {minutes.todos.length === 0 ? (
                  <p className="product-hint">No to-dos were kept from this meeting.</p>
                ) : (
                  <ul className="product-todos">
                    {minutes.todos.map((todo) => (
                      <li key={todo.id} className="product-todo">
                        <label>
                          <input
                            type="checkbox"
                            checked={todo.done}
                            disabled={!minutes.canEdit || savingTodo === todo.id}
                            onChange={(event) => void toggleTodo(todo.id, event.currentTarget.checked)}
                          />
                          <span className="product-row-title">{todo.title}</span>
                        </label>
                        <span className="product-hint">
                          {todo.owner}
                          {todo.status === '' ? '' : ` · ${todo.status.replace('_', ' ').toLowerCase()}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {minutes.canEdit ? null : (
                  <p className="product-hint">Only the meeting owner or a workspace admin can tick a to-do.</p>
                )}
                {todoError === null ? null : (
                  <p className="product-error" role="alert">
                    {todoError}
                  </p>
                )}
              </section>

              <section className="card product-section product-minutes-section" aria-label="Minutes">
                <div className="product-tile-head">
                  <h2 className="product-section-title">Minutes</h2>
                </div>
                <p className="product-note">
                  {hasConnectedTool
                    ? 'Kaki keeps this copy of the minutes with the meeting, whatever tools are connected.'
                    : 'No tool is connected here, so this is Kaki’s own copy. Copy or download the minutes.'}
                </p>
                {minutes.minutes === null ? (
                  <p className="product-hint" role="status">
                    The minutes are still being prepared. Reload in a moment.
                  </p>
                ) : (
                  <>
                    <div className="product-actions">
                      <Button variant="ghost" onClick={() => void copyMinutes(minutes.minutes!)}>
                        Copy
                      </Button>
                      <Button variant="ghost" onClick={() => downloadMarkdown(minutes.title, minutes.minutes!)}>
                        Download markdown
                      </Button>
                    </div>
                    {copyNote === null ? null : (
                      <p className="product-note" role="status">
                        {copyNote}
                      </p>
                    )}
                    <pre className="product-minutes-copy">{minutes.minutes}</pre>
                  </>
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </>
  );
}
