import { ErrorText } from './ErrorText';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSignInGuard } from '../auth/useSignInGuard';
import { Button, Card, useDocumentTitle } from '../ui';
import { joinWorkspace } from './api';
import { ProductFooter } from './ProductFooter';
import './product.css';

/** The page an invite link opens: a signed-in person joins the team workspace as a member. */
export function JoinWorkspacePage() {
  useDocumentTitle('Join a workspace · Kaki');
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [joined, setJoined] = useState(false);
  const guard = useSignInGuard({
    next: `/join-workspace/${encodeURIComponent(token)}`,
    reloadKey: retryKey,
    onRetry: () => setRetryKey((key) => key + 1),
  });

  const userId = guard.status === 'ready' ? guard.user.id : undefined;

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

  if (guard.status !== 'ready') return guard.fallback;

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
      <ProductFooter />
    </main>
  );
}
