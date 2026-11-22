import { useState } from 'react';
import { fetchWithTimeout } from '../../net/withTimeout';
import { meetingApiPath } from '../../kaki';
import { useRealRoom } from './realRoom';

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
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; started?: unknown };
      if (!response.ok || body.started !== true) {
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : `Could not start the meeting (HTTP ${response.status}).`,
        );
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not start the meeting.');
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
            {starting ? 'Starting…' : 'Start the meeting'}
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
