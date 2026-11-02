import { useState, type CSSProperties } from 'react';
import type { ScenarioRole } from '@kaki/shared';
import { MediaPreview, type MediaChoice } from './MediaPreview';

/** What the name box starts with: people can change it to anything. */
export const DEFAULT_NAME = 'Guest';

const label: CSSProperties = {
  display: 'block',
  color: '#8fa3bf',
  fontSize: '11px',
  fontWeight: 600,
  marginBottom: '8px',
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
};

const field: CSSProperties = {
  width: '100%',
  padding: '13px 16px',
  backgroundColor: 'rgba(8, 14, 28, 0.7)',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '12px',
  color: '#f1f5f9',
  fontSize: '15px',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const css = `
.join-page { min-height: 100vh; box-sizing: border-box; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: radial-gradient(900px 500px at 15% 10%, rgba(34, 211, 238, 0.16), transparent 60%),
              radial-gradient(800px 500px at 90% 95%, rgba(139, 92, 246, 0.2), transparent 60%), #070b16;
  font-family: Inter, system-ui, -apple-system, sans-serif; }
.join-card { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 36px; width: 920px; max-width: 100%; box-sizing: border-box; padding: 32px;
  background: rgba(15, 23, 42, 0.62); backdrop-filter: blur(18px); border: 1px solid rgba(148, 163, 184, 0.16); border-radius: 24px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05); }
.join-field:focus { border-color: #22d3ee !important; box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.18); }
.join-go:not(:disabled):hover { filter: brightness(1.1); transform: translateY(-1px); }
.join-toggle:hover { filter: brightness(1.2); }
@media (max-width: 760px) { .join-card { grid-template-columns: 1fr; gap: 24px; padding: 22px; } }
`;

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
    <div className="join-page">
      <style>{css}</style>
      <form
        className="join-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onJoin(name.trim(), roleLabel, media);
        }}
      >
        <MediaPreview value={media} onChange={setMedia} onProblem={setProblem} />

        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
          <div style={{ color: '#22d3ee', fontSize: '11px', fontWeight: 600, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '10px' }}>
            Live meeting
          </div>
          <h1 style={{ color: '#f8fafc', margin: '0 0 6px 0', fontSize: '28px', fontWeight: 650, letterSpacing: '-0.02em' }}>Join meeting</h1>
          <p style={{ color: '#8fa3bf', margin: '0 0 28px 0', fontSize: '14px' }}>{meetingTitle}</p>

          <div style={{ marginBottom: '18px' }}>
            <label htmlFor="join-name" style={label}>
              Your name
            </label>
            <input
              id="join-name"
              className="join-field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              maxLength={60}
              style={field}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label htmlFor="join-role" style={label}>
              Your role
            </label>
            <select
              id="join-role"
              className="join-field"
              value={roleLabel}
              onChange={(event) => setRoleLabel(event.target.value)}
              style={{ ...field, appearance: 'none', cursor: 'pointer' }}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.label}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>

          {(problem ?? error) !== undefined && (
            <p role="alert" style={{ color: '#fca5a5', fontSize: '13px', margin: '0 0 14px 0' }}>
              {problem ?? error}
            </p>
          )}

          <button
            type="submit"
            className="join-go"
            disabled={!ready}
            style={{
              width: '100%',
              padding: '14px',
              background: ready ? 'linear-gradient(135deg, #06b6d4, #6366f1)' : 'rgba(51, 65, 85, 0.8)',
              color: ready ? 'white' : '#94a3b8',
              border: 'none',
              borderRadius: '12px',
              fontSize: '15px',
              fontWeight: 600,
              letterSpacing: '0.02em',
              cursor: ready ? 'pointer' : 'not-allowed',
              boxShadow: ready ? '0 10px 30px rgba(99, 102, 241, 0.35)' : 'none',
              transition: 'filter 120ms, transform 120ms',
            }}
          >
            {busy ? 'Joining…' : media.microphone ? 'Join' : 'Join to type'}
          </button>
          <p style={{ color: '#64748b', fontSize: '12px', margin: '14px 0 0 0', lineHeight: 1.5 }}>
            Headphones work best. With the microphone off you can type to the AI attendees.
          </p>
        </div>
      </form>
    </div>
  );
}
