import { useEffect, useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { ActiveRoleCards } from './ActiveRoleCards';
import type { TranscriptViewer } from './captions';
import { MeetingPanel } from './MeetingPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { RoleCard } from './RoleCard';
import { SituationCard } from './SituationCard';
import { useScenario } from '../../kaki';
import './demo.css';

/**
 * The unified side dock: shows the visitor's collapsible briefing, any active task or company-record lookup
 * for their role, the current agenda clock + topic cheat-sheet, the live transcript, and all meeting tasks
 * in one place without requiring tab switching.
 */
export function Dock({
  role,
  viewer,
  meetingCode,
  started = false,
  sharedAudience = 'screen',
  practice = false,
  real = false,
  signedIn = false,
  onNewPractice,
  onWingmanBadgeChange,
}: {
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
  meetingCode?: string;
  started?: boolean;
  sharedAudience?: 'screen' | 'participant';
  /** A practice meeting keeps the pack's host story; a team meeting briefs on its own plan. */
  practice?: boolean;
  /** A real meeting has no pack briefing and shows each person's own name, never a role label. */
  real?: boolean;
  /** True when this browser belongs to a signed-in account, so a practice can keep its minutes. */
  signedIn?: boolean;
  /** Asks the practice page for a fresh practice meeting once this one is over. */
  onNewPractice?: () => void;
  /** Reports the quiet Wingman note count for the room's Wingman badge. */
  onWingmanBadgeChange?(count: number): void;
}) {
  const scenario = useScenario();
  const [briefingOpen, setBriefingOpen] = useState(!started);

  useEffect(() => {
    if (started) setBriefingOpen(false);
  }, [started]);

  return (
    <aside className="kd-dock" aria-label="Kaki assistant">
      <div className="kd-dock-head">
        <div className="kd-dock-sub" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <b>Kaki</b>
            <span>
              {role === undefined
                ? scenario.meetingTitle
                : real
                  ? viewer.name
                  : `${viewer.name} (${role.label})`}
            </span>
          </span>
          {meetingCode !== undefined && (
            <span className="kd-code" aria-label="Meeting code" style={{ border: 0, padding: 0, fontSize: 11.5 }}>
              Code <b>{meetingCode}</b>
            </span>
          )}
        </div>
      </div>
      <div className="kd-dock-body">
        {!real && (
          <details
            className="kd-briefing"
            open={briefingOpen}
            onToggle={(event) => setBriefingOpen(event.currentTarget.open)}
          >
            <summary className="kd-briefing-summary">
              <span>Briefing · {role === undefined ? scenario.meetingTitle : `Your role (${role.label}) & the situation`}</span>
              <span className="kd-briefing-toggle">{briefingOpen ? 'Hide' : 'Show'}</span>
            </summary>
            <RoleCard role={role} viewerName={viewer.name} seatName={viewer.seatName} />
            <SituationCard scenario={scenario} viewerName={viewer.name} viewerRoleId={role?.id} />
          </details>
        )}
        <ErrorBoundary>
          {role !== undefined && (
            <ActiveRoleCards role={role.id} viewer={viewer} sharedAudience={sharedAudience} />
          )}
        </ErrorBoundary>
        <ErrorBoundary>
          <MeetingPanel
            viewer={viewer}
            role={role}
            isHost={role?.facilitator === true}
            started={started}
            sharedAudience={sharedAudience}
            practice={practice}
            real={real}
            signedIn={signedIn}
            {...(onNewPractice === undefined ? {} : { onNewPractice })}
            {...(onWingmanBadgeChange === undefined ? {} : { onWingmanBadgeChange })}
          />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
