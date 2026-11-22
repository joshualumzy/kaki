import { roleLabel, type Scenario } from '@kaki/shared';

/** Live cue card for a visitor playing the Host seat so they know who to call on and what to land on each agenda item. */
export function HostCueCard({
  scenario,
  agendaIndex,
  started,
  canAdvance = false,
}: {
  scenario: Scenario;
  agendaIndex: number;
  started: boolean;
  /** Whether this visitor actually has the Next agenda item control the tip below points at. */
  canAdvance?: boolean;
}) {
  const item = scenario.agenda[agendaIndex] ?? scenario.agenda[0];
  if (item === undefined) return null;
  const ownerAttendee = scenario.attendees.find((a) => a.role === item.ownerRole)?.name ?? roleLabel(scenario, item.ownerRole);
  const coHostRole =
    scenario.roles.find((role) => role.id === 'operations_director' && role.id !== item.ownerRole) ??
    scenario.roles.find((role) => role.id !== item.ownerRole && role.facilitator !== true);
  const coHostName =
    coHostRole === undefined
      ? undefined
      : scenario.attendees.find((a) => a.role === coHostRole.id)?.name ?? roleLabel(scenario, coHostRole.id);
  return (
    <section className="kd-role kd-topic-card" aria-label="Host cue card">
      <p className="kd-role-eyebrow">Kaki Wingman · Host Cue Card (Item {agendaIndex + 1} of {scenario.agenda.length})</p>
      <p style={{ marginBottom: 6 }}>
        <strong>{started ? `Now chairing: ${item.title}` : `How to kick off Item 1: ${item.title}`}</strong>
      </p>
      <p style={{ marginBottom: 6 }}>
        Try saying: <em>&ldquo;Hey team, let&rsquo;s start with {item.title}. {ownerAttendee}, can you walk us through it?&rdquo;</em>
      </p>
      {coHostRole === undefined || coHostName === undefined ? null : (
        <small style={{ display: 'block', opacity: 0.85 }}>
          Tip: {coHostName} ({roleLabel(scenario, coHostRole.id)}) will help co-host if the room goes quiet
          {canAdvance ? ', or you can click ' : '.'}
          {canAdvance && (
            <>
              <b>Next agenda item</b> above anytime.
            </>
          )}
        </small>
      )}
    </section>
  );
}
