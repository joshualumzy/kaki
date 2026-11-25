import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Button, Card } from '../ui';
import type { MeUser } from './api';
import { useMe } from './useMe';

export type SignInGuard =
  | { status: 'loading'; fallback: ReactNode }
  | { status: 'error'; fallback: ReactNode }
  | { status: 'redirect'; fallback: ReactNode }
  | { status: 'ready'; fallback: null; user: MeUser };

interface SignInGuardOptions {
  /** Where to send the person after sign-in, such as the page they were opening. */
  next: string;
  /** Re-runs the sign-in check, for the failure card's Try again. */
  onRetry: () => void;
  /** Changes when the page wants the check run again. */
  reloadKey?: number;
}

/**
 * Holds a protected page's data requests until the sign-in check confirms a person.
 *
 * The check is fetchMe (GET /api/auth/me, through useMe). A signed-out browser is sent to sign in
 * before the page asks for anything protected, so no 401s appear in the console on a first visit.
 */
export function useSignInGuard({
  next,
  onRetry,
  reloadKey = 0,
}: SignInGuardOptions): SignInGuard {
  const auth = useMe(reloadKey);

  if (auth.status === 'loading') {
    return {
      status: 'loading',
      fallback: (
        <main className="page product-page">
          <p className="empty-state" role="status">
            Checking sign-in…
          </p>
        </main>
      ),
    };
  }

  if (auth.status === 'error') {
    return {
      status: 'error',
      fallback: (
        <main className="page product-page">
          <Card title="Could not check sign-in">
            <p className="connection-banner" role="alert">
              {auth.message}
            </p>
            <Button variant="ghost" onClick={onRetry}>
              Try again
            </Button>
          </Card>
        </main>
      ),
    };
  }

  if (!auth.me.authEnabled || auth.me.kind !== 'user') {
    return {
      status: 'redirect',
      fallback: <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />,
    };
  }

  return { status: 'ready', fallback: null, user: auth.me.user };
}
