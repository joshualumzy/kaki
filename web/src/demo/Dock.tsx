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
}: {
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
  meetingCode?: string;
  started?: boolean;
}) {
  const scenario = useScenario();
  const [briefingOpen, setBriefingOpen] = useState(false);

  useEffect(() => {
    if (started) setBriefingOpen(false);
  }, [started]);

  return (
    <aside className="kd-dock" aria-label="Kaki assistant">
      <div className="kd-dock-head">
        <div className="kd-dock-sub">
          <b>Kaki</b>
          <span>
            {role === undefined
              ? scenario.meetingTitle
              : `${viewer.name} (${role.label}) · Live transcript, tasks & context`}
          </span>
        </div>
      </div>
      {meetingCode !== undefined && (
        <p className="kd-code" aria-label="Meeting code">
          Meeting code <b>{meetingCode}</b>
          <span>
            To add someone on another device, open {window.location.origin}/demo?code={meetingCode}
          </span>
        </p>
      )}
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
          <RoleCard role={role} viewerName={viewer.name} seatName={viewer.seatName} />
          <SituationCard scenario={scenario} viewerName={viewer.name} viewerRoleId={role?.id} />
        </details>
        <ErrorBoundary>{role !== undefined && <ActiveRoleCards role={role.id} viewer={viewer} />}</ErrorBoundary>
        <ErrorBoundary>
          <MeetingPanel viewer={viewer} role={role} isHost={role?.facilitator === true} />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
