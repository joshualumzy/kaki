import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MeUser } from '../auth/api';
import { Button, Card } from '../ui';
import { deleteAccount, logout, type WorkspaceSummary } from './api';

interface AppBarProps {
  user: MeUser;
  workspaces: WorkspaceSummary[];
}

/** The account bar shown on the signed-in pages: who you are, your workspaces and sign out. */
export function AppBar({ user, workspaces }: AppBarProps) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event: MouseEvent): void {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !deleting) {
        setOpen(false);
        setDeleteOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, deleting]);

  async function signOut(): Promise<void> {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await logout();
      setOpen(false);
      navigate('/signin', { replace: true });
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : 'Could not sign out.');
    } finally {
      setLeaving(false);
    }
  }

  function openDelete(): void {
    setConfirmText('');
    setDeleteError(null);
    setDeleteOpen(true);
  }

  function cancelDelete(): void {
    if (deleting) return;
    setDeleteOpen(false);
  }

  async function removeAccount(): Promise<void> {
    if (deleting || confirmText !== 'DELETE') return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount('DELETE');
      setDeleteOpen(false);
      setOpen(false);
      navigate('/signin?deleted=1', { replace: true });
    } catch (deleteFailure) {
      setDeleteError(
        deleteFailure instanceof Error ? deleteFailure.message : 'Could not delete the account.',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <header className="product-appbar">
      <Link className="product-brand" to="/new">
        Kaki
      </Link>
      <div className="product-account" ref={wrap}>
        <button
          type="button"
          className="product-account-pill"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="product-account-name">{user.name}</span>
          <span className="product-account-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open ? (
          <div className="product-menu" role="menu">
            <p className="product-menu-label" role="presentation">
              Workspaces
            </p>
            {workspaces.length === 0 ? (
              <p className="product-menu-empty">No workspaces yet.</p>
            ) : (
              workspaces.map((workspace) => (
                <Link
                  key={workspace.id}
                  className="product-menu-item"
                  role="menuitem"
                  to={`/workspaces/${encodeURIComponent(workspace.id)}`}
                  onClick={() => setOpen(false)}
                >
                  <span className="product-menu-workspace">
                    <span className="product-menu-workspace-name">{workspace.name}</span>
                    {workspace.kind === 'sample' ? (
                      <span className="product-pill">Sample</span>
                    ) : null}
                  </span>
                </Link>
              ))
            )}
            <Link
              className="product-menu-item"
              role="menuitem"
              to="/practice"
              onClick={() => setOpen(false)}
            >
              Try a practice meeting
            </Link>
            <button
              type="button"
              className="product-menu-item"
              role="menuitem"
              onClick={() => void signOut()}
              disabled={leaving}
            >
              {leaving ? 'Signing out…' : 'Sign out'}
            </button>
            <button
              type="button"
              className="product-menu-item product-menu-item-danger"
              role="menuitem"
              onClick={openDelete}
            >
              Delete account
            </button>
            {error === null ? null : (
              <p className="product-menu-error" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : null}
        {deleteOpen ? (
          <div className="product-dialog-backdrop">
            <div
              className="product-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Delete your account"
            >
              <Card title="Delete your account">
                <p>
                  Deleting your account removes your workspaces, meetings, minutes, to-dos and tool
                  logins. Any open meetings end now. This cannot be undone.
                </p>
                <label className="product-dialog-field">
                  <span>Type DELETE to confirm</span>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    autoComplete="off"
                    autoFocus
                    disabled={deleting}
                  />
                </label>
                {deleteError === null ? null : (
                  <p className="product-error" role="alert">
                    {deleteError}
                  </p>
                )}
                <div className="product-dialog-actions">
                  <Button variant="ghost" onClick={cancelDelete} disabled={deleting}>
                    Keep my account
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void removeAccount()}
                    disabled={deleting || confirmText !== 'DELETE'}
                  >
                    {deleting ? 'Deleting…' : 'Delete my account'}
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
