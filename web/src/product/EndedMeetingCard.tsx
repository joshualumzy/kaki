import { Link } from 'react-router-dom';
import { Card } from '../ui';

/** A link to a meeting that is over: say so plainly and point the right people at the minutes. */
export function EndedMeetingCard({
  meetingId,
  meetingTitle,
  historyWorkspaceId,
}: {
  meetingId: string;
  meetingTitle: string;
  historyWorkspaceId: string | null;
}) {
  return (
    <Card title="This meeting has ended">
      <p className="product-hint">{meetingTitle}</p>
      {historyWorkspaceId === null ? (
        <p className="product-hint">Ask the meeting owner for the minutes.</p>
      ) : (
        <Link
          className="product-open"
          to={`/workspaces/${encodeURIComponent(historyWorkspaceId)}/meetings/${encodeURIComponent(meetingId)}`}
        >
          Read the meeting notes
        </Link>
      )}
      <Link className="product-open" to="/">
        Go to Kaki
      </Link>
    </Card>
  );
}
