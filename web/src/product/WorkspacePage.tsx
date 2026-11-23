import { ErrorText } from './ErrorText';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { SIGN_IN_ENDED } from '../net/plainFailure';
import { Button, Card } from '../ui';
import {
  getWorkspace,
  listWorkspaces,
  renameWorkspace,
  type ToolStatus,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from './api';
import { AppBar } from './AppBar';
import { ToolSection } from './ToolSection';
import './product.css';

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

function fullLink(id: string): string {
  return new URL(`/m/${encodeURIComponent(id)}`, window.location.origin).toString();
}

function whenText(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

/** One workspace: people, counts, meetings and the tools Kaki can use there. */
export function WorkspacePage() {
  const { id = '' } = useParams();
  const [authKey, setAuthKey] = useState(0);
  const auth = useMe(authKey);
  const [reloadKey, setReloadKey] = useState(0);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWorkspaces(null);
    setDetail(null);
    setLoadError(null);
    setNotFound(false);
    Promise.all([listWorkspaces(), getWorkspace(id)])
      .then(([list, workspace]) => {
        if (cancelled) return;
        setWorkspaces(list);
        setDetail(workspace);
        setNameDraft(workspace.name);
      })
      .catch((workspaceError: unknown) => {
        if (cancelled) return;
        const status =
          typeof workspaceError === 'object' && workspaceError !== null && 'status' in workspaceError
            ? (workspaceError as { status: unknown }).status
            : undefined;
        if (status === 404) {
          setNotFound(true);
          return;
        }
        setLoadError(
          workspaceError instanceof Error ? workspaceError.message : 'Could not load this workspace.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

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
    return (
      <Navigate to={`/signin?next=${encodeURIComponent(`/workspaces/${id}`)}`} replace />
    );
  }

  if (loadError === SIGN_IN_ENDED) {
    return (
      <Navigate to={`/signin?next=${encodeURIComponent(`/workspaces/${id}`)}`} replace />
    );
  }

  const user = auth.me.user;
  const role = workspaces?.find((workspace) => workspace.id === id)?.role;
  const canEdit = role === 'admin' && detail !== null && !detail.readOnly;

  async function saveName(): Promise<void> {
    if (detail === null || renaming) return;
    const name = nameDraft.trim();
    if (name === '') {
      setRenameError('A workspace name must be 1-60 characters.');
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const renamed = await renameWorkspace(detail.id, name);
      setDetail((current) => (current === null ? current : { ...current, name: renamed.name }));
      setWorkspaces((current) =>
        current === null
          ? current
          : current.map((workspace) =>
              workspace.id === renamed.id ? { ...workspace, name: renamed.name } : workspace,
            ),
      );
      setEditing(false);
    } catch (renameFailure) {
      setRenameError(
        renameFailure instanceof Error ? renameFailure.message : 'Could not rename this workspace.',
      );
    } finally {
      setRenaming(false);
    }
  }

  function toolsChanged(tools: ToolStatus[]): void {
    setDetail((current) => (current === null ? current : { ...current, tools }));
  }

  async function copyMeeting(idToCopy: string): Promise<void> {
    setCopiedId(idToCopy);
    setCopyNote(null);
    try {
      await navigator.clipboard.writeText(fullLink(idToCopy));
      setCopyNote('Link copied.');
    } catch {
      setCopyNote('Could not copy automatically. Select the link to copy it.');
    }
  }

  return (
    <>
      <AppBar user={user} workspaces={workspaces ?? []} />
      <main className="page product-page product-page-wide">
        {notFound ? (
          <Card title="Workspace not found">
            <p className="product-hint">This workspace does not exist, or you are not a member.</p>
            <Link className="product-open" to="/new">
              Back to New meeting
            </Link>
          </Card>
        ) : null}

        {loadError === null ? null : (
          <Card title="Could not load this workspace">
            <p className="connection-banner" role="alert">
              <ErrorText text={loadError} />
            </p>
            <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </Button>
            <Link className="product-open" to="/new">
              Back to New meeting
            </Link>
          </Card>
        )}

        {loadError === null && !notFound && detail === null ? (
          <p className="empty-state" role="status">
            Loading this workspace…
          </p>
        ) : null}

        {detail === null ? null : (
          <>
            <header className="page-header">
              <Link className="product-link product-back" to="/new">
                ← Back to New meeting
              </Link>
              <div className="product-heading">
                {editing ? (
                  <form
                    className="product-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveName();
                    }}
                  >
                    <input
                      className="product-input product-title-input"
                      aria-label="Workspace name"
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                    />
                    <Button type="submit" disabled={renaming}>
                      {renaming ? 'Saving…' : 'Save'}
                    </Button>
                    <button
                      type="button"
                      className="product-link"
                      onClick={() => {
                        setEditing(false);
                        setRenameError(null);
                        setNameDraft(detail.name);
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <h1>{detail.name}</h1>
                    {detail.readOnly ? (
                      <span className="product-pill">Sample</span>
                    ) : canEdit ? (
                      <button
                        type="button"
                        className="product-link"
                        onClick={() => {
                          setNameDraft(detail.name);
                          setEditing(true);
                        }}
                      >
                        Rename
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              <p className="page-subtitle">
                People, the tools Kaki can use, and the meetings held here.
              </p>
            </header>

            {renameError === null ? null : (
              <p className="product-error" role="alert">
                <ErrorText text={renameError} />
              </p>
            )}

            {detail.readOnly ? (
              <p className="product-note">
                This is a sample workspace. It is read-only, and its tools are built in.
              </p>
            ) : null}

            <div className="product-grid">
              <section className="card product-section" aria-label="People">
                <div className="product-tile-head">
                  <h2 className="product-section-title">People</h2>
                  <span className="product-pill">
                    {detail.people.length} {detail.people.length === 1 ? 'person' : 'people'}
                  </span>
                </div>
                {detail.people.length === 0 ? (
                  <p className="product-hint">
                    {detail.readOnly
                      ? "The sample workspace's people are built in."
                      : 'No people yet.'}
                  </p>
                ) : (
                  <ul className="product-people">
                    {detail.people.map((person, index) => (
                      <li key={`${person.name}-${person.role}-${index}`} className="product-person">
                        <span className="product-avatar" aria-hidden="true">
                          {initials(person.name)}
                        </span>
                        <span className="product-row-title">{person.name}</span>
                        <span className="product-pill">{person.role}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card product-section" aria-label="Activity">
                <h2 className="product-section-title">Activity</h2>
                <dl className="product-stats">
                  <div className="product-stat">
                    <dt>Meetings</dt>
                    <dd>{detail.counts.meetings}</dd>
                  </div>
                  <div className="product-stat">
                    <dt>To-dos</dt>
                    <dd>{detail.counts.todos}</dd>
                  </div>
                </dl>
              </section>

              <section className="card product-section product-meetings" aria-label="Meetings">
                <h2 className="product-section-title">Meetings</h2>
                {detail.meetings.filter((meeting) => meeting.status !== 'ended').length === 0 ? (
                  detail.readOnly ? (
                    <p className="product-hint">The sample workspace&apos;s meetings are built in.</p>
                  ) : detail.meetings.length === 0 ? (
                    <p className="product-hint">
                      No meetings yet. Start one with{' '}
                      <Link className="product-link" to="/new">
                        New meeting
                      </Link>
                      , then share its link or QR code so people can join.
                    </p>
                  ) : (
                    <p className="product-hint">No upcoming meetings yet.</p>
                  )
                ) : (
                  <ul className="product-meeting-list">
                    {detail.meetings
                      .filter((meeting) => meeting.status !== 'ended')
                      .map((meeting) => (
                        <li key={meeting.id} className="product-meeting">
                          <div className="product-meeting-main">
                            <p className="product-row-title">{meeting.title}</p>
                            <p className="product-hint">
                              {meeting.scheduledFor === null
                                ? 'Open now'
                                : `Scheduled for ${whenText(meeting.scheduledFor)}`}
                            </p>
                            <div className="product-invite-row">
                              <p className="product-invite-link">
                                <a href={`/m/${encodeURIComponent(meeting.id)}`} title={fullLink(meeting.id)}>
                                  {fullLink(meeting.id).replace(/^https?:\/\//, '')}
                                </a>
                              </p>
                              <Button variant="ghost" onClick={() => void copyMeeting(meeting.id)}>
                                {copiedId === meeting.id ? 'Copied' : 'Copy'}
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                  </ul>
                )}
                <h3 className="product-section-subtitle">Past meetings</h3>
                {detail.readOnly ? (
                  <p className="product-hint">The sample workspace&apos;s meetings are built in.</p>
                ) : detail.meetings.filter((meeting) => meeting.status === 'ended').length === 0 ? (
                  <p className="product-hint">No past meetings yet.</p>
                ) : (
                  <ul className="product-meeting-list">
                    {detail.meetings
                      .filter((meeting) => meeting.status === 'ended')
                      .map((meeting) => (
                        <li key={meeting.id} className="product-meeting">
                          <div className="product-meeting-main">
                            <Link
                              className="product-row-title"
                              to={`/workspaces/${encodeURIComponent(detail.id)}/meetings/${encodeURIComponent(meeting.id)}`}
                            >
                              {meeting.title}
                            </Link>
                            <p className="product-hint">Ended · minutes and to-dos</p>
                          </div>
                          <Link
                            className="product-open"
                            to={`/workspaces/${encodeURIComponent(detail.id)}/meetings/${encodeURIComponent(meeting.id)}`}
                          >
                            Open
                          </Link>
                        </li>
                      ))}
                  </ul>
                )}
                {copyNote === null ? null : (
                  <p className="product-note" role="status">
                    {copyNote}
                  </p>
                )}
              </section>

              <ToolSection workspace={detail} canEdit={canEdit} onChange={toolsChanged} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
