import { ErrorText } from './ErrorText';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card } from '../ui';
import { joinWorkspace } from './api';
import './product.css';

/** The page an invite link opens: a signed-in person joins the team workspace as a member. */
export function JoinWorkspacePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const auth = useMe();
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [joined, setJoined] = useState(false);

  const userId =
    auth.status === 'ready' && auth.me.authEnabled && auth.me.kind === 'user'
      ? auth.me.user.id
      : undefined;

  useEffect(() => {
    if (userId === undefined || token === '' || joined) return undefined;
    let cancelled = false;
    setError(null);
    joinWorkspace(token)
      .then((workspace) => {
        if (cancelled) return;
        setJoined(true);
        navigate(`/workspaces/${encodeURIComponent(workspace.id)}`, { replace: true });
      })
      .catch((joinError: unknown) => {
        if (cancelled) return;
        setError(
          joinError instanceof Error ? joinError.message : 'Could not join this workspace.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, userId, retryKey, joined, navigate]);

  if (auth.status === 'loading') {
    return (
      <main className="page product-page product-page-narrow">
        <p className="empty-state" role="status">
          Checking sign-in…
        </p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="page product-page product-page-narrow">
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
          <Button variant="ghost" onClick={() => setRetryKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (userId === undefined) {
    const next = `/join-workspace/${encodeURIComponent(token)}`;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }

  return (
    <main className="page product-page product-page-narrow">
      <Card title="Joining this workspace">
        {error === null ? (
          <p className="product-hint" role="status">
            Adding you to the workspace…
          </p>
        ) : (
          <>
            <p className="connection-banner" role="alert">
              <ErrorText text={error} />
            </p>
            <Button variant="ghost" onClick={() => setRetryKey((key) => key + 1)}>
              Try again
            </Button>
            <Link className="product-open" to="/new">
              Back to New meeting
            </Link>
          </>
        )}
      </Card>
    </main>
  );
}
