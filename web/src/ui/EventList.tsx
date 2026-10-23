import type { KakiEvent } from '@kaki/shared';
import { Card } from './Card';
import { summarizeEvent } from './summarizeEvent';

/** Event list shared by the screen and phone shells until feature UI replaces it. */
export function EventList({ events }: { events: KakiEvent[] }) {
  if (events.length === 0) {
    return <p className="empty-state">No events yet.</p>;
  }

  return (
    <ul className="event-list">
      {events.map((event, index) => (
        <li key={`${event.type}-${index}`}>
          <Card>
            <p className="event-type">{event.type}</p>
            <p className="event-summary">{summarizeEvent(event)}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
