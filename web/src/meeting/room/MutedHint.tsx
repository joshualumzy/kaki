import { useEffect, useState } from 'react';
import { useIsSpeaking, useLocalParticipant } from '@livekit/components-react';

/** A local mic level this low is room noise, not a person trying to speak. */
const SPEAKING_LEVEL = 0.02;
/** How often the local participant's own audio level is read while muted. */
const LEVEL_POLL_MS = 200;
/** Keep the hint up briefly after the person stops, so a short word is not missed. */
const HINT_LINGER_MS = 1_200;

/**
 * "You're muted" when the person is talking with their microphone off. LiveKit's speaking flag
 * follows the published track, so while muted we also read the local participant's own audio
 * level: the browser still measures the microphone even when its track is not being sent.
 */
export function MutedHint() {
  const { isMicrophoneEnabled, localParticipant } = useLocalParticipant();
  const speaking = useIsSpeaking(localParticipant);
  const [level, setLevel] = useState(0);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (isMicrophoneEnabled || localParticipant === undefined) {
      setLevel(0);
      return;
    }
    const timer = window.setInterval(() => {
      setLevel(localParticipant.audioLevel ?? 0);
    }, LEVEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isMicrophoneEnabled, localParticipant]);

  const speakingWhileMuted = !isMicrophoneEnabled && (speaking || level > SPEAKING_LEVEL);

  useEffect(() => {
    if (speakingWhileMuted) {
      setShown(true);
      return;
    }
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), HINT_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [speakingWhileMuted, shown]);

  if (isMicrophoneEnabled || !shown) return null;
  return (
    <div className="kd-muted-hint" role="status" aria-live="polite">
      You&apos;re muted — tap the mic to speak.
    </div>
  );
}
