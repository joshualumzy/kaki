import { useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { PhoneFeed } from '../phone/PhonePage';
import type { TranscriptViewer } from './captions';
import { MeetingPanel } from './MeetingPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { RoleCard } from './RoleCard';
import './demo.css';

type Tab = 'wingman' | 'host';

/**
 * The side dock. Wingman is private to the person's role (tasks, nudges, answers from company records);
 * Host is what the meeting's facilitator tracks for the whole room.
 */
export function Dock({ role, viewer }: { role: ScenarioRole | undefined; viewer: TranscriptViewer }) {
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
          <span>{tab === 'wingman' ? `Just for you${role === undefined ? '' : ` as ${role.label}`}` : 'The agenda, what is said and the tasks'}</span>
        </div>
      </div>
      <div className="kd-dock-body">
        <div hidden={tab !== 'wingman'}>
          <RoleCard role={role} />
          <ErrorBoundary>{role !== undefined && <PhoneFeed role={role.id} />}</ErrorBoundary>
        </div>
        <div hidden={tab !== 'host'}>
          <ErrorBoundary>
            <MeetingPanel viewer={viewer} />
          </ErrorBoundary>
        </div>
      </div>
    </aside>
  );
}
