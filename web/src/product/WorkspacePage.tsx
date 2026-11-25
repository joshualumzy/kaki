import { ErrorText } from './ErrorText';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { SIGN_IN_ENDED } from '../net/plainFailure';
import { Button, Card } from '../ui';
import {
  getWorkspace,
  getWorkspaceInvite,
  leaveWorkspace,
  listWorkspaces,
  removeWorkspaceMember,
  renameWorkspace,
  resetWorkspaceInvite,
  setWorkspaceMemberRole,
  type ToolStatus,
  type WorkspaceDetail,
  type WorkspaceInvite,
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
  const navigate = useNavigate();
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
  const [invite, setInvite] = useState<WorkspaceInvite | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState<'reset' | 'copy' | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);

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

  useEffect(() => {
    setInvite(null);
    setInviteError(null);
    setInviteNote(null);
    if (detail === null || detail.readOnly || detail.kind !== 'team') return undefined;
    const role = workspaces?.find((workspace) => workspace.id === detail.id)?.role;
    if (role !== 'admin') return undefined;
    let cancelled = false;
    getWorkspaceInvite(detail.id)
      .then((loaded) => {
        if (!cancelled) setInvite(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInviteError(
            error instanceof Error ? error.message : 'Could not load the invite link.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detail, workspaces]);

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

  async function copyInvite(): Promise<void> {
    if (invite === null || inviteBusy !== null) return;
    setInviteBusy('copy');
    setInviteNote(null);
    try {
      await navigator.clipboard.writeText(
        new URL(invite.path, window.location.origin).toString(),
      );
      setInviteNote('Invite link copied.');
    } catch {
      setInviteNote('Could not copy automatically. Select the link to copy it.');
    } finally {
      setInviteBusy(null);
    }
  }

  async function resetInvite(): Promise<void> {
    if (detail === null || inviteBusy !== null) return;
    if (!window.confirm('Reset the invite link? The old link will stop working.')) return;
    setInviteBusy('reset');
    setInviteError(null);
    setInviteNote(null);
    try {
      const next = await resetWorkspaceInvite(detail.id);
      setInvite(next);
      setInviteNote('The old invite link no longer works.');
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Could not reset the invite link.');
    } finally {
      setInviteBusy(null);
    }
  }

  async function changeMemberRole(
    person: { id: string; name: string; role: string },
    role: 'admin' | 'member',
  ): Promise<void> {
    if (detail === null || memberBusy !== null || person.id === '') return;
    setMemberBusy(person.id);
    setMemberError(null);
    try {
      await setWorkspaceMemberRole(detail.id, person.id, role);
      setDetail((current) =>
        current === null
          ? current
          : {
              ...current,
              people: current.people.map((member) =>
                member.id === person.id ? { ...member, role } : member,
              ),
            },
      );
      if (person.id === user?.id) {
        setWorkspaces((current) =>
          current === null
            ? current
            : current.map((workspace) =>
                workspace.id === detail.id ? { ...workspace, role } : workspace,
              ),
        );
      }
    } catch (error) {
      setMemberError(
        error instanceof Error ? error.message : 'Could not change that person’s role.',
      );
    } finally {
      setMemberBusy(null);
    }
  }

  async function removeMember(person: { id: string; name: string }): Promise<void> {
    if (detail === null || memberBusy !== null || person.id === '') return;
    if (!window.confirm(`Remove ${person.name} from this workspace?`)) return;
    setMemberBusy(person.id);
    setMemberError(null);
    try {
      await removeWorkspaceMember(detail.id, person.id);
      setDetail((current) =>
        current === null
          ? current
          : { ...current, people: current.people.filter((member) => member.id !== person.id) },
      );
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : 'Could not remove that person.');
    } finally {
      setMemberBusy(null);
    }
  }

  async function leaveThisWorkspace(): Promise<void> {
    if (detail === null || memberBusy !== null) return;
    if (!window.confirm(`Leave ${detail.name}?`)) return;
    setMemberBusy(user?.id ?? 'leave');
    setMemberError(null);
    try {
      await leaveWorkspace(detail.id);
      navigate('/new', { replace: true });
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : 'Could not leave the workspace.');
      setMemberBusy(null);
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
                    {detail.people.map((person, index) => {
                      const self = person.id !== '' && person.id === user?.id;
                      const adminCount = detail.people.filter(
                        (member) => member.role === 'admin',
                      ).length;
                      const lastAdmin = person.role === 'admin' && adminCount <= 1;
                      const busy = memberBusy !== null;
                      return (
                        <li key={`${person.id}-${person.name}-${index}`} className="product-person">
                          <span className="product-avatar" aria-hidden="true">
                            {initials(person.name)}
                          </span>
                          <span className="product-row-title">{person.name}</span>
                          <span className="product-pill">{person.role}</span>
                          {detail.readOnly || person.id === '' || (!canEdit && !self) ? null : (
                            <span className="product-person-actions">
                              {canEdit && !self ? (
                                <>
                                  <button
                                    type="button"
                                    className="product-link"
                                    disabled={busy || lastAdmin}
                                    title={
                                      lastAdmin
                                        ? 'A workspace needs at least one admin.'
                                        : undefined
                                    }
                                    onClick={() =>
                                      void changeMemberRole(
                                        person,
                                        person.role === 'admin' ? 'member' : 'admin',
                                      )
                                    }
                                  >
                                    {person.role === 'admin' ? 'Make member' : 'Make admin'}
                                  </button>
                                  <button
                                    type="button"
                                    className="product-link product-link-danger"
                                    disabled={busy || lastAdmin}
                                    onClick={() => void removeMember(person)}
                                  >
                                    {memberBusy === person.id ? 'Removing…' : 'Remove'}
                                  </button>
                                </>
                              ) : null}
                              {self ? (
                                <button
                                  type="button"
                                  className="product-link"
                                  disabled={busy || lastAdmin}
                                  title={
                                    lastAdmin
                                      ? 'Make someone else an admin before you leave.'
                                      : undefined
                                  }
                                  onClick={() => void leaveThisWorkspace()}
                                >
                                  {memberBusy === user?.id ? 'Leaving…' : 'Leave workspace'}
                                </button>
                              ) : null}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {memberError === null ? null : (
                  <p className="product-error" role="alert">
                    <ErrorText text={memberError} />
                  </p>
                )}
                {canEdit && detail.kind === 'team' ? (
                  <div className="product-invite-block">
                    <h3 className="product-section-subtitle">Invite people</h3>
                    <p className="product-hint">
                      Anyone signed in who opens this link joins as a member, never as an admin.
                    </p>
                    {inviteError === null ? null : (
                      <p className="product-error" role="alert">
                        <ErrorText text={inviteError} />
                      </p>
                    )}
                    {invite === null ? (
                      inviteError === null ? (
                        <p className="product-hint" role="status">
                          Loading the invite link…
                        </p>
                      ) : null
                    ) : (
                      <>
                        <div className="product-invite-row">
                          <p className="product-invite-link">
                            <a href={invite.path}>
                              {new URL(invite.path, window.location.origin)
                                .toString()
                                .replace(/^https?:\/\//, '')}
                            </a>
                          </p>
                          <Button
                            variant="ghost"
                            onClick={() => void copyInvite()}
                            disabled={inviteBusy !== null}
                          >
                            {inviteBusy === 'copy' ? 'Copying…' : 'Copy'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => void resetInvite()}
                            disabled={inviteBusy !== null}
                          >
                            {inviteBusy === 'reset' ? 'Resetting…' : 'Reset link'}
                          </Button>
                        </div>
                        {inviteNote === null ? null : (
                          <p className="product-note" role="status">
                            {inviteNote}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
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
