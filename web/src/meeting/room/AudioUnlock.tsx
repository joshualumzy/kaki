import { useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

/**
 * Mobile browsers may refuse to play the AI voices until the person taps. LiveKit reports that
 * through `canPlaybackAudio`; keep a visible way to unlock the sound instead of leaving the meeting silent.
 */
export function AudioUnlockPrompt() {
  const room = useRoomContext();
  const [blocked, setBlocked] = useState(() => room.canPlaybackAudio === false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    const update = (): void => {
      const nowBlocked = room.canPlaybackAudio === false;
      setBlocked(nowBlocked);
      if (!nowBlocked) setProblem(undefined);
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, update);
    update();
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, update);
    };
  }, [room]);

  if (!blocked) return null;

  async function start(): Promise<void> {
    setStarting(true);
    setProblem(undefined);
    try {
      await room.startAudio();
      setBlocked(room.canPlaybackAudio === false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The browser still blocked the sound.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="kd-audio-unlock" role="region" aria-label="Meeting sound">
      <p>Your phone is holding the meeting sound until you tap.</p>
      <button type="button" className="kd-go" onClick={() => void start()} disabled={starting}>
        {starting ? 'Turning on sound…' : 'Tap to turn on sound'}
      </button>
      {problem === undefined ? null : (
        <p role="alert" className="kd-alert">
          {problem}
        </p>
      )}
    </div>
  );
}
