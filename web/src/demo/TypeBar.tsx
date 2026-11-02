import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { CONTROL_TOPIC, MAX_TYPED_LENGTH, type ControlMessage } from '@kaki/shared';

const bar: CSSProperties = {
  display: 'flex',
  gap: '8px',
  padding: '8px 10px',
  backgroundColor: '#111827',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const field: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1px solid #374151',
  backgroundColor: '#1f2937',
  color: 'white',
  fontSize: '16px',
};

const button: CSSProperties = {
  padding: '10px 14px',
  borderRadius: '8px',
  border: 'none',
  fontSize: '15px',
  cursor: 'pointer',
  color: 'white',
};

/** Often enough that the server knows keys are being pressed, rarely enough not to flood the connection. */
const TYPING_SIGNAL_EVERY_MS = 400;

export interface TypeBarProps {
  send(message: ControlMessage): void;
}

/**
 * Type to the AI attendees instead of speaking, and stop them with a button or Escape. It works when
 * the room is too noisy to be heard, and the "typing" signal tells the server that a short sound in
 * the microphone is probably a key press, so typing does not cut an attendee off.
 */
export function TypeBar({ send }: TypeBarProps) {
  const [text, setText] = useState('');
  const lastSignal = useRef(0);

  const stop = useCallback(() => send({ kind: 'stop' }), [send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop]);

  function submit(): void {
    const typed = text.trim();
    if (typed.length === 0) return;
    send({ kind: 'text', text: typed });
    setText('');
  }

  return (
    <form
      style={bar}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        aria-label="Type to the meeting"
        style={field}
        value={text}
        maxLength={MAX_TYPED_LENGTH}
        placeholder="Type here instead of speaking, then press Enter"
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') return;
          const now = Date.now();
          if (now - lastSignal.current >= TYPING_SIGNAL_EVERY_MS) {
            lastSignal.current = now;
            send({ kind: 'typing' });
          }
        }}
      />
      <button type="submit" style={{ ...button, backgroundColor: '#2563eb' }} disabled={text.trim().length === 0}>
        Send
      </button>
      <button type="button" style={{ ...button, backgroundColor: '#b91c1c' }} onClick={stop} title="Stop the AI attendees talking (Esc)">
        Stop
      </button>
    </form>
  );
}

/** The type bar wired to the LiveKit room it is in. */
export function ConnectedTypeBar() {
  const room = useRoomContext();
  const send = useCallback(
    (message: ControlMessage) => {
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
        .catch(() => undefined);
    },
    [room],
  );
  return <TypeBar send={send} />;
}
