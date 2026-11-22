import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import { Button, Card } from '../ui';
import { storeRealJoinName, storeRealMeetingCode } from '../meeting/room/rejoinSession';
import { getMeetingInfo, joinMeeting, type MeetingInfo } from './api';
import './product.css';

/** What a visitor sees from a meeting link before they join. */
export function JoinPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') ?? '';
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe();
  const [info, setInfo] = useState<MeetingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (inviteCode.trim() !== '') storeRealMeetingCode(id, inviteCode.trim());
  }, [id, inviteCode]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setLoadError(null);
    setNotFound(false);
    getMeetingInfo(id)
      .then((meeting) => {
        if (!cancelled) setInfo(meeting);
      })
      .catch((meetingError: unknown) => {
        if (cancelled) return;
        const status =
          typeof meetingError === 'object' && meetingError !== null && 'status' in meetingError
            ? (meetingError as { status: unknown }).status
            : undefined;
        if (status === 404) {
          setNotFound(true);
          return;
        }
        setLoadError(
          meetingError instanceof Error ? meetingError.message : 'Could not load this meeting.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  async function join(asName?: string): Promise<void> {
    if (joining) return;
    if (asName !== undefined) {
      const trimmed = asName.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        setJoinError('Enter your name (1-40 characters).');
        return;
      }
    }
    setJoining(true);
    setJoinError(null);
    try {
      const joined = await joinMeeting(id, asName === undefined ? undefined : asName.trim());
      storeRealJoinName(id, joined.name);
      navigate(`/m/${encodeURIComponent(id)}/room`, { replace: true });
    } catch (joinFailure) {
      setJoinError(
        joinFailure instanceof Error ? joinFailure.message : 'Could not join this meeting.',
      );
    } finally {
      setJoining(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void join(name);
  }

  const user =
    auth.status === 'ready' && auth.me.authEnabled && auth.me.kind === 'user'
      ? auth.me.user
      : null;
  const signedIn = user !== null;
  const plannedInFuture =
    info?.scheduledFor !== null &&
    info?.scheduledFor !== undefined &&
    Date.parse(info.scheduledFor) > Date.now();

  return (
    <main className="page product-page product-page-narrow">
      {notFound ? (
        <Card title="This meeting link isn't valid">
          <p className="product-hint">Check the link, or ask the meeting owner for a new one.</p>
          <Link className="product-open" to="/">
            Go to Kaki
          </Link>
        </Card>
      ) : null}

      {loadError === null ? null : (
        <Card title="Could not load this meeting">
          <p className="connection-banner" role="alert">
            {loadError}
          </p>
          <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      )}

      {info === null ? (
        !notFound && loadError === null ? (
          <p className="empty-state" role="status">
            Loading this meeting…
          </p>
        ) : null
      ) : (
        <>
          <header className="page-header">
            <p className="eyebrow">You are invited</p>
            <h1>{info.title}</h1>
            <p className="page-subtitle">
              {info.workspaceName === null ? 'A Kaki meeting' : info.workspaceName}
              {info.ownerName === null ? '' : ` · Hosted by ${info.ownerName}`}
            </p>
          </header>

          {plannedInFuture ? (
            <p className="product-note">
              {`This meeting is planned for ${new Date(info.scheduledFor ?? '').toLocaleString()}. You can join early.`}
            </p>
          ) : null}

          <p className="product-notice">Kaki transcribes this meeting</p>

          <section className="card product-section" aria-label="Join this meeting">
            {signedIn && user !== null ? (
              <>
                <p className="product-hint">You will join as {user.name}.</p>
                <Button onClick={() => void join()} disabled={joining}>
                  {joining ? 'Joining…' : 'Join meeting'}
                </Button>
              </>
            ) : (
              <form className="product-form" onSubmit={submit}>
                {auth.status === 'error' ? (
                  <p className="product-hint" role="status">
                    Could not check sign-in; you can join with your name.
                  </p>
                ) : null}
                <label className="product-field">
                  <span>Your name</span>
                  <input
                    className="product-input"
                    value={name}
                    maxLength={40}
                    autoComplete="name"
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                {joinError === null ? null : (
                  <p className="product-error" role="alert">
                    {joinError}
                  </p>
                )}
                <Button type="submit" disabled={joining}>
                  {joining ? 'Joining…' : 'Join meeting'}
                </Button>
              </form>
            )}
            {signedIn && joinError !== null ? (
              <p className="product-error" role="alert">
                {joinError}
              </p>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

