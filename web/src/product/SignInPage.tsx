import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card, useDocumentTitle } from '../ui';
import './product.css';

/** The white Google "G" as inline SVG, so the button needs no external image. */
function GoogleMark() {
  return (
    <svg className="signin-google-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.59.27-3.12.76-4.59l-7.97-6.19A23.94 23.94 0 0 0 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.91-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * Only a same-origin path is a safe place to send someone after sign-in. Anything else (an
 * external URL, a protocol-relative path, the sign-in page itself) goes to New meeting.
 */
function safeNext(value: string | null): string {
  if (value === null || value === '') return '/new';
  let parsed: URL;
  try {
    parsed = new URL(value, window.location.origin);
  } catch {
    return '/new';
  }
  if (parsed.origin !== window.location.origin) return '/new';
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/signin')) return '/new';
  return path;
}

/** Google sign-in for the product; a signed-in person goes on to where they were headed. */
export function SignInPage() {
  useDocumentTitle('Sign in · Kaki');
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe(reloadKey);
  const [search, setSearch] = useSearchParams();
  const [deleted] = useState(() => search.get('deleted') === '1');
  const next = safeNext(search.get('next'));
  const startHref = `/api/auth/google/start?next=${encodeURIComponent(next)}`;
  const error = search.get('error');

  useEffect(() => {
    if (search.get('deleted') !== '1') return;
    const rest = new URLSearchParams(search);
    rest.delete('deleted');
    setSearch(rest, { replace: true });
  }, [search, setSearch]);

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
          <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (auth.me.authEnabled && auth.me.kind === 'user') {
    return <Navigate to={next} replace />;
  }

  return (
    <main className="page product-page product-page-narrow">
      <section className="card signin-card">
        <div className="signin-brand">
          <span className="signin-mark" aria-hidden="true">
            K
          </span>
          <span className="signin-name">Kaki</span>
        </div>
        <p className="signin-line">
          Kaki writes the minutes and to-dos so your workspace can just talk.
        </p>
        {deleted ? (
          <p className="product-note" role="status">
            Your account has been deleted, along with everything in it.
          </p>
        ) : null}
        {search.get('next') === null ? null : (
          <p className="product-hint">Sign in to open the page you were going to.</p>
        )}
        {error !== null && error !== '' && (
          <p className="product-error" role="alert">
            {error}
          </p>
        )}
        <a className="signin-google" href={startHref}>
          <GoogleMark />
          <span>Sign in with Google</span>
        </a>
        <p className="product-hint">New here? Signing in creates your account.</p>
        <Link className="product-link" to="/practice">
          Try a practice meeting
        </Link>
      </section>
      <footer className="signin-footer">
        <Link className="product-link" to="/privacy">
          Privacy
        </Link>
        <Link className="product-link" to="/terms">
          Terms
        </Link>
      </footer>
    </main>
  );
}
