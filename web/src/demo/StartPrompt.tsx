import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { aiCast, CONTROL_TOPIC, NPC_STATE_TOPIC, roleLabel, type AgendaItem, type ControlMessage, type NpcStateMessage, type Scenario, type ScenarioRole } from '@kaki/shared';
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
 * Covers the meeting stage until the person has read their briefing (the role card and the situation in the dock)
 * and presses Start. The AI attendees are already in the room but stay silent until then.
 */
export function StartPrompt({ onStart, role, viewerName, seatName, starting = false, startError }: StartPromptProps) {
  const scenario = safeUseScenario();
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlightStop, setSpotlightStop] = useState<'stage' | 'dock'>('stage');

  useEffect(() => {
    if (typeof Image === 'undefined') return;
    for (const src of [HERO_ART, ...(scenario?.agenda.map((item) => item.art ?? HERO_ART) ?? [])]) {
      const img = new Image();
      img.src = src;
    }
  }, [scenario]);

  const goPrev = useCallback(() => {
    if (stepIndex === 2 && spotlightStop === 'dock') {
      setSpotlightStop('stage');
    } else if (stepIndex > 0) {
      setStepIndex((prev) => Math.max(0, prev - 1));
    }
  }, [stepIndex, spotlightStop]);

  const goNext = useCallback(() => {
    if (stepIndex === 0) {
      setStepIndex(1);
    } else if (stepIndex === 1) {
      setSpotlightStop('stage');
      setStepIndex(2);
    } else if (stepIndex === 2 && spotlightStop === 'stage') {
      setSpotlightStop('dock');
    }
  }, [stepIndex, spotlightStop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev]);

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
  const stepLabels = [
    '1. Story & Your Role',
    `2. Today’s ${topicCount} Topics`,
    '3. Live Room Spotlight',
  ];

  if (stepIndex === 2) {
    return (
      <div
        className="kd-start kd-start-spotlight-mode"
        data-spotlight={spotlightStop}
        role="region"
        aria-label="Before the meeting starts"
      >
        <div
          className="kd-spotlight-frame"
          data-target={spotlightStop}
          aria-hidden="true"
        />

        <div className="kd-spotlight-popover" data-target={spotlightStop}>
          <div className="kd-start-steps" role="tablist" aria-label="Quick tour" style={{ marginBottom: 10 }}>
            {stepLabels.map((label, idx) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={idx === stepIndex}
                className="kd-start-step-pill"
                onClick={() => setStepIndex(idx)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="kd-spotlight-tabs">
            <button
              type="button"
              className="kd-spotlight-tab"
              data-active={spotlightStop === 'stage'}
              onClick={() => setSpotlightStop('stage')}
            >
              1. Stage &amp; Controls
            </button>
            <button
              type="button"
              className="kd-spotlight-tab"
              data-active={spotlightStop === 'dock'}
              onClick={() => setSpotlightStop('dock')}
            >
              2. Kaki Wingman →
            </button>
          </div>

          {spotlightStop === 'stage' ? (
            <div className="kd-spotlight-body">
              <span className="kd-spotlight-eyebrow">Highlighting · Live Meeting Stage</span>
              <h3>How to talk with the team</h3>
              <ul className="kd-spotlight-list">
                <li>
                  <b>1. Listen:</b> Colleagues speak with live captions on their tiles.
                </li>
                <li>
                  <b>2. Reply:</b> Speak on mic, type below, or click a question idea.
                </li>
                <li>
                  <b>3. Pause anytime:</b> Click <b>Pause</b> (or <code>Esc</code>) if you need a moment.
                </li>
              </ul>
            </div>
          ) : (
            <div className="kd-spotlight-body">
              <span className="kd-spotlight-eyebrow">Highlighting · Kaki Wingman Dock</span>
              <h3>Your personal AI Wingman</h3>
              <ul className="kd-spotlight-list">
                <li>
                  <b>1. Instant facts:</b> Kaki glides in with store numbers whenever you need them.
                </li>
                <li>
                  <b>2. Auto-drafts:</b> Click <b>Let Kaki do it</b> when a follow-up task is assigned to you.
                </li>
                <li>
                  <b>3. One-click send:</b> Approve Kaki’s draft to post to Mattermost, Gitea, or Email.
                </li>
              </ul>
            </div>
          )}

          <p className="kd-start-quiet-note" style={{ marginTop: 8 }}>
            Your colleagues are in the room, but they stay quiet until you start the meeting.
          </p>
          {(starting || startError !== undefined) && (
            <p className="kd-start-quiet-note" role="status" aria-live="polite">
              {starting ? 'Starting the meeting… waiting for the room to confirm.' : startError}
            </p>
          )}
          <div className="kd-start-actions">
            <button
              type="button"
              className="kd-chip"
              style={{ padding: '10px 14px', fontWeight: 600 }}
              onClick={() => {
                if (spotlightStop === 'dock') setSpotlightStop('stage');
                else setStepIndex(1);
              }}
            >
              ← Back
            </button>
            {spotlightStop === 'stage' ? (
              <>
                <button
                  type="button"
                  className="kd-go"
                  style={{ marginTop: 0, flex: 1 }}
                  onClick={() => setSpotlightStop('dock')}
                  autoFocus
                >
                  Next: Spotlight Kaki Wingman →
                </button>
                <button
                  type="button"
                  className="kd-skip-link"
                  onClick={onStart}
                  disabled={starting}
                  aria-label="Start the meeting"
                >
                  {startError !== undefined ? 'Try again' : 'Skip tutorial →'}
                </button>
              </>
            ) : (
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
            )}
          </div>
        </div>
      </div>
    );
  }

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
              onClick={() => {
                setStepIndex(idx);
                if (idx === 2) setSpotlightStop('stage');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {stepIndex === 0 && (
          <div className="kd-story-step">
            <div className="kd-story-hero">
              <img
                src="/scenario/kopitiam-hero.svg"
                alt="Nanyang Kopi & Toast Raffles Place Flagship"
                className="kd-story-hero-img"
              />
              <div className="kd-story-hero-overlay">
                <span className="kd-story-badge">
                  {scenario?.organisation ?? 'Nanyang Kopi & Toast'} · Opening day
                </span>
                <h2>{scenario?.meetingTitle ?? 'Raffles Place Flagship Opening Day'}</h2>
              </div>
            </div>

            <div className="kd-story-role-box">
              <p className="kd-role-eyebrow" style={{ marginBottom: 4 }}>
                Step 1 of 3 · Your briefing
              </p>
              <p className="kd-story-shop-intro">
                Our renovated <strong>Nanyang Kopi &amp; Toast</strong> flagship at <strong>Raffles Place</strong> is opening this morning. We have {totalMinutes} minutes to settle {topicCount} opening-day calls, and you’re opening-day lead, so the calls are yours.
              </p>
              {role !== undefined && card !== undefined ? (
                <div className="kd-story-seat-summary">
                  <p className="kd-story-role-headline">
                    <strong>🪑 {youAre}</strong>
                  </p>
                  <p className="kd-story-role-resp" style={{ marginBottom: 0 }}>
                    <span>Your goal: </span>
                    {card.responsibility}
                  </p>
                </div>
              ) : (
                <p style={{ margin: 0 }}>
                  Your role card and store facts are in Kaki Wingman on the right.
                </p>
              )}
            </div>
          </div>
        )}

        {stepIndex === 1 && (
          <div className="kd-story-step">
            <p className="kd-role-eyebrow" style={{ marginBottom: 4 }}>
              Step 2 of 3 · On the agenda today
            </p>
            <h2 style={{ marginBottom: 4 }}>Today’s {topicCount} Topics</h2>
            <p style={{ marginBottom: 10 }}>
              We have {totalMinutes} minutes to hear the team out and settle these calls:
            </p>
            {agendaItems.length > 0 ? (
              <div className="kd-crisis-grid">
                {agendaItems.map((item, idx) => {
                  const art = item.art ?? HERO_ART;
                  const owner = scenario ? roleLabel(scenario, item.ownerRole) : item.ownerRole;
                  const isYours = role !== undefined && item.ownerRole === role.id;
                  return (
                    <article key={item.title} className="kd-crisis-card" data-yours={isYours}>
                      <img src={art} alt={item.title} className="kd-crisis-img" />
                      <div className="kd-crisis-body">
                        <div className="kd-crisis-meta">
                          <span className="kd-crisis-pill">Item {idx + 1} · {item.minutes}m</span>
                          <span className="kd-crisis-owner">
                            {isYours ? '★ Your Topic to Lead' : `Led by ${owner}`}
                          </span>
                        </div>
                        <h3>{item.title}</h3>
                        <p>{item.briefing ?? item.decision ?? item.title}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p>
                On each agenda item, Kaki Wingman highlights the exact decision on the table and your key numbers at the top of the Kaki panel.
              </p>
            )}
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
          {stepIndex > 0 && (
            <button
              type="button"
              className="kd-chip"
              style={{ padding: '10px 14px', fontWeight: 600 }}
              onClick={() => setStepIndex((prev) => Math.max(0, prev - 1))}
            >
              ← Back
            </button>
          )}
          <button
            type="button"
            className="kd-go"
            style={{ marginTop: 0, flex: 1 }}
            onClick={() => {
              if (stepIndex === 0) setStepIndex(1);
              else {
                setSpotlightStop('stage');
                setStepIndex(2);
              }
            }}
            autoFocus
          >
            {stepIndex === 0 ? `Next: Today’s ${topicCount} Topics →` : 'Next: Live Room Spotlight →'}
          </button>
          <button
            type="button"
            className="kd-skip-link"
            onClick={onStart}
            disabled={starting}
            aria-label="Start the meeting"
          >
            {startError !== undefined ? 'Try again' : 'Skip tutorial →'}
          </button>
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
    const message: ControlMessage = { kind: 'start', ...pending };
    room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
      .catch(() => undefined);
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
      started.current = true;
      stopTimers();
      request.current = undefined;
      setPhase('idle');
      onStarted();
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, scenario, onStarted, stopTimers]);

  useEffect(() => () => stopTimers(), [stopTimers]);

  const start = useCallback(() => {
    if (request.current !== undefined) return;
    if (scenario === undefined) {
      setError('The meeting is not ready yet. Wait a moment and try again.');
      setPhase('failed');
      return;
    }
    const session = room.localParticipant?.identity;
    if (session === undefined || session.length === 0) {
      setError('The meeting is not connected yet. Wait a moment and try again.');
      setPhase('failed');
      return;
    }
    started.current = false;
    request.current = {
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      session,
    };
    setError(undefined);
    setPhase('waiting');
    publish();
    retryTimer.current = setInterval(publish, START_RETRY_MS);
    timeoutTimer.current = setTimeout(() => {
      stopTimers();
      request.current = undefined;
      const npcs = scenario?.npcs ?? [];
      const listener = scenario === undefined ? undefined : aiCast(scenario)[0] ?? npcs.find((npc) => npc.role === 'host') ?? npcs[0];
      const remoteParticipants = (room as { remoteParticipants?: Map<string, { identity: string }> }).remoteParticipants;
      const listenerPresent =
        listener === undefined ||
        remoteParticipants === undefined ||
        [...remoteParticipants.values()].some((p) => p.identity === listener.attendee);
      setPhase('failed');
      setError(
        listenerPresent
          ? 'The room did not confirm the start. Check your connection, then try again.'
          : 'Waiting for the AI attendees to join the room (run npm run npc or bash scripts/live-up.sh), then try again.',
      );
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
