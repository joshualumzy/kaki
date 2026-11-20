import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { CONTROL_TOPIC, MAX_TYPED_LENGTH, NPC_STATE_TOPIC, type ControlMessage, type NpcStateMessage } from '@kaki/shared';
import { type KakiRejection } from '../kaki';

/** Often enough that the server knows keys are being pressed, rarely enough not to flood the connection. */
const TYPING_SIGNAL_EVERY_MS = 400;
/** Give up waiting for the server's record and fall back to it after this long. */
const PENDING_PAUSE_TIMEOUT_MS = 5_000;
/** How long a failed pause notice stays visible. */
const PAUSE_NOTICE_MS = 5_000;

interface TypeBarProps {
  /** Deliver a command. Return false, or a promise resolving false, when it could not be sent. */
  send(message: ControlMessage): boolean | void | Promise<boolean | void>;
  /** Called once a typed line actually leaves the browser, so the server can record it too. */
  onTextSent?(text: string): void;
  /** The server record's paused flag; the button never keeps its own copy. */
  paused?: boolean;
  canLock?: boolean;
  /**
   * Ask the server to pause or resume over the browser's own hub socket. Returning false means the
   * command never left the browser (the socket was down), so the button must revert at once.
   */
  onPauseChange?(paused: boolean): boolean | void;
  /** The latest command the server refused, so a refused pause can revert with a notice. */
  pauseRejection?: Pick<KakiRejection, 'commandType' | 'reason'> | null;
  /** A refused human line, so the person sees why their words were not recorded and can try again. */
  lineRejection?: Pick<KakiRejection, 'commandType' | 'reason' | 'text'> | null;
}

/**
 * Type to the AI attendees instead of speaking, and stop them with a button or Escape. It works when
 * the room is too noisy to be heard, and the "typing" signal tells the server that a short sound in
 * the microphone is probably a key press, so typing does not cut an attendee off.
 */
