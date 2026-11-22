import { useParams } from 'react-router-dom';
import { MeetingScopeProvider, ScenarioProvider } from '../kaki';
import Meeting from '../meeting/room/Meeting';

/** The real meeting room: its own scenario, its own websocket and its own LiveKit room. */
export function RealMeetingRoom() {
  const { id = '' } = useParams();
  return (
    <MeetingScopeProvider meetingId={id}>
      <ScenarioProvider view="meeting" meetingId={id}>
        <Meeting variant="real" meetingId={id} />
      </ScenarioProvider>
    </MeetingScopeProvider>
  );
}
