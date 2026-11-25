import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgendaItem, Scenario, ScenarioRole } from '@kaki/shared';
import { useScenario } from '../../kaki';
import { meetingApiPath } from '../../kaki/meetingScope';
import { plainFailureMessage } from '../../net/plainFailure';
import './practice.css';

const COULD_NOT_START = "Couldn't start the meeting. Check your connection, then try again.";

interface StartPromptProps {
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

/** Render the briefing intro's `**bold**` runs without letting scenario text become markup. */
function introParts(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((part) => part.length > 0)
    .map((part, index) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={`intro-${index}`}>{part.slice(2, -2)}</strong>
        : part,
    );
}

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

  const heroArt = scenario?.practiceBriefing?.heroArt?.trim();

  useEffect(() => {
    if (typeof Image === 'undefined' || heroArt === undefined || heroArt === '') return;
    const img = new Image();
    img.src = heroArt;
  }, [heroArt]);

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
  const organisation = scenario?.organisation?.trim();
  const meetingTitle = scenario?.meetingTitle?.trim();
  const situation = scenario?.situation?.trim();
  const briefing = scenario?.practiceBriefing;
  const badge = briefing?.badge?.trim() ?? (organisation !== undefined && organisation !== '' ? organisation : undefined);
  const intro = briefing?.intro !== undefined
    ? briefing.intro.replace(/\{minutes\}/g, String(totalMinutes))
    : situation !== undefined && situation !== ''
      ? situation
      : `You are leading this meeting: ${topicCount} calls in ${totalMinutes} minutes.`;

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
              {heroArt !== undefined && heroArt !== '' && (
                <img src={heroArt} alt={meetingTitle ?? 'Meeting'} className="kd-story-hero-img" />
              )}
              <div className="kd-story-hero-overlay">
                {badge !== undefined && <span className="kd-story-badge">{badge}</span>}
                <h2>{meetingTitle ?? 'This meeting'}</h2>
              </div>
            </div>

            <div className="kd-story-role-box">
              <p className="kd-story-shop-intro">{introParts(intro)}</p>
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
                <b>Talk:</b> speak into your mic. Your colleagues hear you and answer out loud.
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
                className="kd-go kd-go-secondary kd-start-back"
                onClick={() => setStepIndex(0)}
              >
                ← Back
              </button>
              <button
                type="button"
                className="kd-go kd-start-go"
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

const START_TIMEOUT_MS = 8000;

/**
 * The start prompt wired to the meeting server. Start is one server-owned operation: the browser posts
 * it, the server marks the meeting started and tells every tab, and this button only waits for that
 * answer. A second Start is safe because the server treats it as a no-op.
 */
export function ConnectedStartPrompt({
  onStarted,
  role,
  viewerName,
  seatName,
  meetingId,
}: {
  onStarted(): void;
  role?: ScenarioRole;
  viewerName?: string;
  seatName?: string;
  /** The meeting this Start belongs to. */
  meetingId: string;
}) {
  const scenario = safeUseScenario();
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'failed'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    // StrictMode runs setup, cleanup, then setup again; the second setup must restore this flag
    // or a failed Start would return before showing its error and stay on "Starting..." forever.
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Start is one server-owned command, not a cancellable query: the room can confirm it (MEETING_STARTED)
      // and unmount this prompt before the POST's answer arrives. Aborting then reports ERR_ABORTED for a start
      // that actually happened, so let the request finish and ignore its answer. Its own deadline still fires,
      // and the handlers stay silent because request.current is cleared.
      request.current = undefined;
    };
  }, []);

  const start = useCallback(() => {
    if (request.current !== undefined) return;
    if (scenario === undefined) {
      setError('The meeting is not ready yet. Wait a moment and try again.');
      setPhase('failed');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setError(undefined);
    setPhase('waiting');
    const timer = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
    void fetch(meetingApiPath(meetingId, '/api/meeting/start'), { method: 'POST', signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown; message?: unknown; started?: unknown };
        if (request.current !== controller) return;
        if (!response.ok || body.started !== true) {
          request.current = undefined;
          if (!mounted.current) return;
          setPhase('failed');
          setError(plainFailureMessage(response.status, body.message ?? body.error));
          return;
        }
        request.current = undefined;
        if (!mounted.current) return;
        setPhase('idle');
        onStarted();
      })
      .catch((cause: unknown) => {
        if (request.current !== controller) return;
        request.current = undefined;
        if (!mounted.current) return;
        const timedOut = cause instanceof DOMException && cause.name === 'AbortError';
        if (!timedOut) console.error('kaki web: starting the meeting failed', cause);
        setPhase('failed');
        setError(
          timedOut
            ? 'The meeting server did not confirm the start. Check your connection, then try again.'
            : COULD_NOT_START,
        );
      })
      .finally(() => clearTimeout(timer));
  }, [scenario, onStarted, meetingId]);

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
