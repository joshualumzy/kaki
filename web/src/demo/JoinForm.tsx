import { useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { MediaPreview, type MediaChoice } from './MediaPreview';
import './demo.css';

/** What the name box starts with: people can change it to anything. */
export const DEFAULT_NAME = 'Guest';

export interface JoinFormProps {
  meetingTitle: string;
  /** The roles a person can take: those no AI attendee plays. */
  roles: readonly ScenarioRole[];
  busy?: boolean;
  /** Why the last attempt failed, or why joining is impossible. */
  error?: string;
  /** `media`: which devices to join with. Without the microphone a person types to the AI attendees. */
  onJoin(name: string, roleLabel: string, media: MediaChoice): void;
}

/** The screen before the meeting: a name and a role, then a microphone. */
export function JoinForm({ meetingTitle, roles, busy = false, error, onJoin }: JoinFormProps) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [roleLabel, setRoleLabel] = useState(roles[0]?.label ?? '');
  const [media, setMedia] = useState<MediaChoice>({ microphone: true, camera: false });
  const [problem, setProblem] = useState<string | undefined>();
  const ready = name.trim().length > 0 && roleLabel.length > 0 && !busy;

  return (
    <div className="kd-join">
      <form
        className="kd-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onJoin(name.trim(), roleLabel, media);
        }}
      >
        <MediaPreview name={name} value={media} onChange={setMedia} onProblem={setProblem} />

        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
          <div className="kd-live">
            <span className="kd-dot" />
            Live meeting
          </div>
          <h1 className="kd-title">Join meeting</h1>
          <p className="kd-sub">{meetingTitle}</p>

          <div style={{ marginBottom: '18px' }}>
            <label htmlFor="join-name" className="kd-label">
              Your name
            </label>
            <input
              id="join-name"
              className="kd-field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              maxLength={60}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label htmlFor="join-role" className="kd-label">
              Your role
            </label>
            <select id="join-role" className="kd-field" value={roleLabel} onChange={(event) => setRoleLabel(event.target.value)}>
              {roles.map((role) => (
                <option key={role.id} value={role.label}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>

          {(problem ?? error) !== undefined && (
            <p role="alert" className="kd-alert">
              {problem ?? error}
            </p>
          )}

          <button type="submit" className="kd-go" disabled={!ready}>
            {busy ? 'Joining…' : media.microphone ? 'Join' : 'Join to type'}
          </button>
          <p className="kd-hint">Headphones work best. With the microphone off you can type to the AI attendees.</p>
        </div>
      </form>
    </div>
  );
}
