import type { ScenarioRole } from '@kaki/shared';

/** The short briefing for the role a person plays: who they are, what they know, what they answer for. Facts, not a script. */
export function RoleCard({ role }: { role: ScenarioRole | undefined }) {
  const card = role?.card;
  if (role === undefined || card === undefined) return null;

  return (
    <section
      aria-label={`Your role: ${role.label}`}
      style={{
        margin: '12px',
        padding: '14px 16px',
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '12px',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        lineHeight: 1.45,
        color: '#111827',
      }}
    >
      <p style={{ margin: '0 0 4px', fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6b7280' }}>
        Your role · {role.label}
      </p>
      <p style={{ margin: '0 0 8px' }}>{card.youAre}</p>
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>What you know</p>
      <ul style={{ margin: '0 0 8px', paddingLeft: '18px' }}>
        {card.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      <p style={{ margin: 0 }}>
        <strong>You answer for: </strong>
        {card.responsibility}
      </p>
    </section>
  );
}
