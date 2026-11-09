import { useState } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { MediaPreview, type MediaChoice } from './MediaPreview';
import './demo.css';

/** What the name box starts with: people can change it to anything. */
export const DEFAULT_NAME = 'Foo';

export interface JoinFormProps {
  meetingTitle: string;
  /** The roles a person can take: those no AI attendee plays. */
  roles: readonly ScenarioRole[];
  busy?: boolean;
  /** Why the last attempt failed, or why joining is impossible. */
  error?: string;
  /** Show the meeting code box: someone is already in the meeting, or the page was opened with a code. */
  askCode?: boolean;
  /** A code from the page's link, to fill the box with. */
  initialCode?: string;
  /** `media`: which devices to join with. Without the microphone a person types to the AI attendees. */
  onJoin(name: string, roleLabel: string, media: MediaChoice, meetingCode?: string): void;
}

function roleVisualMeta(role: ScenarioRole): { icon: string; tag: string } {
  if (role.facilitator === true) return { icon: '🎙️', tag: 'Host · Chair the meeting' };
  switch (role.id) {
    case 'producer':
      return { icon: '🏢', tag: '★ Recommended · Floor & Budget' };
    case 'lead_programmer':
      return { icon: '🖥️', tag: 'Kiosks, Printer & POS' };
    case 'game_designer':
      return { icon: '☕', tag: 'Kopi, Toast & Customer UX' };
    case 'marketing_lead':
      return { icon: '📱', tag: 'TikTok PR & Brand Buzz' };
    default:
      return { icon: '✨', tag: 'Team Lead' };
  }
}

/** The screen before the meeting: a name and a role, then a microphone. */
export function JoinForm({ meetingTitle, roles, busy = false, error, askCode = false, initialCode = '', onJoin }: JoinFormProps) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [roleLabel, setRoleLabel] = useState(roles[0]?.label ?? '');
  const [media, setMedia] = useState<MediaChoice>({ microphone: true, camera: false });
  const [code, setCode] = useState(initialCode);
  const showCode = askCode || initialCode.length > 0;
  const [problem, setProblem] = useState<string | undefined>();
  const ready = name.trim().length > 0 && roleLabel.length > 0 && !busy && (!askCode || code.trim().length > 0);

  return (
    <div className="kd-join">
      <form
        className="kd-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            if (showCode && code.trim().length > 0) onJoin(name.trim(), roleLabel, media, code.trim());
            else onJoin(name.trim(), roleLabel, media);
          }
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

          <div style={{ marginBottom: '14px' }}>
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

          <div style={{ marginBottom: '18px' }}>
            <label htmlFor="join-role" className="kd-label">
              Choose your seat
            </label>
            <select
              id="join-role"
              aria-label="Your role"
              className="kd-field kd-role-select-sr"
              value={roleLabel}
              onChange={(event) => setRoleLabel(event.target.value)}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.label}>
                  {role.facilitator === true ? `${role.label} · run the meeting` : role.label}
                </option>
              ))}
            </select>

            {roles.length > 0 && (
              <div className="kd-seat-picker" role="radiogroup" aria-label="Pick your seat">
                {roles.map((role) => {
                  const selected = role.label === roleLabel;
                  const meta = roleVisualMeta(role);
                  return (
                    <button
                      key={role.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className="kd-seat-option"
                      data-selected={selected}
                      onClick={() => setRoleLabel(role.label)}
                    >
                      <span className="kd-seat-icon" aria-hidden="true">{meta.icon}</span>
                      <span className="kd-seat-text">
                        <b>{role.label}</b>
                        <small>{meta.tag}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {(() => {
              const selectedRole = roles.find((role) => role.label === roleLabel);
              const responsibility = selectedRole?.card?.responsibility;
              if (responsibility === undefined) return null;
              return (
                <p className="kd-hint" style={{ marginTop: '8px', fontWeight: 600 }}>
                  {responsibility}
                </p>
              );
            })()}
          </div>

          {showCode && (
            <div style={{ marginBottom: '18px' }}>
              <label htmlFor="join-code" className="kd-label">
                Meeting code
              </label>
              <input
                id="join-code"
                className="kd-field"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="From the person in the meeting"
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
            {busy ? 'Joining…' : media.microphone ? 'Join' : 'Join to type'}
          </button>
          <p className="kd-hint">Headphones work best. With the microphone off you can type to the AI attendees.</p>
        </div>
      </form>

      {(() => {
        const host = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : 'localhost';
        return (
          <nav className="kd-join-systems" aria-label="Company systems">
            <span className="kd-join-systems-label">Company systems (login: <code>demo</code> / <code>demo</code>):</span>
            <a href={`http://${host}:8081/en/home`} target="_blank" rel="noreferrer">Wiki</a>
            <a href={`http://${host}:8082/kopitiam/kopitiam-pos/issues`} target="_blank" rel="noreferrer">Gitea</a>
            <a href={`http://${host}:8083/kopitiam/channels/kopitiam-launch`} target="_blank" rel="noreferrer">Mattermost</a>
            <a href={`http://${host}:8084`} target="_blank" rel="noreferrer">Mailpit</a>
            <a href={`http://${host}:5232/user/calendar/`} target="_blank" rel="noreferrer">Calendar</a>
            <a href="/poster.pdf" target="_blank" rel="noreferrer">STePS Poster</a>
          </nav>
        );
      })()}
    </div>
  );
}