export function TypeBar({
  send,
  onTextSent,
  paused = false,
  canLock = false,
  onPauseChange,
  pauseRejection = null,
  lineRejection = null,
}: TypeBarProps) {
  const [text, setText] = useState('');
  const [pendingPaused, setPendingPaused] = useState<boolean | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const lastSignal = useRef(0);
  /** The rejection already showing when this request started must not be blamed on it. */
  const rejectionBeforeRequest = useRef<Pick<KakiRejection, 'commandType' | 'reason'> | null>(null);
  /** The direction of the latest request, kept after a failure so a late record can clear a false notice. */
  const requestedPause = useRef<boolean | undefined>(undefined);
  /** A typed line held back until the record confirms the resume; it is never sent if the resume fails. */
  const awaitingSendText = useRef<string | null>(null);
  /** Whether a failed resume belongs to a typed line, so the notice can say the message was not sent. */
  const resumeKeptMessage = useRef(false);
  /** The last line this box submitted, so a refusal can put the words back for another try. */
  const lastLine = useRef<string | null>(null);

  /** Send a typed line, clearing the box and recording it only once delivery is confirmed. */
  const deliverText = useCallback(
    (typed: string): void => {
      setNotice(undefined);
      const confirm = (delivered: boolean): void => {
        if (!delivered) {
          setNotice("Couldn't send your line, try again");
          return;
        }
        onTextSent?.(typed);
        setText((current) => (current.trim() === typed ? '' : current));
      };
      let outcome: boolean | void | Promise<boolean | void>;
      try {
        outcome = send({ kind: 'text', text: typed });
      } catch {
        confirm(false);
        return;
      }
      if (outcome instanceof Promise) {
        setSending(true);
        outcome.then(
          (delivered) => {
            setSending(false);
            confirm(delivered !== false);
          },
          () => {
            setSending(false);
            confirm(false);
          },
        );
        return;
      }
      confirm(outcome !== false);
    },
    [onTextSent, send],
  );

  const failRequest = useCallback((direction: boolean) => {
    setPendingPaused(undefined);
    awaitingSendText.current = null;
    setNotice(
      direction
        ? "Couldn't pause, try again"
        : resumeKeptMessage.current
          ? "Couldn't resume, your message wasn't sent"
          : "Couldn't resume, try again",
    );
  }, []);

  /** Ask the server and the runner for a pause; the server's record still owns the final state. */
  const requestPause = useCallback(
    (next: boolean): boolean => {
      rejectionBeforeRequest.current = pauseRejection;
      resumeKeptMessage.current = false;
      requestedPause.current = next;
      setNotice(undefined);
      setPendingPaused(next);
      // The runner stops speaking at once; the server owns the meeting's actual pause.
      send({ kind: next ? 'stop' : 'resume' });
      const sent = onPauseChange?.(next);
      if (sent === false) {
        failRequest(next);
        return false;
      }
      return true;
    },
    [failRequest, onPauseChange, pauseRejection, send],
  );

  /** Typing resumes the meeting through the server, without pretending the runner may un-gate itself. */
  const requestServerResume = useCallback(
    (keptMessage: boolean): boolean => {
      rejectionBeforeRequest.current = pauseRejection;
      resumeKeptMessage.current = keptMessage;
      requestedPause.current = false;
      setNotice(undefined);
      setPendingPaused(false);
      const sent = onPauseChange?.(false);
      if (sent === false) {
        failRequest(false);
        return false;
      }
      return true;
    },
    [failRequest, onPauseChange, pauseRejection],
  );

  // The server record is the source of truth: a matching record ends the brief pending state.
  useEffect(() => {
    if (pendingPaused === undefined) {
      // A record that arrives after a timeout or refusal proves the request did land after all.
      if (requestedPause.current !== undefined && paused === requestedPause.current) {
        requestedPause.current = undefined;
        setNotice(undefined);
      }
      return;
    }
    if (paused !== pendingPaused) return;
    setPendingPaused(undefined);
    setNotice(undefined);
    requestedPause.current = undefined;
    // A resume the person asked for by typing only sends their line once the record confirms it.
    if (pendingPaused === false && awaitingSendText.current !== null) {
      const queued = awaitingSendText.current;
      awaitingSendText.current = null;
      deliverText(queued);
    }
  }, [paused, pendingPaused, deliverText]);

  // A command the server refuses reverts to the current record and explains itself.
  useEffect(() => {
    if (pendingPaused === undefined || pauseRejection === null) return;
    if (pauseRejection === rejectionBeforeRequest.current) return;
    if (pauseRejection.commandType !== 'SET_PAUSED') return;
    failRequest(pendingPaused);
  }, [failRequest, pauseRejection, pendingPaused]);

  // A refused line (the meeting has not started, has ended, or changed) says why and puts the
  // words back in the box, so it never disappears without a trace.
  useEffect(() => {
    if (lineRejection === null || lineRejection.commandType !== 'HUMAN_LINE') return;
    setNotice(`Couldn't add your line: ${lineRejection.reason}`);
    const lost = lineRejection.text ?? lastLine.current;
    if (lost !== null && lost.trim() !== '') {
      setText((current) => (current.trim() === '' ? lost : current));
    }
  }, [lineRejection]);

  // A record that never arrives must not leave the button stuck in its pending state.
  useEffect(() => {
    if (pendingPaused === undefined) return;
    const timer = setTimeout(() => failRequest(pendingPaused), PENDING_PAUSE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [failRequest, pendingPaused]);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), PAUSE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const togglePause = useCallback(() => {
    if (
      document.querySelector('.kd-start-backdrop') !== null ||
      document.querySelector('.kd-meeting[data-needs-start="true"]') !== null
    ) {
      return;
    }
    if (pendingPaused !== undefined) return;
    void requestPause(!paused);
  }, [pendingPaused, paused, requestPause]);

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
      if (paused || pendingPaused === true) void requestServerResume(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('kaki:quick-line', onQuickLine);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('kaki:quick-line', onQuickLine);
    };
  }, [pendingPaused, paused, requestServerResume, togglePause]);

  function submit(): void {
    if (sending) return;
    const typed = text.trim();
    if (typed.length === 0) return;
    lastLine.current = typed;
    // Typing is the person taking their turn: resume the meeting they had paused. The line stays in
    // the box and is only sent once the server's record confirms the resume, so a failed or refused
    // resume never sends it.
    if (paused || pendingPaused !== undefined) {
      if (pendingPaused !== false && !requestServerResume(true)) return;
      resumeKeptMessage.current = true;
      awaitingSendText.current = typed;
      return;
    }
    deliverText(typed);
  }

  const pending = pendingPaused !== undefined;
  const label = pending ? (pendingPaused ? 'Pausing…' : 'Resuming…') : paused ? '▶ Play' : '⏸ Pause';

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
      <button type="submit" className="kd-send" disabled={sending || text.trim().length === 0}>
        Send
      </button>
      <button type="button" disabled={!canLock} onClick={() => send({ kind: 'lock' })}>
        Lock in my decision
      </button>
      <button
        type="button"
        className="kd-stop"
        data-paused={paused}
        data-pending={pending}
        aria-pressed={paused}
        aria-busy={pending}
        disabled={pending}
        onClick={togglePause}
        title={paused ? 'Play / resume the meeting (Space)' : 'Pause the meeting (Space or Esc)'}
      >
        {label}
      </button>
      {notice !== undefined && (
        <span className="kd-typebar-notice" role="alert">
          {notice}
        </span>
      )}
    </form>
  );
}

/** The type bar wired to the LiveKit room it is in. */
export function ConnectedTypeBar({
  micOnline,
  paused,
  onTextSent,
  onPauseChange,
  pauseRejection,
  lineRejection,
}: {
  micOnline?: boolean;
  paused?: boolean;
  onTextSent?(text: string): void;
  onPauseChange?(paused: boolean): boolean | void;
  pauseRejection?: Pick<KakiRejection, 'commandType' | 'reason'> | null;
  lineRejection?: Pick<KakiRejection, 'commandType' | 'reason'> | null;
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
    async (message: ControlMessage): Promise<boolean> => {
      try {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify(message)),
          { reliable: true, topic: CONTROL_TOPIC },
        );
        return true;
      } catch {
        return false;
      }
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
      <TypeBar
        send={send}
        canLock={canLock}
        {...(onTextSent === undefined ? {} : { onTextSent })}
        {...(paused === undefined ? {} : { paused })}
        {...(onPauseChange === undefined ? {} : { onPauseChange })}
        {...(pauseRejection === undefined ? {} : { pauseRejection })}
        {...(lineRejection === undefined ? {} : { lineRejection })}
      />
    </div>
  );
}
