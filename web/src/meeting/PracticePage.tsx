import { useCallback, useEffect, useRef, useState } from 'react';
import { MeetingScopeProvider, ScenarioProvider } from '../kaki';
import { plainFailureMessage } from '../net/plainFailure';
import Meeting from './room/Meeting';

interface Resolved {
  meetingId: string;
}

/**
 * The public practice page. `/practice` and `/demo` keep their URLs; the meeting id is bound to
 * this browser by the server's cookie, so a shared link never puts two visitors in one room.
 */
export function PracticePage() {
  const [resolved, setResolved] = useState<Resolved | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // StrictMode runs the effect twice; both must share one request, or they race and create two
  // practice meetings (one of them orphaned) before either sets the cookie. The body is read once
  // here, because a Response body can only be consumed once.
  const request = useRef<Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setProblem(undefined);
    request.current ??= fetch('/api/practice', { method: 'POST' }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    }));
    void request
      .current
      .then(({ ok, status, body }) => {
        if (cancelled) return;
        const meetingId = typeof body.meetingId === 'string' ? body.meetingId.trim() : '';
        if (ok && meetingId !== '') {
          setResolved({ meetingId });
          return;
        }
        setProblem(plainFailureMessage(status, body.message ?? body.error));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('kaki web: could not open a practice meeting', error);
        setProblem(plainFailureMessage(0));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Used both to retry a failed start and to replace an ended practice: a fresh POST gets the
  // visitor a new meeting (and cookie) from the server, then the room mounts it without a reload.
  const startNewPractice = useCallback(() => {
    request.current = undefined;
    setResolved(undefined);
    setAttempt((value) => value + 1);
  }, []);

  if (resolved !== undefined) {
    return (
      // A layout-neutral wrapper names the meeting for the playtest scripts, before the room joins.
      <div style={{ display: 'contents' }} data-practice-meeting-id={resolved.meetingId}>
        <MeetingScopeProvider meetingId={resolved.meetingId}>
          <ScenarioProvider view="practice" meetingId={resolved.meetingId}>
            <Meeting
              key={resolved.meetingId}
              variant="practice"
              practiceMeetingId={resolved.meetingId}
              onNewPractice={startNewPractice}
            />
          </ScenarioProvider>
        </MeetingScopeProvider>
      </div>
    );
  }

  return (
    <div className="kd-join" role="region" aria-label="Practice meeting">
      <div className="kd-card">
        <div className="kd-live">
          <span className="kd-dot" />
          Practice meeting
        </div>
        <h1 className="kd-title">{busy ? 'Getting your room ready…' : 'Your room is not ready yet'}</h1>
        {problem === undefined ? (
          <p className="kd-hint">This takes a moment.</p>
        ) : (
          <>
            <p role="alert" className="kd-alert">
              {problem}
            </p>
            <button type="button" className="kd-go" onClick={startNewPractice} disabled={busy}>
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
