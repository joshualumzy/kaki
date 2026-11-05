import { useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { CONTROL_TOPIC, type ControlMessage } from '@kaki/shared';
import './demo.css';

export interface StartPromptProps {
  /** The person pressed the button: the meeting should begin. */
  onStart(): void;
}

/**
 * Covers the meeting stage until the person has read their briefing (the role card and the situation in the dock)
 * and presses Start. The AI attendees are already in the room but stay silent until then.
 */
export function StartPrompt({ onStart }: StartPromptProps) {
  return (
    <div className="kd-start" role="region" aria-label="Before the meeting starts">
      <div className="kd-start-card">
        <h2>Read your briefing first</h2>
        <p>
          Your role card and the situation are in the <b>Kaki Wingman</b> panel (on a phone, tap the <b>Kaki</b> tab). Take as long as you need.
        </p>
        <p>Your colleagues are in the room, but they stay quiet until you start the meeting.</p>
        <button type="button" className="kd-go" onClick={onStart} autoFocus>
          Start the meeting
        </button>
      </div>
    </div>
  );
}

/** The start prompt wired to the LiveKit room it is in. */
export function ConnectedStartPrompt({ onStarted }: { onStarted(): void }) {
  const room = useRoomContext();
  const start = useCallback(() => {
    const message: ControlMessage = { kind: 'start' };
    room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
      .catch(() => undefined);
    onStarted();
  }, [room, onStarted]);
  return <StartPrompt onStart={start} />;
}
