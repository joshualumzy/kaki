import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { CONTROL_TOPIC, MAX_TYPED_LENGTH, NPC_STATE_TOPIC, type ControlMessage, type NpcStateMessage } from '@kaki/shared';

/** Often enough that the server knows keys are being pressed, rarely enough not to flood the connection. */
const TYPING_SIGNAL_EVERY_MS = 400;

export interface TypeBarProps {
  send(message: ControlMessage): void;
  canLock?: boolean;
  /**
   * The person's pause intent, sent straight to the server over the browser's own hub socket.
   * The LiveKit `stop`/`resume` above only gates the runner's speech instantly; this owns the meeting.
   */
  onPauseChange?(paused: boolean): void;
}

/**
 * Type to the AI attendees instead of speaking, and stop them with a button or Escape. It works when
 * the room is too noisy to be heard, and the "typing" signal tells the server that a short sound in
 * the microphone is probably a key press, so typing does not cut an attendee off.
 */
export function TypeBar({ send, canLock = false, onPauseChange }: TypeBarProps) {
  const [text, setText] = useState('');
  const [paused, setPaused] = useState(false);
  const lastSignal = useRef(0);

  const togglePause = useCallback(() => {
    if (
      document.querySelector('.kd-start-backdrop') !== null ||
      document.querySelector('.kd-meeting[data-needs-start="true"]') !== null
    ) {
      return;
    }
    const next = !paused;
    setPaused(next);
    // The runner stops speaking at once; the server owns the meeting's actual pause.
    send({ kind: next ? 'stop' : 'resume' });
    onPauseChange?.(next);
  }, [send, onPauseChange, paused]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Never let any key pressed during the tutorial / pre-start overlay impact the meeting.
      if (
        document.querySelector('.kd-start-backdrop') !== null ||
        document.querySelector('.kd-meeting[data-needs-start="true"]') !== null
      ) {
        return;
      }
      if (event.key === 'Escape') {
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        togglePause();
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest('input, textarea, select, button, a, [role="button"], [role="radio"], .kd-start-backdrop') !== null)
        ) {
          return;
        }
        event.preventDefault();
        togglePause();
      }
    };
    const onQuickLine = (): void => {
      // A starter line is the person taking their turn: resume the meeting they had paused.
      if (paused) onPauseChange?.(false);
      setPaused(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('kaki:quick-line', onQuickLine);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('kaki:quick-line', onQuickLine);
    };
  }, [togglePause]);

  function submit(): void {
    const typed = text.trim();
    if (typed.length === 0) return;
    // Typing is the person taking their turn: resume the meeting they had paused.
    if (paused) {
      setPaused(false);
      onPauseChange?.(false);
    }
    send({ kind: 'text', text: typed });
    setText('');
  }

  return (
    <form
      className="kd-typebar"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        aria-label="Type to the meeting"
        value={text}
        maxLength={MAX_TYPED_LENGTH}
        placeholder="Type to speak, press Enter"
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
      <button type="submit" className="kd-send" disabled={text.trim().length === 0}>
        Send
      </button>
      <button type="button" disabled={!canLock} onClick={() => send({ kind: 'lock' })}>
        Lock in my decision
      </button>
      <button
        type="button"
        className="kd-stop"
        data-paused={paused}
        aria-pressed={paused}
        onClick={togglePause}
        title={paused ? 'Play / resume the meeting (Space)' : 'Pause the meeting (Space or Esc)'}
      >
        {paused ? '▶ Play' : '⏸ Pause'}
      </button>
    </form>
  );
}

/** The type bar wired to the LiveKit room it is in. */
export function ConnectedTypeBar({
  micOnline,
  onPauseChange,
}: {
  micOnline?: boolean;
  onPauseChange?(paused: boolean): void;
}) {
  const room = useRoomContext();
  const [canLock, setCanLock] = useState(false);
  useEffect(() => {
    const onData = (payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string): void => {
      if (topic !== NPC_STATE_TOPIC) return;
      try {
        const state = JSON.parse(new TextDecoder().decode(payload)) as NpcStateMessage;
        setCanLock(state.kind === 'idle' || state.kind === 'thinking' || state.kind === 'speaking' ? state.canLock === true : false);
      } catch { /* Keep the last known state until the next valid update. */ }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => { room.off(RoomEvent.DataReceived, onData); };
  }, [room]);
  const send = useCallback(
    (message: ControlMessage) => {
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
        .catch(() => undefined);
    },
    [room],
  );
  return (
    <div className="kd-typebar-wrap">
      {micOnline !== undefined && (
        <span
          className="kd-mic-online-pill"
          data-online={micOnline}
          title={
            micOnline
              ? 'Server speech recognition is online and listening to your microphone'
              : 'Microphone is muted. Unmute below to speak, or type in the bar.'
          }
        >
          <i className="kd-mic-online-dot" />
          {micOnline ? 'Voice active' : 'Mic muted'}
        </span>
      )}
      <TypeBar send={send} canLock={canLock} {...(onPauseChange === undefined ? {} : { onPauseChange })} />
    </div>
  );
}
