import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { aiCast, CONTROL_TOPIC, NPC_STATE_TOPIC, type AgendaItem, type ControlMessage, type NpcStateMessage, type Scenario, type ScenarioRole } from '@kaki/shared';
import { useScenario } from '../kaki';
import './demo.css';

export interface StartPromptProps {
  /** The person pressed the button: the meeting should begin. */
  onStart(): void;
  /** The visitor's chosen role in the scenario, when known. */
  role?: ScenarioRole;
  /** The visitor's display name, when known. */
  viewerName?: string;
  /** The scenario character seat name replaced by the visitor, when known. */
  seatName?: string;
  /** A Start has been sent and the room has not confirmed it yet. */
  starting?: boolean;
  /** Why the Start did not reach the room; the button can be pressed again. */
  startError?: string;
}

const HERO_ART = '/scenario/kopitiam-hero.svg';

function safeUseScenario(): Scenario | undefined {
  try {
    return useScenario();
  } catch {
    return undefined;
  }
}

/**
 * Covers the meeting stage with a two-screen briefing (who you are and today's calls, then how to play) until the
 * person presses Start. The AI attendees are already in the room but stay silent until then.
 */
export function StartPrompt({ onStart, role, viewerName, seatName, starting = false, startError }: StartPromptProps) {
  const scenario = safeUseScenario();
  const [stepIndex, setStepIndex] = useState<0 | 1>(0);

  useEffect(() => {
    if (typeof Image === 'undefined') return;
    for (const src of [HERO_ART, ...(scenario?.agenda.map((item) => item.art ?? HERO_ART) ?? [])]) {
      const img = new Image();
      img.src = src;
    }
  }, [scenario]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setStepIndex(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setStepIndex(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const trimmedName = viewerName?.trim();
  const card = role?.card;
  const youAre =
    card !== undefined && trimmedName !== undefined && trimmedName.length > 0 && seatName !== undefined && seatName.length > 0
      ? card.youAre.replace(seatName, trimmedName)
      : card?.youAre;

  const agendaItems: readonly AgendaItem[] = scenario?.agenda ?? [];
  const topicCount = agendaItems.length > 0 ? agendaItems.length : 2;
  const totalMinutes = agendaItems.length > 0
    ? agendaItems.reduce((sum, item) => sum + (Number.isFinite(item.minutes) ? item.minutes : 0), 0)
    : topicCount * 5;
  const stepLabels = ['1. Your role', '2. How to play'] as const;

  return (
    <div className="kd-start" role="region" aria-label="Before the meeting starts">
      <div className="kd-start-card kd-start-card-wide">
        <div className="kd-start-steps" role="tablist" aria-label="Quick tour">
          {stepLabels.map((label, idx) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={idx === stepIndex}
              className="kd-start-step-pill"
              onClick={() => setStepIndex(idx as 0 | 1)}
            >
              {label}
            </button>
          ))}
        </div>

        {stepIndex === 0 ? (
          <div className="kd-story-step">
            <div className="kd-story-hero">
              <img src={HERO_ART} alt="Nanyang Kopi & Toast Raffles Place Flagship" className="kd-story-hero-img" />
              <div className="kd-story-hero-overlay">
                <span className="kd-story-badge">
                  {scenario?.organisation ?? 'Nanyang Kopi & Toast'} · Opening day
                </span>
                <h2>{scenario?.meetingTitle ?? 'Raffles Place Flagship Opening Day'}</h2>
              </div>
            </div>

            <div className="kd-story-role-box">
              <p className="kd-story-shop-intro">
                Our renovated <strong>Nanyang Kopi &amp; Toast</strong> flagship at <strong>Raffles Place</strong> opens this morning. You’re opening-day lead: the team has {totalMinutes} minutes, and the calls are yours.
              </p>
              {role !== undefined && card !== undefined && (
                <p className="kd-story-role-headline">
                  <strong>🪑 {youAre}</strong>
                </p>
              )}
              {agendaItems.length > 0 && (
                <div>
                  <p className="kd-role-eyebrow" style={{ margin: '0 0 6px' }}>Today’s {topicCount} calls</p>
                  <ol className="kd-start-topics">
                    {agendaItems.map((item) => (
                      <li key={item.title}>
                        {item.title} <span>· {item.minutes} min</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="kd-story-step">
            <h2 style={{ margin: 0 }}>How to play</h2>
            <ul className="kd-start-howto">
              <li>
                <b>Talk:</b> speak into your mic, or type in the box under the meeting.
              </li>
              <li>
                <b>Pause:</b> press <kbd>Space</kbd> or <kbd>Esc</kbd> any time you need a moment.
              </li>
              <li>
                <b>Kaki:</b> the Kaki panel (on the right, or below on a phone) shows the key facts for each call, and drafts your follow-up messages for you.
              </li>
            </ul>
          </div>
        )}

        <p className="kd-start-quiet-note">
          Your colleagues are in the room, but they stay quiet until you start the meeting.
        </p>
        {(starting || startError !== undefined) && (
          <p className="kd-start-quiet-note" role="status" aria-live="polite">
            {starting ? 'Starting the meeting… waiting for the room to confirm.' : startError}
          </p>
        )}
        <div className="kd-start-actions">
          {stepIndex === 0 ? (
            <button type="button" className="kd-go" style={{ marginTop: 0, flex: 1 }} onClick={() => setStepIndex(1)} autoFocus>
              Next: How to play →
            </button>
          ) : (
            <>
              <button
                type="button"
                className="kd-chip"
                style={{ padding: '10px 14px', fontWeight: 600 }}
                onClick={() => setStepIndex(0)}
              >
                ← Back
              </button>
              <button
                type="button"
                className="kd-go"
                style={{ marginTop: 0, flex: 1 }}
                onClick={onStart}
                disabled={starting}
                autoFocus
                aria-label="Start the meeting"
              >
                {starting ? 'Starting…' : startError !== undefined ? 'Try again' : 'Start the meeting'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const START_RETRY_MS = 750;
const START_TIMEOUT_MS = 8000;

/**
 * The start prompt wired to the LiveKit room it is in. Start is sent with a request id and the visitor's
 * session, retried until the NPC acknowledges that exact request, and reported as failed when it does not.
 */
export function ConnectedStartPrompt({
  onStarted,
  role,
  viewerName,
  seatName,
}: {
  onStarted(): void;
  role?: ScenarioRole;
  viewerName?: string;
  seatName?: string;
}) {
  const room = useRoomContext();
  const scenario = safeUseScenario();
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'failed'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const request = useRef<{ requestId: string; session: string } | undefined>(undefined);
  const publishError = useRef<string | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);

  const stopTimers = useCallback(() => {
    if (retryTimer.current !== undefined) clearInterval(retryTimer.current);
    if (timeoutTimer.current !== undefined) clearTimeout(timeoutTimer.current);
    retryTimer.current = undefined;
    timeoutTimer.current = undefined;
  }, []);

  const publish = useCallback(() => {
    const pending = request.current;
    if (pending === undefined) return;
    if ((room as { state?: ConnectionState }).state !== undefined && (room as { state?: ConnectionState }).state !== ConnectionState.Connected) {
      return;
    }
    const session = room.localParticipant?.identity;
    if (session === undefined || session.length === 0) return;
    pending.session = session;
    const message: ControlMessage = { kind: 'start', ...pending };
    console.info(`[kaki:start] browser publishing Start request=${pending.requestId} session=${pending.session}`);
    room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
      .then(() => {
        if (request.current === pending) publishError.current = undefined;
      })
      .catch((cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[kaki:start] browser Start publish failed request=${pending.requestId}: ${reason}`);
        if (request.current === pending) publishError.current = reason;
      });
  }, [room]);

  useEffect(() => {
    const handler = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
      if (topic !== NPC_STATE_TOPIC || participant === undefined) return;
      const pending = request.current;
      if (pending === undefined) return;
      // Only the character the runner keeps in the room as its permanent listener may acknowledge.
      const npcs = scenario?.npcs ?? [];
      const listener = scenario === undefined ? undefined : aiCast(scenario)[0] ?? npcs.find((npc) => npc.role === 'host') ?? npcs[0];
      if (listener === undefined || participant.identity !== listener.attendee) return;
      let ack: NpcStateMessage;
      try {
        ack = JSON.parse(new TextDecoder().decode(payload)) as NpcStateMessage;
      } catch {
        return;
      }
      // Only the exact request from this visitor may open the meeting.
      if (ack.kind !== 'started' || ack.requestId !== pending.requestId || ack.session !== pending.session) return;
      if (started.current) return;
      console.info(`[kaki:start] browser received Start ack request=${ack.requestId} from=${participant.identity}`);
      started.current = true;
      stopTimers();
      request.current = undefined;
      setPhase('idle');
      onStarted();
    };
    const onConnected = () => {
      if (request.current !== undefined) publish();
    };
    room.on(RoomEvent.DataReceived, handler);
    room.on(RoomEvent.Connected, onConnected);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
      room.off(RoomEvent.Connected, onConnected);
    };
  }, [room, scenario, onStarted, stopTimers, publish]);

  useEffect(() => () => stopTimers(), [stopTimers]);

  const start = useCallback(() => {
    if (request.current !== undefined) return;
    if (scenario === undefined) {
      console.warn('[kaki:start] Start rejected in browser: scenario is not loaded yet');
      setError('The meeting is not ready yet. Wait a moment and try again.');
      setPhase('failed');
      return;
    }
    const roomState = (room as { state?: ConnectionState }).state;
    const session = room.localParticipant?.identity ?? '';
    if (roomState === undefined && session.length === 0) {
      console.warn('[kaki:start] Start rejected in browser: room is not connected yet');
      setError('The meeting is not connected yet. Wait a moment and try again.');
      setPhase('failed');
      return;
    }
    started.current = false;
    publishError.current = undefined;
    request.current = {
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      session,
    };
    console.info(`[kaki:start] browser Start clicked request=${request.current.requestId} state=${roomState ?? 'connected'} session=${session || '(connecting)'}`);
    setError(undefined);
    setPhase('waiting');
    publish();
    retryTimer.current = setInterval(publish, START_RETRY_MS);
    timeoutTimer.current = setTimeout(() => {
      const expired = request.current;
      stopTimers();
      request.current = undefined;
      const npcs = scenario?.npcs ?? [];
      const listener = scenario === undefined ? undefined : aiCast(scenario)[0] ?? npcs.find((npc) => npc.role === 'host') ?? npcs[0];
      const remoteParticipants = (room as { remoteParticipants?: Map<string, { identity: string }> }).remoteParticipants;
      const listenerPresent =
        listener === undefined ||
        remoteParticipants === undefined ||
        [...remoteParticipants.values()].some((p) => p.identity === listener.attendee);
      const currentRoomState = (room as { state?: ConnectionState }).state;
      const currentSession = room.localParticipant?.identity ?? '';
      const notConnectedYet =
        (currentRoomState !== undefined && currentRoomState !== ConnectionState.Connected) || currentSession.length === 0;
      const message =
        publishError.current !== undefined
          ? `The room could not send Start (${publishError.current}). Check your connection, then try again.`
          : notConnectedYet
          ? 'The meeting is not connected yet. Wait a moment and try again.'
          : listenerPresent
          ? 'The room did not confirm the start. Check your connection, then try again.'
          : 'Waiting for the AI attendees to join the room (run npm run npc or bash scripts/live-up.sh), then try again.';
      console.warn(`[kaki:start] browser Start timed out request=${expired?.requestId ?? 'unknown'}: ${message}`);
      setPhase('failed');
      setError(message);
    }, START_TIMEOUT_MS);
  }, [room, publish, stopTimers, scenario]);

  return (
    <StartPrompt
      onStart={start}
      role={role}
      viewerName={viewerName}
      seatName={seatName}
      starting={phase === 'waiting'}
      startError={error}
    />
  );
}
