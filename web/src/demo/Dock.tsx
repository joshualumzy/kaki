import { useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { PhoneFeed } from '../phone/PhonePage';
import { useKaki, useScenario } from '../kaki';
import { MeetingRecordCard, isRecord } from '../screen/ScreenPage';
import { ErrorBoundary } from './ErrorBoundary';
import { RoleCard } from './RoleCard';
import './demo.css';

type Tab = 'wingman' | 'host';

/** The Host's view of the meeting for everyone in the room: the agenda clock, open questions and who is quiet. */
function HostPanel() {
  const scenario = useScenario();
  const { events, connected } = useKaki('screen');
  const record = events.filter(isRecord).at(-1);
  return (
    <div className="page kd-host">
      {!connected && <p className="connection-banner">Reconnecting to the Host…</p>}
      {record === undefined ? (
        <p className="empty-state">The meeting has not started yet. The agenda clock begins with the first thing said.</p>
      ) : (
        <MeetingRecordCard record={record} scenario={scenario} />
      )}
    </div>
  );
}

/**
 * The side dock. Wingman is private to the person's role (tasks, nudges, answers from company records);
 * Host is what the meeting's facilitator tracks for the whole room.
 */
export function Dock({ role }: { role: ScenarioRole | undefined }) {
  const [tab, setTab] = useState<Tab>('wingman');
  const label = (name: Tab, text: string) => (
    <button type="button" role="tab" className="kd-tab" aria-selected={tab === name} onClick={() => setTab(name)}>
      <i />
      {text}
    </button>
  );

  return (
    <aside className="kd-dock" data-tab={tab} aria-label="Kaki assistants">
      <div className="kd-dock-head">
        <div className="kd-tabs" role="tablist">
          <span className="kd-tab-pill" />
          {label('wingman', 'Kaki Wingman')}
          {label('host', 'Kaki Host')}
        </div>
        <div className="kd-dock-sub">
          <b>{tab === 'wingman' ? 'Private' : 'Shared'}</b>
          <span>{tab === 'wingman' ? `Just for you${role === undefined ? '' : ` as ${role.label}`}` : 'What the room is tracking'}</span>
        </div>
      </div>
      <div className="kd-dock-body">
        <div hidden={tab !== 'wingman'}>
          <RoleCard role={role} />
          <ErrorBoundary>{role !== undefined && <PhoneFeed role={role.id} />}</ErrorBoundary>
        </div>
        <div hidden={tab !== 'host'}>
          <ErrorBoundary>
            <HostPanel />
          </ErrorBoundary>
        </div>
      </div>
    </aside>
  );
}
