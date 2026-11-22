import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MeetingScopeProvider, ScenarioProvider } from '../kaki';
import Meeting from '../meeting/room/Meeting';
import { getMeetingInfo, type MeetingInfo } from './api';
import { EndedMeetingCard } from './EndedMeetingCard';
import './product.css';

/** The real meeting room: its own scenario, its own websocket and its own LiveKit room. */
export function RealMeetingRoom() {
  const { id = '' } = useParams();
  const [info, setInfo] = useState<MeetingInfo | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    getMeetingInfo(id)
      .then((meeting) => {
        if (!cancelled) setInfo(meeting);
      })
      .catch(() => {
        // A failed info check must not keep anyone out of a live room.
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (info === undefined) {
    return (
      <main className="page product-page product-page-narrow">
        <p className="empty-state" role="status">
          Checking this meeting…
        </p>
      </main>
    );
  }

  if (info !== null && info.status === 'ended') {
    return (
      <main className="page product-page product-page-narrow">
        <EndedMeetingCard
          meetingId={id}
          meetingTitle={info.title}
          historyWorkspaceId={info.historyWorkspaceId ?? null}
        />
      </main>
    );
  }

  return (
    <MeetingScopeProvider meetingId={id}>
      <ScenarioProvider view="meeting" meetingId={id}>
        <Meeting variant="real" meetingId={id} />
      </ScenarioProvider>
    </MeetingScopeProvider>
  );
}
