import { useState, type CSSProperties } from 'react';
import type { ScenarioRole } from '@kaki/shared';

const label: CSSProperties = {
  display: 'block',
  color: '#cbd5e1',
  fontSize: '12px',
  fontWeight: 500,
  marginBottom: '8px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const field: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  backgroundColor: '#0f172a',
  border: '1px solid #334155',
  borderRadius: '8px',
  color: 'white',
  fontSize: '16px',
  outline: 'none',
  boxSizing: 'border-box',
};

export interface JoinFormProps {
  meetingTitle: string;
  /** The roles a person can take: those no AI attendee plays. */
  roles: readonly ScenarioRole[];
  busy?: boolean;
  /** Why the last attempt failed, or why joining is impossible. */
  error?: string;
  onJoin(name: string, roleLabel: string): void;
}

/** The screen before the meeting: a name and a role, then a microphone. */
export function JoinForm({ meetingTitle, roles, busy = false, error, onJoin }: JoinFormProps) {
  const [name, setName] = useState('');
  const [roleLabel, setRoleLabel] = useState(roles[0]?.label ?? '');
  const ready = name.trim().length > 0 && roleLabel.length > 0 && !busy;

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0f172a',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onJoin(name.trim(), roleLabel);
        }}
        style={{ backgroundColor: '#1e293b', padding: '40px', borderRadius: '16px', width: '450px', maxWidth: '90vw' }}
      >
        <h1 style={{ color: 'white', margin: '0 0 8px 0', fontSize: '24px', fontWeight: 600 }}>Join meeting</h1>
        <p style={{ color: '#94a3b8', margin: '0 0 32px 0', fontSize: '14px' }}>{meetingTitle}</p>

        <div style={{ marginBottom: '24px' }}>
          <label htmlFor="join-name" style={label}>
            Your name
          </label>
          <input
            id="join-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Josh"
            maxLength={60}
            style={field}
            autoFocus
          />
        </div>

        <div style={{ marginBottom: '32px' }}>
          <label htmlFor="join-role" style={label}>
            Your role
          </label>
          <select
            id="join-role"
            value={roleLabel}
            onChange={(event) => setRoleLabel(event.target.value)}
            style={{ ...field, appearance: 'none' }}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.label}>
                {role.label}
              </option>
            ))}
          </select>
        </div>

        {error !== undefined && (
          <p role="alert" style={{ color: '#fca5a5', fontSize: '14px', margin: '0 0 16px 0' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!ready}
          style={{
            width: '100%',
            padding: '14px',
            backgroundColor: ready ? '#3b82f6' : '#334155',
            color: ready ? 'white' : '#94a3b8',
            border: 'none',
            borderRadius: '8px',
            fontSize: '16px',
            fontWeight: 600,
            cursor: ready ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Joining…' : 'Join with microphone'}
        </button>
        <p style={{ color: '#64748b', fontSize: '12px', margin: '16px 0 0 0' }}>
          Use headphones for the best experience, and Chrome or Edge for speech recognition.
        </p>
      </form>
    </div>
  );
}
