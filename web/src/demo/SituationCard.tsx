import { roleLabel, type Scenario } from '@kaki/shared';
import './demo.css';

/** What the meeting is about and who is in the room, shown from the moment a person joins. */
export function SituationCard({ scenario }: { scenario: Scenario }) {
  if (scenario.situation === undefined) return null;
  return (
    <section className="kd-role" aria-label="The situation">
      <p className="kd-role-eyebrow">The situation · {scenario.meetingTitle}</p>
      <p>{scenario.situation}</p>
      <p style={{ fontWeight: 600, marginBottom: 4 }}>In the room</p>
      <ul>
        {scenario.attendees.map((attendee) => (
          <li key={attendee.name}>
            {attendee.name}, {roleLabel(scenario, attendee.role)}
          </li>
        ))}
      </ul>
    </section>
  );
}
