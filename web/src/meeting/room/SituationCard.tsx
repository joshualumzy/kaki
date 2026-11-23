import { roleLabel, type Scenario } from '@kaki/shared';
import './practice.css';

/** What the meeting is about and who is in the room, shown from the moment a person joins. */
export function SituationCard({
  scenario,
  viewerName,
  viewerRoleId,
}: {
  scenario: Scenario;
  viewerName?: string;
  viewerRoleId?: string;
}) {
  if (scenario.situation === undefined) return null;
  const lines = scenario.situation.split('\n').filter((line) => line.trim().length > 0);
  const trimmedName = viewerName?.trim();
  const agendaWords = scenario.agenda
    .flatMap((item) => `${item.title} ${item.decision ?? ''}`.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
    .filter((word) => !['friday', 'breakfast', 'promo', 'launch', 'morning', 'today', 'should'].includes(word));
  const visibleLines = lines.filter((line, index) => {
    if (index === 0 || agendaWords.length === 0 || !/^\(\d+\)/.test(line.trim())) return true;
    const lower = line.toLowerCase();
    return agendaWords.some((word) => lower.includes(word));
  });
  return (
    <section className="kd-role" aria-label="The situation">
      <p className="kd-role-eyebrow">The situation · {scenario.meetingTitle}</p>
      {visibleLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p style={{ fontWeight: 600, marginBottom: 4 }}>In the room</p>
      <ul>
        {scenario.attendees.map((attendee) => {
          const isViewer = viewerRoleId !== undefined && attendee.role === viewerRoleId && trimmedName !== undefined && trimmedName.length > 0;
          const displayName = isViewer ? `${trimmedName} (you)` : attendee.name;
          return (
            <li key={attendee.name}>
              {displayName}, {roleLabel(scenario, attendee.role)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
