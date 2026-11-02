import type { ScenarioRole } from '@kaki/shared';
import './demo.css';

/** The short briefing for the role a person plays: who they are, what they know, what they answer for. Facts, not a script. */
export function RoleCard({ role }: { role: ScenarioRole | undefined }) {
  const card = role?.card;
  if (role === undefined || card === undefined) return null;

  return (
    <section className="kd-role" aria-label={`Your role: ${role.label}`}>
      <p className="kd-role-eyebrow">Your role · {role.label}</p>
      <p>{card.youAre}</p>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>What you know</p>
      <ul>
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
