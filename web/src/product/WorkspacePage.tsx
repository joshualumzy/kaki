import { ErrorText } from './ErrorText';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { SIGN_IN_ENDED } from '../net/plainFailure';
import {
  Button,
  Card,
  formatMeetingTime,
  localZoneAbbreviation,
  useConfirm,
  useDocumentTitle,
} from '../ui';
import {
  cancelMeeting,
  deleteWorkspace,
  endMeetingFromList,
  getWorkspace,
  getWorkspaceInvite,
  leaveWorkspace,
  listWorkspaces,
  ProductApiError,
  removeWorkspaceMember,
  renameWorkspace,
  resetWorkspaceInvite,
  setWorkspaceMemberRole,
  syncMeetingCalendar,
  updateMeeting,
  type MeetingSummary,
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
  return formatMeetingTime(iso);
}

/** A scheduled meeting whose time has passed was never started: the clock never makes it open. */
function hasNotStarted(meeting: MeetingSummary): boolean {
  return (
    meeting.status === 'scheduled' &&
    meeting.scheduledFor !== null &&
    Date.parse(meeting.scheduledFor) < Date.now()
  );
}

function meetingWhenText(meeting: MeetingSummary): string {
  if (meeting.status === 'ended') {
    return `Ended ${whenText(meeting.endedAt ?? meeting.createdAt)}`;
  }
  if (meeting.status === 'scheduled' && meeting.scheduledFor !== null) {
    return hasNotStarted(meeting)
      ? `Didn't start · was scheduled for ${whenText(meeting.scheduledFor)}`
      : `Scheduled for ${whenText(meeting.scheduledFor)}`;
  }
  if (meeting.scheduledFor !== null) {
    return `Open now · was scheduled for ${whenText(meeting.scheduledFor)}`;
  }
  return `Open now · created ${whenText(meeting.createdAt)}`;
}

function todoText(count: number): string {
  return `${count} ${count === 1 ? 'to-do' : 'to-dos'}`;
}

