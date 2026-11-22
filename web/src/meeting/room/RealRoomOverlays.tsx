import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMeetingInfo } from '../../product/api';
import { plainServerText } from '../../net/plainFailure';
import { fetchWithTimeout } from '../../net/withTimeout';
import { meetingApiPath } from '../../kaki';
import { useRealRoom } from './realRoom';

/** How long the ended panel waits for the notes lookup before saying the minutes are late. */
const MINUTES_WAIT_MS = 60_000;

const COULD_NOT_START = "Couldn't start the meeting. Try again.";

/** The loud, plain-words notices a real meeting shows above the stage. */
export function RealRoomBanners() {
  const room = useRealRoom();
  if (room === null) return null;
  const { meetingState, send } = room;
  const offTheRecord = meetingState?.offTheRecord ?? null;
  return (
    <div className="kd-real-banners">
      {offTheRecord === null ? null : (
        <div className="kd-real-banner" data-tone="off-record" role="status">
          <span>
            Off the record: nothing is being written down. Say it again after resuming to get it into
            the notes.
          </span>
          <button type="button" className="kd-chip" onClick={() => send({ type: 'SET_OFF_THE_RECORD', on: false })}>
            Resume the notes
          </button>
        </div>
      )}
      {meetingState?.notesPaused === null || meetingState?.notesPaused === undefined ? null : (
        <div className="kd-real-banner" data-tone="warning" role="alert">
          {meetingState.notesPaused}
        </div>
      )}
      {meetingState?.cue === null || meetingState?.cue === undefined ? null : (
        <div className="kd-real-cue" role="status">
          {meetingState.cue.text}
        </div>
      )}
    </div>
  );
}

/** Covers the stage until the owner starts a real meeting; the owner gets the one Start button. */
export function RealWaitingOverlay({ meetingId }: { meetingId: string }) {
  const room = useRealRoom();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  if (room === null || room.meetingState?.waitingForOwner !== true) return null;
  const ownerName = room.meetingState.ownerName?.trim();

  async function start(): Promise<void> {
    if (starting) return;
    setStarting(true);
    setProblem(undefined);
    try {
      const response = await fetchWithTimeout(
        meetingApiPath(meetingId, '/api/meeting/start'),
        { method: 'POST' },
        15_000,
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        message?: unknown;
        started?: unknown;
      };
      if (!response.ok || body.started !== true) {
        setProblem(plainServerText(body.message) ?? plainServerText(body.error) ?? COULD_NOT_START);
      }
    } catch (error) {
      console.error('kaki web: starting the meeting failed', error);
      setProblem(COULD_NOT_START);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="kd-start" role="region" aria-label="Waiting for the meeting to start">
      <div className="kd-start-card">
        <h2>{`Waiting for ${ownerName === undefined || ownerName === '' ? 'the owner' : ownerName} to start`}</h2>
        <p>You are in the meeting room. The meeting begins when the owner starts it.</p>
        {room.isHost ? (
          <button type="button" className="kd-go" onClick={() => void start()} disabled={starting}>
            {starting ? 'Starting…' : problem === undefined ? 'Start the meeting' : 'Try again'}
          </button>
        ) : null}
        {problem === undefined ? null : (
          <p className="kd-alert" role="alert">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}

/** The one panel a real meeting shows after it ends: where the minutes are, or a thank-you. */
export function RealEndedPanel({ meetingId }: { meetingId: string }) {
  const room = useRealRoom();
  const endedWhileAway = room?.endedWhileAway !== undefined && room.meetingState?.phase !== 'ended';
  if (room === null || (room.meetingState?.phase !== 'ended' && !endedWhileAway)) return null;
  return (
    <EndedPanelBody
      meetingId={meetingId}
      ownerName={room.meetingState?.ownerName?.trim() ?? ''}
      title={endedWhileAway ? 'This meeting ended while you were away' : 'Meeting ended'}
    />
  );
}

function EndedPanelBody({
  meetingId,
  ownerName,
  title,
}: {
  meetingId: string;
  ownerName: string;
  title: string;
}) {
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSlow(false);
    // Looking up where the notes are kept must not wait forever: after a minute say they are late.
    const slowTimer = window.setTimeout(() => setSlow(true), MINUTES_WAIT_MS);
    getMeetingInfo(meetingId)
      .then((info) => {
        if (!cancelled) setWorkspaceId(info.historyWorkspaceId);
      })
      .catch((error: unknown) => {
        console.error('kaki web: could not look up where the meeting notes are kept', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
    };
  }, [meetingId, attempt]);
  return (
    <section className="kd-role kd-topic-card" aria-label="Meeting ended">
      <p className="kd-role-eyebrow">{title}</p>
      {typeof workspaceId === 'string' ? (
        <Link
          className="artifact-link"
          to={`/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(meetingId)}`}
        >
          Read the meeting notes
        </Link>
      ) : workspaceId === null ? (
        <p>
          Thanks for joining. The notes are kept by {ownerName === '' ? 'the owner' : ownerName}.
        </p>
      ) : failed || slow ? (
        <>
          <p role="alert" className="kd-alert">
            Minutes are taking longer than usual. They'll appear in the meeting history when ready.
          </p>
          <button type="button" className="kd-chip" onClick={() => setAttempt((count) => count + 1)}>
            Try again
          </button>{' '}
          <Link className="artifact-link" to={`/m/${encodeURIComponent(meetingId)}`}>
            Open the meeting page
          </Link>
        </>
      ) : (
        <p className="kd-hint">Checking where the notes are kept…</p>
      )}
    </section>
  );
}
