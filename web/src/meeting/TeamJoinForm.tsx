import { useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { MediaPreview, type MediaChoice } from '../demo/MediaPreview';
import '../demo/demo.css';

export interface TeamJoinFormProps {
  meetingTitle: string;
  /** The meeting's person seats only. */
  roles: readonly ScenarioRole[];
  busy?: boolean;
  error?: string;
  /** The code from the invite link; the owner joins without one. */
  initialCode?: string;
  /** The owner is joining their own room, so there is no code box. */
  owner?: boolean;
  onJoin(name: string, roleId: string, media: MediaChoice, meetingCode?: string): void;
}

/** The plain join card for a team meeting: name, seat, microphone, and the invite code. */
export function TeamJoinForm({
  meetingTitle,
  roles,
  busy = false,
  error,
  initialCode = '',
  owner = false,
  onJoin,
}: TeamJoinFormProps) {
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [media, setMedia] = useState<MediaChoice>({ microphone: false, camera: false });
  const [code, setCode] = useState(initialCode);
  const [problem, setProblem] = useState<string | undefined>();
  const ready = name.trim().length > 0 && roleId.length > 0 && !busy;

  return (
    <div className="kd-join">
      <form
        className="kd-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const trimmed = code.trim();
          onJoin(name.trim(), roleId, media, trimmed === '' ? undefined : trimmed);
        }}
      >
        <MediaPreview name={name} value={media} onChange={setMedia} onProblem={setProblem} />

        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
          <div className="kd-live">
            <span className="kd-dot" />
            {owner ? 'Owner' : 'Team meeting'}
          </div>
          <h1 className="kd-title">{owner ? 'Open your meeting room' : 'Join the meeting'}</h1>
          <p className="kd-sub">{meetingTitle}</p>

          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="team-join-name" className="kd-label">
              Your name
            </label>
            <input
              id="team-join-name"
              className="kd-field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              maxLength={60}
              autoFocus={typeof window === 'undefined' || window.innerWidth > 700}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>

          <div style={{ marginBottom: '18px' }}>
            <label htmlFor="team-join-seat" className="kd-label">
              Your seat
            </label>
            <select
              id="team-join-seat"
              className="kd-field"
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>

          {owner ? null : (
            <div style={{ marginBottom: '18px' }}>
              <label htmlFor="team-join-code" className="kd-label">
                Meeting code
              </label>
              <input
                id="team-join-code"
                className="kd-field"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="From the invite"
                maxLength={8}
                autoCapitalize="characters"
                autoComplete="off"
              />
            </div>
          )}

          {(problem ?? error) !== undefined && (
            <p role="alert" className="kd-alert">
              {problem ?? error}
            </p>
          )}

          <button type="submit" className="kd-go" disabled={!ready}>
            {busy
              ? 'Joining…'
              : owner
                ? media.microphone
                  ? 'Join the meeting room with mic'
                  : 'Join the meeting room'
                : media.microphone
                  ? 'Join with mic'
                  : 'Join to type'}
          </button>
          <p className="kd-hint">
            Headphones work best. Tap the microphone to speak; the meeting starts when the owner starts it.
          </p>
        </div>
      </form>
    </div>
  );
}