function localDate(iso: string | null): string {
  if (iso === null) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

function localTime(iso: string | null): string {
  if (iso === null) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

interface EditableAgendaItem {
  title: string;
  minutes: string;
  ownerUserId?: string;
}

type MeetingEditKind = 'edit' | 'reschedule';

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
  const [meetingEdit, setMeetingEdit] = useState<MeetingSummary | null>(null);
  const [meetingEditKind, setMeetingEditKind] = useState<MeetingEditKind>('edit');
  const [editTitle, setEditTitle] = useState('');
  const [editAgenda, setEditAgenda] = useState<EditableAgendaItem[]>([]);
  const [editQuietCheck, setEditQuietCheck] = useState('120');
  const [editComingUp, setEditComingUp] = useState('60');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [meetingEditError, setMeetingEditError] = useState<string | null>(null);
  const [meetingEditBusy, setMeetingEditBusy] = useState(false);
  const [meetingActionBusy, setMeetingActionBusy] = useState<string | null>(null);
  const [meetingActionError, setMeetingActionError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteAnywayOffered, setDeleteAnywayOffered] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  useDocumentTitle(detail === null ? 'Workspace · Kaki' : `${detail.name} · Kaki`);

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
  const canManageMeeting = (meeting: MeetingSummary): boolean =>
    detail !== null &&
    !detail.readOnly &&
    user !== undefined &&
    (meeting.ownerUserId === user.id || role === 'admin');

  function openMeetingEdit(meeting: MeetingSummary, kind: MeetingEditKind): void {
    setMeetingEdit(meeting);
    setMeetingEditKind(kind);
    setMeetingEditError(null);
    setEditTitle(meeting.title);
    setEditAgenda(
      meeting.agenda.map((item) => ({
        title: item.title,
        minutes: item.minutes === undefined ? '' : String(item.minutes),
        ...(item.ownerUserId === undefined ? {} : { ownerUserId: item.ownerUserId }),
      })),
    );
    setEditQuietCheck(String(meeting.pace?.quietCheckAfter ?? 120));
    setEditComingUp(String(meeting.pace?.comingUpBefore ?? 60));
    setEditDate(localDate(meeting.scheduledFor));
    setEditTime(localTime(meeting.scheduledFor));
  }

  function closeMeetingEdit(): void {
    if (meetingEditBusy) return;
    setMeetingEdit(null);
    setMeetingEditError(null);
  }

  function updateEditAgenda(index: number, patch: Partial<EditableAgendaItem>): void {
    setEditAgenda((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  async function saveMeetingEdit(): Promise<void> {
    if (meetingEdit === null || meetingEditBusy) return;
    setMeetingEditBusy(true);
    setMeetingEditError(null);
    try {
      if (meetingEditKind === 'reschedule') {
        if (editDate === '' || editTime === '') {
          throw new Error('Choose a date and time for the meeting.');
        }
        const when = new Date(`${editDate}T${editTime}`);
        if (Number.isNaN(when.getTime())) throw new Error('Enter a valid date and time.');
        if (when.getTime() <= Date.now()) throw new Error('Choose a time in the future.');
        await updateMeeting(meetingEdit.id, { scheduledFor: when.toISOString() });
      } else {
        const title = editTitle.trim();
        if (title === '') throw new Error('Give the meeting a title.');
        const agenda = editAgenda.flatMap((item) => {
          const itemTitle = item.title.trim();
          if (itemTitle === '') return [];
          const minutesText = item.minutes.trim();
          return [
            {
              title: itemTitle,
              ...(minutesText === '' ? {} : { minutes: Number(minutesText) }),
              ...(item.ownerUserId === undefined ? {} : { ownerUserId: item.ownerUserId }),
            },
          ];
        });
        const quietSeconds = Number(editQuietCheck);
        const comingUpSeconds = Number(editComingUp);
        if (
          !Number.isInteger(quietSeconds) ||
          quietSeconds < 10 ||
          quietSeconds > 600 ||
          !Number.isInteger(comingUpSeconds) ||
          comingUpSeconds < 10 ||
          comingUpSeconds > 600
        ) {
          throw new Error('Pace warnings must be whole seconds between 10 and 600.');
        }
        await updateMeeting(meetingEdit.id, {
          title,
          agenda,
          pace: { quietCheckAfter: quietSeconds, comingUpBefore: comingUpSeconds },
        });
      }
      setMeetingEdit(null);
      setReloadKey((key) => key + 1);
    } catch (error) {
      setMeetingEditError(
        error instanceof Error ? error.message : 'Could not save the meeting.',
      );
    } finally {
      setMeetingEditBusy(false);
    }
  }

  async function cancelScheduledMeeting(meeting: MeetingSummary): Promise<void> {
    if (meetingActionBusy !== null) return;
    const confirmed = await confirm({
      title: `Cancel ${meeting.title}?`,
      message: 'It will be deleted for everyone.',
      confirmLabel: 'Cancel meeting',
      cancelLabel: 'Keep it',
      danger: true,
    });
    if (!confirmed) return;
    setMeetingActionBusy(meeting.id);
    setMeetingActionError(null);
    try {
      await cancelMeeting(meeting.id);
      setDetail((current) =>
        current === null
          ? current
          : {
              ...current,
              meetings: current.meetings.filter((entry) => entry.id !== meeting.id),
            },
      );
      if (meetingEdit?.id === meeting.id) setMeetingEdit(null);
    } catch (error) {
      setMeetingActionError(
        error instanceof Error ? error.message : 'Could not cancel the meeting.',
      );
    } finally {
      setMeetingActionBusy(null);
    }
  }

  async function endOpenMeeting(meeting: MeetingSummary): Promise<void> {
    if (meetingActionBusy !== null) return;
    const confirmed = await confirm({
      title: `End ${meeting.title} for everyone?`,
      message: 'Its minutes are kept.',
      confirmLabel: 'End meeting',
      cancelLabel: 'Keep it open',
      danger: true,
    });
    if (!confirmed) return;
    setMeetingActionBusy(meeting.id);
    setMeetingActionError(null);
    try {
      await endMeetingFromList(meeting.id);
      setReloadKey((key) => key + 1);
    } catch (error) {
      setMeetingActionError(
        error instanceof Error ? error.message : 'Could not end the meeting.',
      );
    } finally {
      setMeetingActionBusy(null);
    }
  }

  async function retryMeetingCalendar(meeting: MeetingSummary): Promise<void> {
    if (meetingActionBusy !== null) return;
    setMeetingActionBusy(meeting.id);
    setMeetingActionError(null);
    try {
      const outcome = await syncMeetingCalendar(meeting.id);
      setDetail((current) =>
        current === null
          ? current
          : {
              ...current,
              meetings: current.meetings.map((entry) =>
                entry.id === meeting.id ? { ...entry, calendar: outcome.calendar } : entry,
              ),
            },
      );
      if (outcome.warning !== null) setMeetingActionError(outcome.warning);
    } catch (error) {
      setMeetingActionError(
        error instanceof Error ? error.message : 'Could not put the meeting on the calendar.',
      );
    } finally {
      setMeetingActionBusy(null);
    }
  }

  async function deleteThisWorkspace(deleteAnyway = false): Promise<void> {
    if (detail === null || deleting || deleteConfirm !== detail.name) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteAnywayOffered(false);
    try {
      const result = await deleteWorkspace(detail.id, deleteConfirm, deleteAnyway);
      if (result.mayRemain) {
        window.alert(
          'The workspace was deleted. The calendar events for upcoming meetings may remain.',
        );
      }
      navigate('/new', { replace: true });
    } catch (error) {
      setDeleteAnywayOffered(error instanceof ProductApiError && error.canDeleteAnyway);
      setDeleteError(error instanceof Error ? error.message : 'Could not delete the workspace.');
      setDeleting(false);
    }
  }

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
    const confirmed = await confirm({
      title: 'Reset the invite link?',
      message: 'The old link will stop working.',
      confirmLabel: 'Reset link',
      cancelLabel: 'Keep the link',
      danger: true,
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: `Remove ${person.name}?`,
      message: 'They will lose access to this workspace.',
      confirmLabel: 'Remove person',
      cancelLabel: 'Keep them',
      danger: true,
    });
    if (!confirmed) return;
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
    const confirmed = await confirm({
      title: `Leave ${detail.name}?`,
      message: 'You can join again with an invite link.',
      confirmLabel: 'Leave workspace',
      cancelLabel: 'Stay',
      danger: true,
    });
    if (!confirmed) return;
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
        {confirmDialog}
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

            {!detail.readOnly &&
            detail.kind === 'team' &&
            detail.meetings.length === 0 &&
            detail.people.length <= 1 ? (
              <section className="card product-section product-first-steps" aria-label="First steps">
                <h2 className="product-section-title">Get this workspace started</h2>
                <ol className="product-first-steps-list">
                  <li>
                    <strong>Invite your team.</strong>{' '}
                    <a className="product-link" href="#workspace-people">
                      Share the invite link
                    </a>{' '}
                    so people can join this workspace.
                  </li>
                  <li>
                    <strong>Connect your tools.</strong>{' '}
                    <a className="product-link" href="#workspace-tools">
                      Connect Gitea, Mattermost, email, wiki or calendar
                    </a>{' '}
                    so Kaki can read them and post what the meeting agrees.
                  </li>
                  <li>
                    <strong>Hold your first meeting.</strong>{' '}
                    <Link className="product-link" to="/new">
                      Create a meeting
                    </Link>{' '}
                    and share its link with the people joining.
                  </li>
                </ol>
              </section>
            ) : null}

            <div className="product-grid">
              <section className="card product-section" id="workspace-people" aria-label="People">
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
                            <div className="product-tile-head">
                              <p className="product-row-title">{meeting.title}</p>
                              <span className="product-pill">
                                {meeting.status === 'scheduled'
                                  ? hasNotStarted(meeting)
                                    ? "Didn't start"
                                    : 'Scheduled'
                                  : 'Open'}
                              </span>
                            </div>
                            <p className="product-hint">{meetingWhenText(meeting)}</p>
                            <p className="product-hint">
                              {todoText(meeting.todoCount)} ·{' '}
                              {meeting.ownerName === null ? 'No owner' : `Owner ${meeting.ownerName}`}
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
                            {meeting.scheduledFor === null ? null : (
                              <p className="product-hint">
                                <a
                                  className="product-link"
                                  href={`/api/meetings/${encodeURIComponent(meeting.id)}/calendar.ics`}
                                  download
                                >
                                  Add to calendar
                                </a>
                              </p>
                            )}
                            {meeting.calendar?.state === 'error' ? (
                              <div>
                                <p className="product-error" role="alert">
                                  <ErrorText
                                    text={
                                      meeting.calendar.error ??
                                      'This meeting is not on the workspace calendar.'
                                    }
                                  />
                                </p>
                                {canManageMeeting(meeting) ? (
                                  <Button
                                    variant="ghost"
                                    disabled={meetingActionBusy !== null}
                                    onClick={() => void retryMeetingCalendar(meeting)}
                                  >
                                    {meetingActionBusy === meeting.id ? 'Retrying…' : 'Retry calendar'}
                                  </Button>
                                ) : null}
                              </div>
                            ) : null}
                            {meeting.status === 'scheduled' &&
                            meeting.calendar?.state === 'not_connected' ? (
                              <div>
                                <p className="product-hint">
                                  Not on the workspace calendar. Connect Calendar under Tools to add
                                  it.
                                </p>
                                {canManageMeeting(meeting) &&
                                detail.tools.some(
                                  (tool) => tool.kind === 'calendar' && tool.connected,
                                ) ? (
                                  <Button
                                    variant="ghost"
                                    disabled={meetingActionBusy !== null}
                                    onClick={() => void retryMeetingCalendar(meeting)}
                                  >
                                    {meetingActionBusy === meeting.id ? 'Syncing…' : 'Sync to calendar'}
                                  </Button>
                                ) : null}
                              </div>
                            ) : null}
                            {canManageMeeting(meeting) ? (
                              <div className="product-row-actions">
                                {meeting.status === 'scheduled' ? (
                                  <>
                                    <button
                                      type="button"
                                      className="product-link"
                                      disabled={meetingActionBusy !== null}
                                      onClick={() => openMeetingEdit(meeting, 'edit')}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      type="button"
                                      className="product-link"
                                      disabled={meetingActionBusy !== null}
                                      onClick={() => openMeetingEdit(meeting, 'reschedule')}
                                    >
                                      Reschedule
                                    </button>
                                    <button
                                      type="button"
                                      className="product-link product-link-danger"
                                      disabled={meetingActionBusy !== null}
                                      onClick={() => void cancelScheduledMeeting(meeting)}
                                    >
                                      {meetingActionBusy === meeting.id ? 'Cancelling…' : 'Cancel'}
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="product-link product-link-danger"
                                    disabled={meetingActionBusy !== null}
                                    onClick={() => void endOpenMeeting(meeting)}
                                  >
                                    {meetingActionBusy === meeting.id ? 'Ending…' : 'End'}
                                  </button>
                                )}
                              </div>
                            ) : null}
                          </div>
                        </li>
                      ))}
                  </ul>
                )}

                {meetingEdit === null ? null : (
                  <div
                    className="product-edit-meeting"
                    role="region"
                    aria-label={`${meetingEditKind === 'edit' ? 'Edit' : 'Reschedule'} ${meetingEdit.title}`}
                  >
                    <div className="product-tile-head">
                      <h3 className="product-section-subtitle">
                        {meetingEditKind === 'edit' ? 'Edit meeting' : 'Reschedule meeting'}
                      </h3>
                      <button
                        type="button"
                        className="product-link"
                        onClick={closeMeetingEdit}
                        disabled={meetingEditBusy}
                      >
                        Close
                      </button>
                    </div>
                    <p className="product-hint">{meetingEdit.title}</p>

                    {meetingEditKind === 'edit' ? (
                      <>
                        <label className="product-field">
                          <span>Meeting title</span>
                          <input
                            className="product-input product-title-input"
                            value={editTitle}
                            onChange={(event) => setEditTitle(event.target.value)}
                          />
                        </label>
                        <div className="product-field">
                          <h4 className="product-section-subtitle">Agenda</h4>
                          {editAgenda.length === 0 ? (
                            <p className="product-hint">No agenda items.</p>
                          ) : (
                            <ol className="product-agenda">
                              {editAgenda.map((item, index) => (
                                <li key={`edit-agenda-${index}`} className="product-agenda-row">
                                  <input
                                    className="product-input"
                                    aria-label={`Agenda item ${index + 1}`}
                                    placeholder="Item"
                                    value={item.title}
                                    onChange={(event) =>
                                      updateEditAgenda(index, { title: event.target.value })
                                    }
                                  />
                                  <input
                                    className="product-input product-minutes"
                                    aria-label={`Minutes for item ${index + 1}`}
                                    type="number"
                                    min={1}
                                    max={240}
                                    placeholder="min"
                                    value={item.minutes}
                                    onChange={(event) =>
                                      updateEditAgenda(index, { minutes: event.target.value })
                                    }
                                  />
                                  <select
                                    className="product-input product-agenda-owner"
                                    aria-label={`Owner for item ${index + 1}`}
                                    value={item.ownerUserId ?? ''}
                                    onChange={(event) =>
                                      updateEditAgenda(index, {
                                        ...(event.target.value === ''
                                          ? { ownerUserId: undefined }
                                          : { ownerUserId: event.target.value }),
                                      })
                                    }
                                  >
                                    <option value="">Everyone (no owner)</option>
                                    {detail.people.map((person) => (
                                      <option key={person.id} value={person.id}>
                                        {person.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="product-link"
                                    aria-label={`Remove item ${index + 1}`}
                                    onClick={() =>
                                      setEditAgenda((current) =>
                                        current.filter((_, itemIndex) => itemIndex !== index),
                                      )
                                    }
                                  >
                                    Remove
                                  </button>
                                </li>
                              ))}
                            </ol>
                          )}
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setEditAgenda((current) => [
                                ...current,
                                { title: '', minutes: '' },
                              ])
                            }
                          >
                            Add an item
                          </Button>
                        </div>
                        <div className="product-field">
                          <h4 className="product-section-subtitle">Pace</h4>
                          <div className="product-schedule">
                            <label className="product-field">
                              <span>Check quiet people after (seconds)</span>
                              <input
                                className="product-input"
                                type="number"
                                min={10}
                                max={600}
                                value={editQuietCheck}
                                onChange={(event) => setEditQuietCheck(event.target.value)}
                              />
                            </label>
                            <label className="product-field">
                              <span>Warn the next owner (seconds before the item ends)</span>
                              <input
                                className="product-input"
                                type="number"
                                min={10}
                                max={600}
                                value={editComingUp}
                                onChange={(event) => setEditComingUp(event.target.value)}
                              />
                            </label>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div>
                        <p className="product-hint">
                          {`Times are in your local zone (${localZoneAbbreviation() || 'your local time'}).`}
                        </p>
                        <div className="product-schedule">
                          <label className="product-field">
                            <span>Date</span>
                            <input
                              className="product-input"
                              type="date"
                              value={editDate}
                              onChange={(event) => setEditDate(event.target.value)}
                            />
                          </label>
                          <label className="product-field">
                            <span>Time</span>
                            <input
                              className="product-input"
                              type="time"
                              value={editTime}
                              onChange={(event) => setEditTime(event.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    )}

                    {meetingEditError === null ? null : (
                      <p className="product-error" role="alert">
                        <ErrorText text={meetingEditError} />
                      </p>
                    )}
                    <div className="product-row-actions">
                      <Button onClick={() => void saveMeetingEdit()} disabled={meetingEditBusy}>
                        {meetingEditBusy ? 'Saving…' : 'Save'}
                      </Button>
                      <button
                        type="button"
                        className="product-link"
                        onClick={closeMeetingEdit}
                        disabled={meetingEditBusy}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
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
                            <p className="product-hint">
                              {meetingWhenText(meeting)} · {todoText(meeting.todoCount)}
                            </p>
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
                {meetingActionError === null ? null : (
                  <p className="product-error" role="alert">
                    <ErrorText text={meetingActionError} />
                  </p>
                )}
                {copyNote === null ? null : (
                  <p className="product-note" role="status">
                    {copyNote}
                  </p>
                )}
              </section>

              <ToolSection workspace={detail} canEdit={canEdit} onChange={toolsChanged} />
            </div>

            {canEdit && detail.kind === 'team' ? (
              <section
                className="card product-section product-danger-zone"
                aria-label="Delete workspace"
              >
                <h2 className="product-section-title">Delete workspace</h2>
                <p className="product-hint">
                  Deleting <strong>{detail.name}</strong> removes its meetings, minutes, to-dos,
                  people, invite link and tool logins for everyone. This cannot be undone.
                </p>
                <div className="product-field">
                  <label className="product-label" htmlFor="delete-workspace-confirm">
                    Type the workspace name to confirm
                  </label>
                  <input
                    id="delete-workspace-confirm"
                    className="product-input"
                    value={deleteConfirm}
                    placeholder={detail.name}
                    onChange={(event) => setDeleteConfirm(event.target.value)}
                    disabled={deleting}
                  />
                </div>
                {deleteError === null ? null : (
                  <p className="product-error" role="alert">
                    <ErrorText text={deleteError} />
                  </p>
                )}
                {deleteAnywayOffered ? (
                  <p className="product-note">
                    Delete anyway? The calendar events for upcoming meetings may remain.
                  </p>
                ) : null}
                <div className="product-row-actions">
                  <Button
                    variant="ghost"
                    disabled={deleting || deleteConfirm !== detail.name}
                    onClick={() => void deleteThisWorkspace()}
                  >
                    {deleting ? 'Deleting…' : 'Delete workspace'}
                  </Button>
                  {deleteAnywayOffered ? (
                    <Button
                      variant="ghost"
                      disabled={deleting || deleteConfirm !== detail.name}
                      onClick={() => void deleteThisWorkspace(true)}
                    >
                      {deleting ? 'Deleting…' : 'Delete anyway'}
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
