import { useEffect, useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { ActiveRoleCards } from '../phone/PhonePage';
import type { TranscriptViewer } from './captions';
import { MeetingPanel } from './MeetingPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { RoleCard } from './RoleCard';
import { SituationCard } from './SituationCard';
import { useScenario } from '../kaki';
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
}: {
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
  meetingCode?: string;
  started?: boolean;
  sharedAudience?: 'screen' | 'participant';
  /** A practice meeting keeps the pack's host story; a team meeting briefs on its own plan. */
  practice?: boolean;
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
        <details
          className="kd-briefing"
          open={briefingOpen}
          onToggle={(event) => setBriefingOpen(event.currentTarget.open)}
        >
          <summary className="kd-briefing-summary">
            <span>Briefing · {role === undefined ? scenario.meetingTitle : `Your role (${role.label}) & the situation`}</span>
            <span className="kd-briefing-toggle">{briefingOpen ? 'Hide' : 'Show'}</span>
          </summary>
          <RoleCard role={role} viewerName={viewer.name} seatName={viewer.seatName} agenda={scenario.agenda} />
          <SituationCard scenario={scenario} viewerName={viewer.name} viewerRoleId={role?.id} />
        </details>
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
          />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
