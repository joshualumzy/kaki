import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card } from '../ui';
import { signIn } from './api';
import { useMe } from './useMe';
import './auth.css';

/** Every route this app serves; a return path must name one of them. */
const APP_ROUTES = new Set(['/', '/practice', '/demo', '/join', '/meeting', '/login', '/setup', '/screen', '/phone']);

/**
 * Only a parsed same-origin path that names a real page is a safe place to return to after
 * sign-in. Anything else (an external URL, a slash-backslash trick, a control character) falls
 * back to the shared screen instead of handing the router an unparseable target.
 */
function returnPath(value: string | null | undefined): string {
  if (value === null || value === undefined) return '/screen';
  let parsed: URL;
  try {
    parsed = new URL(value, window.location.origin);
  } catch {
    return '/screen';
  }
  if (parsed.origin !== window.location.origin || !APP_ROUTES.has(parsed.pathname)) {
    return '/screen';
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Host sign-in page; a signed-in host goes straight to the page that asked for sign-in. */
export function LoginPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe(reloadKey);
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const fromState = (location.state as { from?: unknown } | null)?.from;
  const destination = returnPath(
    typeof fromState === 'string' ? fromState : search.get('return'),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (auth.status === 'loading') {
    return (
      <main className="page auth-page">
        <p className="empty-state">Checking sign-in…</p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="page auth-page">
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

  if (!auth.me.authEnabled || auth.me.kind === 'host') {
    return <Navigate to={destination} replace />;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;

    if (email.trim() === '') {
      setError('Enter your email address.');
      return;
    }
    if (password === '') {
      setError('Enter your password.');
      return;
    }

    setError(null);
    setPending(true);
    const result = await signIn(email, password);
    if (!result.ok) {
      setError(result.message);
      setPending(false);
      return;
    }
    navigate(destination, { replace: true });
  }

  return (
    <main className="page auth-page">
      <header className="page-header">
        <p className="eyebrow">Kaki · Host</p>
        <h1>Sign in to start the meeting</h1>
        <p className="page-subtitle">The shared screen is only visible to the host.</p>
      </header>

      <Card title="Host sign-in">
        <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="auth-field">
            <span>Email</span>
            <input
              className="auth-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error === null ? null : (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
