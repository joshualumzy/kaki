import type { AgendaItem, ScenarioRole } from '@kaki/shared';
import './demo.css';

/** The short briefing for the role a person plays: who they are, what they know, what they answer for. Facts, not a script. */
export function RoleCard({
  role,
  viewerName,
  seatName,
  agenda,
}: {
  role: ScenarioRole | undefined;
  viewerName?: string;
  seatName?: string;
  agenda?: readonly AgendaItem[];
}) {
  const card = role?.card;
  if (role === undefined || card === undefined) return null;
  const trimmedName = viewerName?.trim();
  const youAre =
    trimmedName !== undefined && trimmedName.length > 0 && seatName !== undefined && seatName.length > 0
      ? card.youAre.replace(seatName, trimmedName)
      : card.youAre;
  const facts = agenda?.flatMap((item) => item.seatFacts?.[role.id] === undefined ? [] : [item.seatFacts[role.id]!]) ?? [];

  return (
    <section className="kd-role" aria-label={`Your role: ${role.label}`}>
      <p className="kd-role-eyebrow">Your role · {role.label}</p>
      <p>{youAre}</p>
      {facts.length > 0 && <>
        <p style={{ fontWeight: 600, marginBottom: 4 }}>What you know</p>
        <ul>
          {facts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      </>}
      <p style={{ margin: 0 }}>
        <strong>You answer for: </strong>
        {card.responsibility}
      </p>
    </section>
  );
}
