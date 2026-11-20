import { roleLabel, type Scenario } from '@kaki/shared';

/**
 * What the person hosting is told before they start. A practice meeting keeps the pack's story and
 * the character who hosts it; a real team meeting is briefed only on its own title, people and
 * agenda, never on the demo pack's.
 */
export function HostBrief({ scenario, practice }: { scenario: Scenario; practice: boolean }) {
  if (!practice) {
    return (
      <section className="kd-role" aria-label="Your briefing as host">
        <p className="kd-role-eyebrow">You are hosting · {scenario.meetingTitle}</p>
        {scenario.attendees.length > 0 && (
          <>
            <p>In this meeting:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {scenario.attendees.map((attendee) => (
                <li key={attendee.name}>
                  {attendee.name} · {roleLabel(scenario, attendee.role)}
                </li>
              ))}
            </ul>
          </>
        )}
        <p>Agenda:</p>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {scenario.agenda.map((item) => (
            <li key={item.title}>
              {item.title} · {item.minutes} min · {roleLabel(scenario, item.ownerRole)}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const brief = scenario.hostBrief;
  const host = (scenario.npcs ?? []).find((npc) => npc.role === 'host');
  const goal = brief?.goal ?? host?.agenda;
  if (goal === undefined) return null;
  return (
    <section className="kd-role" aria-label="Your briefing as host">
      <p className="kd-role-eyebrow">You are hosting · {scenario.meetingTitle}</p>
      <p>{goal}</p>
      {brief !== undefined && (
        <p>
          <strong>The decision to land: </strong>
          {brief.decision}
        </p>
      )}
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {scenario.agenda.map((item) => (
          <li key={item.title}>
            {item.title} · {item.minutes} min · {roleLabel(scenario, item.ownerRole)}
          </li>
        ))}
      </ol>
    </section>
  );
}
