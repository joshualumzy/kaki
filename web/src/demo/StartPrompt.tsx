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

const STEP_LABELS = ['1. Story & Your Role', '2. Today’s 2 Topics', '3. Live Room Spotlight'] as const;

const PRELOAD_SVGS = [
  '/scenario/kopitiam-hero.svg',
  '/scenario/crisis-seat-chope.svg',
  '/scenario/crisis-sfa-salmonella.svg',
  '/scenario/crisis-delivery-squeeze.svg',
  '/scenario/crisis-kiosk-lingo.svg',
] as const;

function crisisArtForTitle(title: string): { src: string; badge: string; summary: string } {
  const lower = title.toLowerCase();
  if (lower.includes('chope') || lower.includes('seat') || lower.includes('laptop')) {
    return {
      src: '/scenario/crisis-seat-chope.svg',
      badge: 'Dine-in seating',
      summary: 'Solo breakfast customers are stuck holding hot trays because office workers leave tissue packets on tables and laptop users camp at the booths all morning.',
    };
  }
  if (lower.includes('sfa') || lower.includes('salmonella') || lower.includes('safety') || lower.includes('inspection')) {
    return {
      src: '/scenario/crisis-sfa-salmonella.svg',
      badge: 'Food safety',
      summary: "A customer from yesterday's trial was hospitalized with suspected salmonella; Straits Times reporters arrive at 8:00 AM and SFA inspects our egg warmer at 9:00 AM.",
    };
  }
  if (lower.includes('commission') || lower.includes('delivery') || lower.includes('platform')) {
    return {
      src: '/scenario/crisis-delivery-squeeze.svg',
      badge: 'Delivery margins',
      summary: 'GrabFood and Foodpanda hiked fees to 32% (losing $0.40 per $10 set), but they bring in half of our nearby office breakfast orders.',
    };
  }
  if (lower.includes('kiosk') || lower.includes('kopi') || lower.includes('lingo')) {
    return {
      src: '/scenario/crisis-kiosk-lingo.svg',
      badge: 'Kiosk menu',
      summary: 'Newcomers keep freezing at the kiosk screen because they do not know what "Kopi O Kosong" or "Siew Dai" means.',
    };
  }
  return {
    src: '/scenario/kopitiam-hero.svg',
    badge: 'Agenda item',
    summary: title,
  };
}

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
    for (const src of PRELOAD_SVGS) {
      const img = new Image();
      img.src = src;
    }
  }, []);

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
            {STEP_LABELS.map((label, idx) => (
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
              <h3>Talking with the team</h3>
              <ul className="kd-spotlight-list">
                <li>
                  <b>1. Listen &amp; weigh in:</b> Your colleagues appear on the video tiles with live captions as they speak.
                </li>
                <li>
                  <b>2. Speak or type:</b> Talk on your mic, type in the bar, or tap a question idea when it is your turn.
                </li>
                <li>
                  <b>3. Pause anytime:</b> Hit <b>Pause</b> (or <code>Esc</code>) if you want the room to hold on for a second.
                </li>
              </ul>
            </div>
          ) : (
            <div className="kd-spotlight-body">
              <span className="kd-spotlight-eyebrow">Highlighting · Kaki Wingman Dock</span>
              <h3>Your 3-step game plan in Kaki</h3>
              <ul className="kd-spotlight-list">
                <li>
                  <b>1. Check live shop records:</b> When someone mentions a kitchen rule, email, or ticket, Kaki pulls up the exact numbers here.
                </li>
                <li>
                  <b>2. Accept your follow-up task:</b> When the team agrees on an action for your role, click <b>Let Kaki do it</b>.
                </li>
                <li>
                  <b>3. Review &amp; send:</b> Check Kaki’s draft and publish it straight to Gitea, Mattermost, Wiki, Mailpit, or Calendar.
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
          {STEP_LABELS.map((label, idx) => (
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
                  {scenario?.organisation ?? 'Nanyang Kopi & Toast'} · Tomorrow 8:00 AM Launch
                </span>
                <h2>{scenario?.meetingTitle ?? 'Raffles Place Flagship & App Promo Launch'}</h2>
              </div>
            </div>

            <div className="kd-story-role-box">
              <p className="kd-role-eyebrow" style={{ marginBottom: 6 }}>
                Step 1 of 3 · Welcome to the shop · Read your briefing first
              </p>
              <p className="kd-story-shop-intro">
                We run <strong>Nanyang Kopi &amp; Toast</strong>, a traditional Singapore coffee and kaya toast shop. Tomorrow at 8:00 AM we reopen our newly renovated <strong>Raffles Place outlet</strong> with self-order kiosks and a fresh floor layout, and the team is meeting now to sort out two headaches before doors open.
              </p>
              {role !== undefined && card !== undefined ? (
                <div className="kd-story-seat-summary">
                  <p className="kd-story-role-headline">
                    <strong>🪑 {youAre}</strong>
                  </p>
                  <p className="kd-story-role-resp" style={{ marginBottom: 0 }}>
                    <span>What you look after: </span>
                    {card.responsibility}
                  </p>
                </div>
              ) : (
                <p style={{ margin: 0 }}>
                  Your role card and the meeting situation are in the Kaki panel on the right. Take a quick look before starting.
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
            <h2 style={{ marginBottom: 4 }}>Today’s 2 Topics</h2>
            <p style={{ marginBottom: 10 }}>
              We have 8 minutes to hear the team out and settle these two calls:
            </p>
            {agendaItems.length > 0 ? (
              <div className="kd-crisis-grid">
                {agendaItems.map((item, idx) => {
                  const art = crisisArtForTitle(item.title);
                  const owner = scenario ? roleLabel(scenario, item.ownerRole) : item.ownerRole;
                  const isYours = role !== undefined && item.ownerRole === role.id;
                  return (
                    <article key={item.title} className="kd-crisis-card" data-yours={isYours}>
                      <img src={art.src} alt={item.title} className="kd-crisis-img" />
                      <div className="kd-crisis-body">
                        <div className="kd-crisis-meta">
                          <span className="kd-crisis-pill">Item {idx + 1} · {item.minutes}m</span>
                          <span className="kd-crisis-owner">
                            {isYours ? '★ Your Topic to Lead' : `Led by ${owner}`}
                          </span>
                        </div>
                        <h3>{item.title}</h3>
                        <p>{art.summary}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p>
                On each agenda item, Kaki Wingman highlights the exact decision on the table and your key numbers at the top of the right panel.
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
            {stepIndex === 0 ? 'Next: Today’s 2 Topics →' : 'Next: Live Room Spotlight →'}
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
