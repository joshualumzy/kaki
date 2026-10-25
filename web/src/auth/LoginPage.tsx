import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card } from '../ui';
import { signIn } from './api';
import { useMe } from './useMe';
import './auth.css';

/** Host sign-in page; a signed-in host goes straight to the shared screen. */
export function LoginPage() {
  const auth = useMe();
  const navigate = useNavigate();
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
        </Card>
      </main>
    );
  }

  if (!auth.me.authEnabled || auth.me.kind === 'host') {
    return <Navigate to="/screen" replace />;
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
    navigate('/screen', { replace: true });
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
