import { useCallback, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { CONTROL_TOPIC, roleLabel, type AgendaItem, type ControlMessage, type Scenario, type ScenarioRole } from '@kaki/shared';
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
}

const STEP_LABELS = ['1. Story & Your Role', '2. Today’s 2 Topics', '3. Live Room Spotlight'] as const;

function crisisArtForTitle(title: string): { src: string; badge: string; summary: string } {
  const lower = title.toLowerCase();
  if (lower.includes('chope') || lower.includes('seat') || lower.includes('laptop')) {
    return {
      src: '/scenario/crisis-seat-chope.svg',
      badge: 'Dine-in seating',
      summary: 'Solo breakfast customers are stuck holding hot egg trays because office workers leave tissue packets on tables and laptop users camp at the booths all morning.',
    };
  }
  if (lower.includes('cashless') || lower.includes('cash') || lower.includes('uncle') || lower.includes('elderly')) {
    return {
      src: '/scenario/crisis-cashless-uncles.svg',
      badge: 'Counter payments',
      summary: 'We went PayNow-only at the counter, and our retired morning regulars are walking out angry with $2 notes in hand.',
    };
  }
  if (lower.includes('butter') || lower.includes('tiktok') || lower.includes('zack')) {
    return {
      src: '/scenario/crisis-butter-slice.svg',
      badge: 'Food review',
      summary: 'Food TikToker @MakanWithZack posted a 90,000-view video claiming our Kaya Butter Toast has half as much cold butter as Ya Kun.',
    };
  }
  if (lower.includes('kiosk') || lower.includes('kopi') || lower.includes('lingo')) {
    return {
      src: '/scenario/crisis-kiosk-lingo.svg',
      badge: 'Kiosk menu',
      summary: 'Newcomers keep freezing at the kiosk screen because they do not know what "Kopi O Kosong" or "Siew Dai" means.',
    };
  }
  if (lower.includes('grabfood') || lower.includes('grab') || lower.includes('walk-in')) {
    return {
      src: '/scenario/crisis-grab-flood.svg',
      badge: 'Delivery rush',
      summary: 'Walk-in regulars are waiting 20 minutes for toast while delivery riders crowd the pickup counter.',
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
export function StartPrompt({ onStart, role, viewerName, seatName }: StartPromptProps) {
  const scenario = safeUseScenario();
  const [stepIndex, setStepIndex] = useState(0);
  const [spotlightStop, setSpotlightStop] = useState<'stage' | 'dock'>('stage');

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
              1. Left: Stage &amp; Controls
            </button>
            <button
              type="button"
              className="kd-spotlight-tab"
              data-active={spotlightStop === 'dock'}
              onClick={() => setSpotlightStop('dock')}
            >
              2. Right: Kaki Wingman →
            </button>
          </div>

          {spotlightStop === 'stage' ? (
            <div className="kd-spotlight-body">
              <span className="kd-spotlight-eyebrow">Highlighting Left Side · Meeting Stage</span>
              <h3>Talking with the team</h3>
              <ul className="kd-spotlight-list">
                <li>
                  Your colleagues are on the tiles on the left, with live captions as they speak.
                </li>
                <li>
                  Talk on your mic, type in the bottom bar, or open a question idea when it is your turn.
                </li>
                <li>
                  Hit <b>Pause</b> (or <code>Esc</code>) anytime if you want the room to hold on for a second.
                </li>
              </ul>
            </div>
          ) : (
            <div className="kd-spotlight-body">
              <span className="kd-spotlight-eyebrow">Highlighting Right Side · Kaki Wingman Dock</span>
              <h3>Notes, shop records, and follow-up tasks</h3>
              <ul className="kd-spotlight-list">
                <li>
                  When someone brings up a kitchen rule, email, or ticket, Kaki pulls up the record here so you have the numbers in front of you.
                </li>
                <li>
                  When the team agrees on a follow-up task for your role, click <b>Let Kaki do it</b> to review and send the draft.
                </li>
              </ul>
            </div>
          )}

          <p className="kd-start-quiet-note" style={{ marginTop: 8 }}>
            Your colleagues are in the room, but they stay quiet until you start the meeting.
          </p>
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
                  aria-label="Start the meeting"
                >
                  Skip tutorial →
                </button>
              </>
            ) : (
              <button
                type="button"
                className="kd-go"
                style={{ marginTop: 0, flex: 1 }}
                onClick={onStart}
                autoFocus
                aria-label="Start the meeting"
              >
                Start the meeting
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
            aria-label="Start the meeting"
          >
            Skip tutorial →
          </button>
        </div>
      </div>
    </div>
  );
}

/** The start prompt wired to the LiveKit room it is in. */
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
  const start = useCallback(() => {
    const message: ControlMessage = { kind: 'start' };
    room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CONTROL_TOPIC })
      .catch(() => undefined);
    onStarted();
  }, [room, onStarted]);
  return <StartPrompt onStart={start} role={role} viewerName={viewerName} seatName={seatName} />;
}
