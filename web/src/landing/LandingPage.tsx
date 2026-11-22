import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card } from '../ui';
import './landing.css';

/** Kaki's front door: choose a team meeting or a practice meeting, or enter an invite code. */
export function LandingPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe(reloadKey);
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const ownerDestination =
    auth.status === 'ready' && auth.me.authEnabled && auth.me.kind !== 'host'
      ? '/login?return=/setup'
      : '/setup';

  const signedIn =
    auth.status === 'ready' && auth.me.authEnabled && auth.me.kind === 'user';

  function enterCode(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed === '') return;
    navigate(`/join?code=${encodeURIComponent(trimmed)}`);
  }

  if (signedIn) return <Navigate to="/new" replace />;

  return (
    <main className="landing">
      <header className="landing-head">
        <img className="landing-mark" src="/kaki-cup.svg" alt="" width="88" height="88" />
        <h1>Kaki</h1>
        <p className="landing-sub">
          A meeting assistant that keeps the agenda, coaches each person privately, hands out follow-up
          tasks and drafts the minutes.
        </p>
        <p className="landing-signin-row">
          <Link className="landing-signin" to="/signin">
            Sign in
          </Link>
        </p>
      </header>

      {auth.status === 'error' ? (
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
          <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      ) : null}

      <div className="landing-paths">
        <section className="landing-card" aria-label="Run a team meeting">
          <p className="eyebrow">For the meeting owner</p>
          <h2>Run a team meeting</h2>
          <p>Set the agenda, invite your people, and let Kaki keep the meeting on track.</p>
          {auth.status === 'loading' ? (
            <p className="landing-hint" role="status">Checking sign-in…</p>
          ) : (
            <Link className="landing-go" to={ownerDestination}>
              Run a team meeting
            </Link>
          )}
        </section>

        <section className="landing-card" aria-label="Try a practice meeting">
          <p className="eyebrow">On your own</p>
          <h2>Try a practice meeting</h2>
          <p>You join alone; AI colleagues play the rest of the team.</p>
          <Link className="landing-go landing-go-secondary" to="/practice">
            Try a practice meeting
          </Link>
        </section>
      </div>

      <form className="landing-invite" onSubmit={enterCode} aria-label="Enter a meeting code">
        <label htmlFor="invite-code">Got an invite? Enter the meeting code</label>
        <div className="landing-invite-row">
          <input
            id="invite-code"
            className="kd-field"
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="ABCD"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
          />
          <button type="submit" className="landing-code-go" disabled={code.trim() === ''}>
            Join
          </button>
        </div>
      </form>
    </main>
  );
}
